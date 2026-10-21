import { z } from 'zod';
import type { AccountType } from '@techlyup/contracts';
import { ApiError, type Env } from '../types';
import { database } from '../config';
import { hash } from '../auth/crypto';
import { accountRegistration, authenticate, rateLimit, type Identity } from '../auth/service';
import { jsonBody, success } from '../http';
import { handleLivePasscodeHttp } from './passcode';

/** Sign-in to TechlyUp LIVE with an app account: LIVE starts a PKCE challenge over its service binding,
 * the learner approves it on this origin, and LIVE redeems the one-use code with its verifier. */
export interface LiveLoginEnv extends Env { APP_LIVE_LOGIN_ENABLED?: string; LIVE_LOGIN_CLIENT_ID?: string; LIVE_LOGIN_APP_ORIGIN?: string; LIVE_LOGIN_CALLBACK_URL?: string }
export interface LiveLoginProps { clientId: string; product: 'techlyup'; tenantId: string }
export interface LiveLoginIdentity { accountId: string; email: string; name: string; emailVerified: boolean; accountType: AccountType | null }
const CHALLENGE_SECONDS = 300;
const loopback = (env: Env, url: URL) => ['test', 'development'].includes(env.APP_ENV ?? '') && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const unavailable = () => new ApiError('live_login_not_configured', 'Signing in to TechlyUp LIVE is not available yet.', 503);
function secureUrl(env: Env, value: string | undefined) {
  let url: URL; try { url = new URL(value ?? ''); } catch { throw unavailable(); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !loopback(env, url))) throw unavailable();
  return url;
}
export function liveLoginDatabase(env: LiveLoginEnv) {
  if (env.APP_ENABLED !== 'true' || env.APP_LIVE_LOGIN_ENABLED !== 'true' || !env.LIVE_LOGIN_CLIENT_ID || !env.TECHLYUP_ERP_ORG_ID) throw unavailable();
  const app = secureUrl(env, env.LIVE_LOGIN_APP_ORIGIN);
  if (app.origin !== env.LIVE_LOGIN_APP_ORIGIN || !(env.APP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).includes(app.origin)) throw unavailable();
  return { db: database(env), appOrigin: app.origin, callback: secureUrl(env, env.LIVE_LOGIN_CALLBACK_URL) };
}
// Caller scope comes only from operator-managed binding props, never from request input.
export function caller(env: LiveLoginEnv, props: LiveLoginProps | undefined) {
  const setup = liveLoginDatabase(env);
  if (props?.clientId !== env.LIVE_LOGIN_CLIENT_ID || props?.product !== 'techlyup' || props?.tenantId !== env.TECHLYUP_ERP_ORG_ID) throw new ApiError('live_login_caller_denied', 'This service binding is not authorized for TechlyUp LIVE sign-in.', 403);
  return { ...setup, client: props.clientId };
}
const pkceChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const now = () => new Date().toISOString();
const code = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
async function s256(verifier: string) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function beginLiveLogin(env: LiveLoginEnv, props: LiveLoginProps | undefined, raw: { pkceChallenge: string }) {
  const { db, appOrigin, client } = caller(env, props), input = z.object({ pkceChallenge }).strict().parse(raw);
  // LIVE rate-limits per visitor; this ceiling bounds the whole client if that fails.
  const recent = await db.prepare('SELECT COUNT(*) n FROM app_live_login_challenges WHERE client_id=? AND created_at>?').bind(client, new Date(Date.now() - 600000).toISOString()).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 600) throw new ApiError('rate_limited', 'Please wait before trying again.', 429);
  const id = crypto.randomUUID(), created = now(), expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000).toISOString();
  await db.prepare('INSERT INTO app_live_login_challenges(id,client_id,pkce_challenge,expires_at,created_at) VALUES(?,?,?,?,?)').bind(id, client, input.pkceChallenge, expiresAt, created).run();
  return { challengeId: id, expiresAt, authorizeUrl: `${appOrigin}/live/sign-in?challengeId=${id}` };
}

export async function authorizeLiveLogin(env: LiveLoginEnv, identity: Identity, challengeId: string) {
  const { db, callback } = liveLoginDatabase(env), at = now(), oneUse = code();
  const result = await db.prepare(`UPDATE app_live_login_challenges SET authorized_account_id=?,authorized_session_id=?,code_hash=?,authorized_at=?
    WHERE id=? AND client_id=? AND expires_at>? AND consumed_at IS NULL AND attempts<5 AND (authorized_account_id IS NULL OR authorized_account_id=?)`)
    .bind(identity.user.id, identity.sessionId, await hash(oneUse), at, challengeId, env.LIVE_LOGIN_CLIENT_ID!, at, identity.user.id).run();
  if (result.meta.changes !== 1) throw new ApiError('live_login_unavailable', 'This sign-in request expired or was already used. Start again from TechlyUp LIVE.', 409);
  // The destination is fixed configuration, so an approval can never send the code to another site.
  const redirect = new URL(callback);
  redirect.searchParams.set('challengeId', challengeId); redirect.searchParams.set('code', oneUse);
  return { redirectUrl: redirect.toString(), accountDisplay: identity.user.name };
}

export async function consumeLiveLogin(env: LiveLoginEnv, props: LiveLoginProps | undefined, raw: { challengeId: string; code: string; verifier: string }): Promise<LiveLoginIdentity> {
  const { db, client } = caller(env, props);
  const input = z.object({ challengeId: z.uuid(), code: z.string().regex(/^[a-f0-9]{64}$/), verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).strict().parse(raw);
  const at = now(), codeHash = await hash(input.code);
  const row = await db.prepare(`SELECT c.code_hash,c.pkce_challenge,a.id,a.email,a.name,a.email_verified,a.password_hash,s.password_fingerprint
    FROM app_live_login_challenges c JOIN learner_accounts a ON a.id=c.authorized_account_id JOIN app_sessions s ON s.id=c.authorized_session_id
    WHERE c.id=? AND c.client_id=? AND c.expires_at>? AND c.consumed_at IS NULL AND c.attempts<5 AND s.account_id=a.id AND s.revoked_at IS NULL AND s.expires_at>?`)
    .bind(input.challengeId, client, at, at).first<{ code_hash: string; pkce_challenge: string; id: string; email: string; name: string; email_verified: number; password_hash: string; password_fingerprint: string }>();
  const invalid = () => new ApiError('live_login_code_invalid', 'This sign-in code is invalid or expired. Start again from TechlyUp LIVE.', 409);
  if (!row || row.code_hash !== codeHash || row.pkce_challenge !== await s256(input.verifier) || row.password_fingerprint !== await hash(row.password_hash)) {
    await db.prepare('UPDATE app_live_login_challenges SET attempts=attempts+1 WHERE id=? AND client_id=? AND consumed_at IS NULL').bind(input.challengeId, client).run();
    throw invalid();
  }
  const used = await db.prepare('UPDATE app_live_login_challenges SET consumed_at=? WHERE id=? AND client_id=? AND consumed_at IS NULL AND code_hash=?').bind(at, input.challengeId, client, codeHash).run();
  if (used.meta.changes !== 1) throw invalid();
  const registration = await accountRegistration(db, row.id);
  return { accountId: row.id, email: row.email, name: row.name, emailVerified: row.email_verified === 1, accountType: registration?.accountType ?? null };
}

export async function handleLiveLoginHttp(request: Request, env: LiveLoginEnv, requestId: string, clientIp: string) {
  const passcode = await handleLivePasscodeHttp(request, env, requestId);
  if (passcode) return passcode;
  if (new URL(request.url).pathname !== '/api/v1/live/sign-in/authorize' || request.method !== 'POST') return null;
  const { db } = liveLoginDatabase(env);
  await rateLimit(db, 'live-login-authorize-ip', clientIp, 60);
  const identity = await authenticate(db, env.TECHLYUP_ERP_ORG_ID!, request.headers.get('authorization'));
  const input = z.object({ challengeId: z.uuid() }).strict().parse(await jsonBody(request));
  return success(await authorizeLiveLogin(env, identity, input.challengeId), requestId);
}
