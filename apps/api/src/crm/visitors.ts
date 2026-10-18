import { z } from 'zod';
import { hash } from '../auth/crypto';
import { rateLimit } from '../auth/service';
import { database, type config } from '../config';
import { jsonBody, success } from '../http';
import { ApiError, type Env } from '../types';

export const VISITOR_POLICY = 'crm-analytics-2026-10';
const DAY = 86400000;
const consentSchema = z.object({ granted: z.boolean(), external: z.boolean().default(false), policyVersion: z.literal(VISITOR_POLICY) }).strict();
const eventSchema = z.object({
  event: z.enum(['page_view','cta_click','form_open','resource_open']),
  page: z.enum(['home','learn','webinars','mentors','career','contact','resources','organization']),
}).strict();
function cookieName(request: Request) { return new URL(request.url).protocol === 'https:' ? '__Host-tlu_visitor' : 'tlu_dev_visitor'; }
function token(request: Request) {
  const found = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName(request)}=`))?.split('=')[1];
  return found && /^[a-f0-9]{64}$/.test(found) ? found : null;
}
function setCookie(response: Response, request: Request, value: string, clear = false) {
  response.headers.append('Set-Cookie', `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 30*86400}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`);
}
async function withdraw(db:ReturnType<typeof database>,value:string,instant:string){
  const fingerprint=await hash(value);
  await db.batch([
    db.prepare('UPDATE crm_visitors SET revoked_at=?,external_granted=0 WHERE token_hash=?').bind(instant,fingerprint),
    db.prepare('DELETE FROM crm_visitor_events WHERE visitor_hash=?').bind(fingerprint),
  ]);
}
/** No personal identity, URL/referrer, fingerprint, free-form properties or join to contacts. */
export async function handleVisitors(request: Request, env: Env, requestId: string, settings: ReturnType<typeof config>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!['/api/v1/crm/visitor/consent','/api/v1/crm/visitor/events'].includes(path)) return null;
  if (request.method !== 'POST') throw new ApiError('method_not_allowed','Use POST for this privacy action.',405);
  const db = database(env), now = new Date(), instant = now.toISOString();
  await rateLimit(db,'crm-visitor-ip',request.headers.get('cf-connecting-ip') ?? 'local',120,60);
  if (path.endsWith('/consent')) {
    const input = consentSchema.parse(await jsonBody(request));
    const existing = token(request);
    if (!input.granted) {
      if (existing) {
        await withdraw(db,existing,instant);
      }
      const response = success({granted:false,deletedLocalEvents:true},requestId);
      setCookie(response,request,'',true); return response;
    }
    if (!settings.crm || !settings.crmCapture) throw new ApiError('feature_disabled','Optional usage analytics are unavailable.',503);
    if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') {
      if(existing)await withdraw(db,existing,instant);
      throw new ApiError('privacy_preference','Your browser privacy preference keeps optional analytics off.',409);
    }
    // Repeated consent must not orphan the previous token/events.
    if (existing) {
      const found = await db.prepare('SELECT token_hash FROM crm_visitors WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND policy_version=?').bind(await hash(existing),instant,VISITOR_POLICY).first();
      if (found) {
        await db.batch([
          db.prepare('UPDATE crm_visitors SET external_granted=? WHERE token_hash=?').bind(input.external?1:0,await hash(existing)),
          ...(input.external ? [] : [db.prepare("UPDATE crm_visitor_exports SET status='suppressed',updated_at=? WHERE event_id IN (SELECT id FROM crm_visitor_events WHERE visitor_hash=?) AND status='pending'").bind(instant,await hash(existing))]),
        ]);
        return success({granted:true,external:input.external,expiresInDays:30},requestId);
      }
    }
    const value = Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
    await db.prepare('INSERT INTO crm_visitors(token_hash,policy_version,created_at,expires_at,external_granted) VALUES(?,?,?,?,?)').bind(await hash(value),VISITOR_POLICY,instant,new Date(now.getTime()+30*DAY).toISOString(),input.external?1:0).run();
    const response = success({granted:true,external:input.external,expiresInDays:30},requestId,201);
    setCookie(response,request,value); return response;
  }
  const input = eventSchema.parse(await jsonBody(request));
  if (!settings.crm || !settings.crmCapture) throw new ApiError('feature_disabled','Optional usage analytics are unavailable.',503);
  if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') {
    const existing=token(request);if(existing)await withdraw(db,existing,instant);
    throw new ApiError('privacy_preference','Optional analytics are disabled by your browser privacy preference.',403);
  }
  const value = token(request);
  if (!value) throw new ApiError('consent_required','Optional usage analytics require your permission.',403);
  const fingerprint = await hash(value);
  const eventId = crypto.randomUUID();
  const statements = [db.prepare(`INSERT INTO crm_visitor_events(id,visitor_hash,event,page,created_at)
    SELECT ?,token_hash,?,?,? FROM crm_visitors WHERE token_hash=? AND policy_version=? AND revoked_at IS NULL AND expires_at>?`).bind(eventId,input.event,input.page,instant,fingerprint,VISITOR_POLICY,instant),
  ];
  if (env.CRM_ANALYTICS_EXPORT_ENABLED === 'true') for (const provider of ['posthog','ga4'] as const) {
    if (provider === 'posthog' && !env.CRM_POSTHOG_PROJECT_KEY || provider === 'ga4' && (!env.CRM_GA4_MEASUREMENT_ID || !env.CRM_GA4_API_SECRET)) continue;
    statements.push(db.prepare(`INSERT INTO crm_visitor_exports(event_id,provider,status,created_at,updated_at)
      SELECT id,?,'pending',?,? FROM crm_visitor_events WHERE id=? AND EXISTS(SELECT 1 FROM crm_visitors WHERE token_hash=? AND external_granted=1 AND revoked_at IS NULL AND expires_at>?)`).bind(provider,instant,instant,eventId,fingerprint,instant));
  }
  const result = await db.batch(statements);
  if (result[0].meta.changes !== 1) throw new ApiError('consent_required','Optional usage analytics require current permission.',403);
  return success({accepted:true,anonymous:true},requestId,202);
}
export async function cleanVisitors(env: Env, now = new Date()) {
  const db = database(env);
  await db.batch([
    db.prepare('DELETE FROM crm_visitors WHERE token_hash IN (SELECT token_hash FROM crm_visitors WHERE expires_at<=? OR revoked_at IS NOT NULL LIMIT 200)').bind(now.toISOString()),
    db.prepare('DELETE FROM crm_visitor_events WHERE id IN (SELECT id FROM crm_visitor_events WHERE created_at<? LIMIT 500)').bind(new Date(now.getTime()-30*DAY).toISOString()),
    db.prepare("UPDATE crm_visitor_exports SET status='uncertain',updated_at=? WHERE rowid IN(SELECT rowid FROM crm_visitor_exports WHERE status='sending' AND updated_at<? LIMIT 100)").bind(now.toISOString(),new Date(now.getTime()-300000).toISOString()),
  ]);
}
