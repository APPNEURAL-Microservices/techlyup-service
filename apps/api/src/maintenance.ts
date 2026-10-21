import { config,database } from './config';
import type { Env } from './types';

/** Bounded per invocation. Audit/analytics records are never silently discarded. */
export async function cleanup(env:Env,now=new Date()) {
  if(!config(env).enabled)return;
  const db=database(env),instant=now.toISOString(),retained=new Date(now.getTime()-7*86400000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM app_rate_limits WHERE id IN(SELECT id FROM app_rate_limits WHERE expires_at<=? ORDER BY expires_at,id LIMIT 1000)').bind(instant),
    db.prepare('DELETE FROM app_access_tokens WHERE token_hash IN(SELECT token_hash FROM app_access_tokens WHERE expires_at<=? ORDER BY expires_at,token_hash LIMIT 1000)').bind(instant),
    db.prepare('DELETE FROM app_refresh_tokens WHERE token_hash IN(SELECT token_hash FROM app_refresh_tokens WHERE expires_at<=? ORDER BY expires_at,token_hash LIMIT 1000)').bind(instant),
    db.prepare('DELETE FROM app_sessions WHERE id IN(SELECT id FROM app_sessions WHERE expires_at<=? AND (revoked_at IS NULL OR revoked_at<=?) ORDER BY expires_at,id LIMIT 50)').bind(retained,retained),
    db.prepare('DELETE FROM app_live_login_challenges WHERE id IN(SELECT id FROM app_live_login_challenges WHERE expires_at<=? ORDER BY expires_at,id LIMIT 1000)').bind(retained),
    db.prepare('DELETE FROM app_email_otp_challenges WHERE id IN(SELECT id FROM app_email_otp_challenges WHERE expires_at<=? ORDER BY expires_at,id LIMIT 1000)').bind(retained),
  ]);
}
