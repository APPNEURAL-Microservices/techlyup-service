import { z } from 'zod';
import type { LivePasscode } from '@techlyup/contracts';
import { ApiError, type D1Database } from '../types';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/crypto';
import { accountRegistration, authenticate, rateLimit } from '../auth/service';
import { jsonBody, success } from '../http';
import { caller, liveLoginDatabase, type LiveLoginEnv, type LiveLoginIdentity, type LiveLoginProps } from './login';

/** Signing in on TechlyUp LIVE with a TechlyUp ID + permanent passcode created in the app, and with LIVE's own email code. */
// Unambiguous characters only (no 0/O, 1/I/L), as for referral codes, so IDs and passcodes survive being read aloud.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randomCode(length: number) {
  let value = '';
  // 248 = 8 × 31, so every accepted byte maps uniformly onto the alphabet.
  while (value.length < length) for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) if (byte < 248 && value.length < length) value += ALPHABET[byte % ALPHABET.length];
  return value;
}
const loginId = z.string().trim().toUpperCase().regex(/^TL[2-9A-HJKMNP-Z]{8}$/);
// People may type the passcode with or without its dashes, in any case.
const passcode = z.string().max(40).transform(value => value.replace(/[\s-]/g, '').toUpperCase()).pipe(z.string().regex(/^[2-9A-HJKMNP-Z]{12}$/));
const display = (value: string) => value.match(/.{4}/g)!.join('-');
const now = () => new Date().toISOString();
interface AccountRow { id: string; email: string; name: string; email_verified: number }

async function identityFor(db: D1Database, row: AccountRow): Promise<LiveLoginIdentity> {
  const registration = await accountRegistration(db, row.id);
  return { accountId: row.id, email: row.email, name: row.name, emailVerified: row.email_verified === 1, accountType: registration?.accountType ?? null };
}
async function passcodeStatus(db: D1Database, accountId: string): Promise<LivePasscode | null> {
  const row = await db.prepare('SELECT login_id,updated_at,last_used_at FROM app_live_passcodes WHERE account_id=?').bind(accountId).first<{ login_id: string; updated_at: string; last_used_at: string | null }>();
  return row ? { loginId: row.login_id, createdAt: row.updated_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}) } : null;
}
/** Creates or replaces the passcode. The plain value exists only in this response, and the old passcode stops working at once. */
async function createPasscode(db: D1Database, accountId: string): Promise<LivePasscode> {
  const secret = randomCode(12), hashed = await hashPassword(secret), at = now();
  const replaced = await db.prepare('UPDATE app_live_passcodes SET passcode_hash=?,updated_at=?,last_used_at=NULL WHERE account_id=? RETURNING login_id').bind(hashed, at, accountId).first<{ login_id: string }>();
  if (replaced) return { loginId: replaced.login_id, createdAt: at, passcode: display(secret) };
  for (let attempt = 1; ; attempt++) {
    const id = `TL${randomCode(8)}`;
    try {
      await db.prepare('INSERT INTO app_live_passcodes(account_id,login_id,passcode_hash,created_at,updated_at) VALUES(?,?,?,?,?)').bind(accountId, id, hashed, at, at).run();
      return { loginId: id, createdAt: at, passcode: display(secret) };
    } catch (error) {
      // A parallel request created this account's row first: replace its passcode instead.
      if (error instanceof Error && /UNIQUE constraint failed: app_live_passcodes.account_id/.test(error.message)) return createPasscode(db, accountId);
      if (attempt < 3 && error instanceof Error && /UNIQUE constraint failed: app_live_passcodes.login_id/.test(error.message)) continue;
      throw error;
    }
  }
}

export async function verifyLivePasscode(env: LiveLoginEnv, props: LiveLoginProps | undefined, raw: { loginId: string; passcode: string }): Promise<LiveLoginIdentity> {
  const { db } = caller(env, props), input = z.object({ loginId, passcode }).strict().parse(raw);
  // LIVE limits each visitor as well; this bounds guessing against one ID from every visitor together.
  await rateLimit(db, 'live-passcode', input.loginId, 10, 600);
  const row = await db.prepare('SELECT p.passcode_hash,a.id,a.email,a.name,a.email_verified FROM app_live_passcodes p JOIN learner_accounts a ON a.id=p.account_id WHERE p.login_id=?')
    .bind(input.loginId).first<AccountRow & { passcode_hash: string }>();
  // Verified even for an unknown ID, so response time does not reveal which IDs exist.
  const valid = await verifyPassword(input.passcode, row?.passcode_hash ?? DUMMY_HASH);
  if (!row || !valid) throw new ApiError('live_passcode_invalid', 'The TechlyUp ID or passcode is incorrect.', 401);
  await db.prepare('UPDATE app_live_passcodes SET last_used_at=? WHERE login_id=?').bind(now(), input.loginId).run();
  return identityFor(db, row);
}

/**
 * LIVE has just proved control of this mailbox with its own email code, so the TechlyUp account using that email signs in there.
 * Only an operator-bound caller can ask, and LIVE never creates an account of its own from this.
 */
export async function accountForVerifiedEmail(env: LiveLoginEnv, props: LiveLoginProps | undefined, raw: { email: string }): Promise<LiveLoginIdentity> {
  const { db } = caller(env, props), input = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict().parse(raw);
  await rateLimit(db, 'live-verified-email', input.email, 10, 600);
  const row = await db.prepare('SELECT id,email,name,email_verified FROM learner_accounts WHERE email=?').bind(input.email).first<AccountRow>();
  if (!row) throw new ApiError('live_account_not_found', 'No TechlyUp account uses this email yet. Create a free account in the TechlyUp app, then sign in here.', 404);
  return identityFor(db, row);
}

export async function handleLivePasscodeHttp(request: Request, env: LiveLoginEnv, requestId: string) {
  if (new URL(request.url).pathname !== '/api/v1/live/passcode') return null;
  const { db } = liveLoginDatabase(env);
  const identity = await authenticate(db, env.TECHLYUP_ERP_ORG_ID!, request.headers.get('authorization'));
  if (request.method === 'GET') return success(await passcodeStatus(db, identity.user.id), requestId);
  if (request.method === 'POST') {
    z.object({}).strict().parse(await jsonBody(request));
    await rateLimit(db, 'live-passcode-create', identity.user.id, 5);
    return success(await createPasscode(db, identity.user.id), requestId, 201);
  }
  throw new ApiError('method_not_allowed', 'This API method is not supported.', 405);
}
