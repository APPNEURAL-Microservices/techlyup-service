import type { AuthSession, ClientPlatform, ProfileInput, SignupInput, UserProfile } from '@techlyup/contracts';
import { ApiError, type D1Database } from '../types';
import { DUMMY_HASH, hash, hashPassword, opaque, validToken, verifyPassword } from './crypto';
import { authority } from './permissions';

export const ACCESS_SECONDS = 15 * 60;
export const REFRESH_SECONDS = 14 * 24 * 60 * 60;
interface AccountRow { id: string; email: string; name: string; first_name: string | null; middle_name: string | null; last_name: string | null; email_verified: number; password_hash: string; audience_ids: string; goal_ids: string; interest_ids: string }
interface SessionRow extends AccountRow { session_id: string; client: ClientPlatform; password_fingerprint: string; session_expires_at: string; revoked_at: string | null }
interface RefreshRow extends SessionRow { consumed_at: string | null; refresh_expires_at: string }
export interface Identity { user: UserProfile; sessionId: string; account: AccountRow }
const unauthenticated = () => new ApiError('unauthorized', 'Sign in to your TechlyUp account.', 401);
function audit(db: D1Database, accountId: string, sessionId: string, action: string, requestId: string, now: string) {
  return db.prepare('INSERT INTO app_audit_events(id,account_id,session_id,action,request_id,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), accountId, sessionId, action, requestId, now);
}
export async function rateLimit(db: D1Database, bucket: string, key: string, maximum: number, seconds = 3600, now = new Date()) {
  const window = Math.floor(now.getTime() / (seconds * 1000));
  const id = await hash(`${bucket}:${key}:${window}`), expires = new Date((window + 1) * seconds * 1000).toISOString();
  const row = await db.prepare('INSERT INTO app_rate_limits(id,expires_at,count) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(id, expires, maximum).first();
  if (!row) throw new ApiError('rate_limited', 'Please wait before trying again.', 429);
}
function jsonIds(raw: string) {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('invalid_canonical_profile');
  return value as string[];
}
export async function userProfile(db: D1Database, orgId: string, row: AccountRow, now = new Date()): Promise<UserProfile> {
  return { id: row.id, email: row.email, name: row.name, firstName: row.first_name ?? undefined, middleName: row.middle_name ?? undefined, lastName: row.last_name ?? undefined,
    emailVerified: row.email_verified === 1, audienceIds: jsonIds(row.audience_ids), goalIds: jsonIds(row.goal_ids), interestIds: jsonIds(row.interest_ids), ...await authority(db, orgId, row, now.toISOString()) };
}
export async function authenticate(db: D1Database, orgId: string, authorization: string | null, now = new Date()): Promise<Identity> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!validToken(token, 'a')) throw unauthenticated();
  const instant = now.toISOString();
  const row = await db.prepare(`SELECT a.*,s.id AS session_id,s.client,s.password_fingerprint,s.expires_at AS session_expires_at,s.revoked_at
    FROM app_access_tokens t JOIN app_sessions s ON s.id=t.session_id JOIN learner_accounts a ON a.id=s.account_id
    WHERE t.token_hash=? AND t.expires_at>? AND s.expires_at>? AND s.revoked_at IS NULL`)
    .bind(await hash(token), instant, instant).first<SessionRow>();
  if (!row || row.password_fingerprint !== await hash(row.password_hash)) throw unauthenticated();
  return { user: await userProfile(db, orgId, row, now), sessionId: row.session_id, account: row };
}
async function credentials(accountId: string, passwordHash: string, client: ClientPlatform, now: Date) {
  const accessToken = opaque('a'), refreshToken = opaque('r');
  return { sessionId: crypto.randomUUID(), accountId, fingerprint: await hash(passwordHash), client, accessToken, refreshToken,
    accessHash: await hash(accessToken), refreshHash: await hash(refreshToken), createdAt: now.toISOString(),
    accessExpires: new Date(now.getTime() + ACCESS_SECONDS * 1000).toISOString(), refreshExpires: new Date(now.getTime() + REFRESH_SECONDS * 1000).toISOString() };
}
function sessionStatements(db: D1Database, c: Awaited<ReturnType<typeof credentials>>, action: string, requestId: string) {
  return [
    db.prepare('INSERT INTO app_sessions(id,account_id,client,password_fingerprint,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(c.sessionId,c.accountId,c.client,c.fingerprint,c.createdAt,c.refreshExpires),
    db.prepare('INSERT INTO app_access_tokens(token_hash,session_id,expires_at) VALUES(?,?,?)').bind(c.accessHash,c.sessionId,c.accessExpires),
    db.prepare('INSERT INTO app_refresh_tokens(token_hash,session_id,expires_at) VALUES(?,?,?)').bind(c.refreshHash,c.sessionId,c.refreshExpires),
    audit(db,c.accountId,c.sessionId,action,requestId,c.createdAt),
  ];
}
export async function signup(db: D1Database, orgId: string, input: SignupInput, client: ClientPlatform, requestId: string, now = new Date()): Promise<AuthSession> {
  const id = `acct_${crypto.randomUUID()}`, password = await hashPassword(input.password), c = await credentials(id,password,client,now);
  const row: AccountRow = { id, email: input.email, name: `${input.firstName} ${input.lastName}`, first_name: input.firstName, middle_name: null, last_name: input.lastName,
    email_verified: 0, password_hash: password, audience_ids: '[]', goal_ids: '[]', interest_ids: '[]' };
  // Resolve required canonical role tables before any write, including for a new learner.
  const user = await userProfile(db,orgId,row,now);
  try {
    await db.batch([
      db.prepare('INSERT INTO learner_accounts(id,email,name,first_name,last_name,password_hash,consent_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,input.email,row.name,input.firstName,input.lastName,password,input.consentVersion,c.createdAt,c.createdAt),
      ...sessionStatements(db,c,'auth.signup',requestId),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: learner_accounts.email/.test(error.message)) throw new ApiError('account_unavailable', 'Unable to create an account with these details. Try signing in.', 409);
    throw error;
  }
  return { user, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresIn: ACCESS_SECONDS };
}
export async function login(db: D1Database, orgId: string, email: string, password: string, client: ClientPlatform, requestId: string, now = new Date()): Promise<AuthSession> {
  const row = await db.prepare('SELECT * FROM learner_accounts WHERE email=?').bind(email).first<AccountRow>();
  const matches = await verifyPassword(password,row?.password_hash ?? DUMMY_HASH);
  if (!row || !matches) throw new ApiError('invalid_credentials', 'Email or password is incorrect.', 401);
  const user = await userProfile(db,orgId,row,now), c = await credentials(row.id,row.password_hash,client,now);
  await db.batch(sessionStatements(db,c,'auth.login',requestId));
  return { user, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresIn: ACCESS_SECONDS };
}
async function revoke(db: D1Database, session: { id: string; accountId: string }, action: string, requestId: string, now: string) {
  await db.batch([
    db.prepare('UPDATE app_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now,session.id),
    audit(db,session.accountId,session.id,action,requestId,now),
  ]);
}
export async function refresh(db: D1Database, orgId: string, token: string, client: ClientPlatform, requestId: string, now = new Date()): Promise<AuthSession> {
  if (!validToken(token,'r')) throw unauthenticated();
  const tokenHash = await hash(token), instant = now.toISOString();
  const row = await db.prepare(`SELECT a.*,s.id AS session_id,s.client,s.password_fingerprint,s.expires_at AS session_expires_at,s.revoked_at,t.consumed_at,t.expires_at AS refresh_expires_at
    FROM app_refresh_tokens t JOIN app_sessions s ON s.id=t.session_id JOIN learner_accounts a ON a.id=s.account_id WHERE t.token_hash=?`)
    .bind(tokenHash).first<RefreshRow>();
  if (!row || row.client !== client || row.revoked_at || row.session_expires_at <= instant || row.refresh_expires_at <= instant || row.password_fingerprint !== await hash(row.password_hash)) throw unauthenticated();
  if (row.consumed_at) { await revoke(db,{id:row.session_id,accountId:row.id},'auth.replay_revoked',requestId,instant); throw new ApiError('refresh_replayed','This app session ended. Sign in again.',401); }
  const user = await userProfile(db,orgId,row,now), accessToken = opaque('a'), refreshToken = opaque('r'), rotation = crypto.randomUUID();
  const result = await db.batch([
    db.prepare(`UPDATE app_refresh_tokens SET consumed_at=?,rotation_id=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?
      AND EXISTS(SELECT 1 FROM app_sessions s JOIN learner_accounts a ON a.id=s.account_id WHERE s.id=app_refresh_tokens.session_id AND s.revoked_at IS NULL AND s.expires_at>? AND a.password_hash=?)`)
      .bind(instant,rotation,tokenHash,instant,instant,row.password_hash),
    db.prepare('DELETE FROM app_access_tokens WHERE session_id=? AND EXISTS(SELECT 1 FROM app_refresh_tokens WHERE token_hash=? AND rotation_id=?)').bind(row.session_id,tokenHash,rotation),
    db.prepare('INSERT INTO app_refresh_tokens(token_hash,session_id,expires_at) SELECT ?,session_id,expires_at FROM app_refresh_tokens WHERE token_hash=? AND rotation_id=?').bind(await hash(refreshToken),tokenHash,rotation),
    db.prepare('INSERT INTO app_access_tokens(token_hash,session_id,expires_at) SELECT ?,session_id,? FROM app_refresh_tokens WHERE token_hash=? AND rotation_id=?').bind(await hash(accessToken),new Date(Math.min(Date.parse(row.session_expires_at),now.getTime()+ACCESS_SECONDS*1000)).toISOString(),tokenHash,rotation),
    db.prepare("INSERT INTO app_audit_events(id,account_id,session_id,action,request_id,created_at) SELECT ?,?,session_id,'auth.refresh',?,? FROM app_refresh_tokens WHERE token_hash=? AND rotation_id=?").bind(crypto.randomUUID(),row.id,requestId,instant,tokenHash,rotation),
  ]);
  if (result[0].meta.changes !== 1) { await revoke(db,{id:row.session_id,accountId:row.id},'auth.replay_revoked',requestId,instant); throw new ApiError('refresh_replayed','This app session ended. Sign in again.',401); }
  return { user, accessToken, refreshToken, expiresIn: Math.max(0,Math.min(ACCESS_SECONDS,Math.floor((Date.parse(row.session_expires_at)-now.getTime())/1000))) };
}
export async function logout(db: D1Database, identity: Identity, requestId: string, now = new Date()) { await revoke(db,{id:identity.sessionId,accountId:identity.user.id},'auth.logout',requestId,now.toISOString()); }
export async function logoutRefresh(db: D1Database, token: string, client: ClientPlatform, requestId: string, now = new Date()) {
  if (!validToken(token,'r')) throw unauthenticated();
  const row = await db.prepare('SELECT s.id,s.account_id,s.client FROM app_refresh_tokens t JOIN app_sessions s ON s.id=t.session_id WHERE t.token_hash=?').bind(await hash(token)).first<{id:string;account_id:string;client:string}>();
  if (!row || row.client !== client) throw unauthenticated();
  await revoke(db,{id:row.id,accountId:row.account_id},'auth.logout',requestId,now.toISOString());
}
export async function updateProfile(db: D1Database, orgId: string, identity: Identity, input: ProfileInput, requestId: string, now = new Date()) {
  await db.batch([
    db.prepare('UPDATE learner_accounts SET name=?,first_name=?,last_name=?,audience_ids=?,goal_ids=?,interest_ids=?,updated_at=? WHERE id=?').bind([input.firstName,identity.account.middle_name,input.lastName].filter(Boolean).join(' '),input.firstName,input.lastName,JSON.stringify([...new Set(input.audienceIds)]),JSON.stringify([...new Set(input.goalIds)]),JSON.stringify([...new Set(input.interestIds)]),now.toISOString(),identity.user.id),
    audit(db,identity.user.id,identity.sessionId,'profile.update',requestId,now.toISOString()),
  ]);
  const row = await db.prepare('SELECT * FROM learner_accounts WHERE id=?').bind(identity.user.id).first<AccountRow>();
  if (!row) throw unauthenticated();
  return userProfile(db,orgId,row,now);
}
