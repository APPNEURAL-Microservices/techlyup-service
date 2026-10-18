import { z } from 'zod';
import { ApiError } from '../types';

/** Credentials are operator secrets. These values never enter integration metadata or client DTOs. */
export interface CrmEnv {
  CRM_NOTIFICATION_ORIGIN?: string;
  CRM_NOTIFICATION_CREDENTIAL?: string;
  CRM_NOTIFICATION_TENANT_ID?: string;
  CRM_NOTIFICATION_SUBJECT_ID?: string;
  CRM_NOTIFICATION_EMAIL_TYPE?: string;
  CRM_NOTIFICATION_WHATSAPP_TYPE?: string;
  CRM_NOTIFICATION_ALLOW_LOCAL?: string;
  CRM_NOTIFICATION_AUTHORITY_APPROVED?: string;
  CRM_PUBLIC_ORIGIN?: string;
  APP_ALLOWED_ORIGINS?: string;
  CRM_WEBHOOK_SECRET?: string;
  CRM_DELIVERY_AUTH_SECRET?: string;
  CRM_META_APPROVED?: string;
  CRM_LINKEDIN_APPROVED?: string;
  CRM_EXTERNAL_APPROVED?: string;
  APP_ENV?: string;
}
const reference = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export type AcquisitionChannel = 'email' | 'whatsapp';
export type ProviderOutcome =
  | { state: 'accepted'; nativeIntentId: string }
  | { state: 'failed' | 'blocked' | 'uncertain'; errorCode: string };
export interface DispatchInput {
  jobId: string; leadId: string; channel: AcquisitionChannel; recipient: string;
  name: string; subject: string; body: string; unsubscribeUrl: string;
}

function configuration(env: CrmEnv) {
  let url: URL;
  try { url = new URL(env.CRM_NOTIFICATION_ORIGIN ?? ''); }
  catch { throw new ApiError('crm_provider_unavailable','The notification owner is not configured.',503); }
  const local = ['development','test'].includes(env.APP_ENV ?? '') && env.CRM_NOTIFICATION_ALLOW_LOCAL === 'true' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if (url.origin !== env.CRM_NOTIFICATION_ORIGIN || url.username || url.password || url.protocol !== 'https:' && !local || url.pathname !== '/') throw new ApiError('crm_provider_unavailable','The notification owner configuration is invalid.',503);
  const credential = env.CRM_NOTIFICATION_CREDENTIAL;
  if (!credential || credential.length < 32 || credential.length > 16384 || /[\r\n]/.test(credential) || !reference.safeParse(env.CRM_NOTIFICATION_TENANT_ID).success || !reference.safeParse(env.CRM_NOTIFICATION_SUBJECT_ID).success) throw new ApiError('crm_provider_unavailable','The notification owner configuration is invalid.',503);
  return { origin: url.origin, credential, tenant: env.CRM_NOTIFICATION_TENANT_ID!, subject: env.CRM_NOTIFICATION_SUBJECT_ID! };
}
export function notificationConfigured(env: CrmEnv, channel: AcquisitionChannel) {
  try { configuration(env); publicCrmOrigin(env); return reference.safeParse(channel === 'email' ? env.CRM_NOTIFICATION_EMAIL_TYPE : env.CRM_NOTIFICATION_WHATSAPP_TYPE).success; }
  catch { return false; }
}
export function validateCrmProviders(env:CrmEnv){
  configuration(env);
  publicCrmOrigin(env);
  if(!notificationConfigured(env,'email')&&!notificationConfigured(env,'whatsapp'))throw new ApiError('configuration_required','A registered acquisition notification type is required.',503);
}
export function publicCrmOrigin(env:CrmEnv){
  let url:URL;try{url=new URL(env.CRM_PUBLIC_ORIGIN??'');}catch{throw new ApiError('configuration_required','A published communication preference origin is required.',503);}
  const origins=(env.APP_ALLOWED_ORIGINS??'').split(',').map(value=>value.trim());
  if(url.origin!==env.CRM_PUBLIC_ORIGIN||url.protocol!=='https:'||url.username||url.password||!(url.hostname==='techlyup.com'||url.hostname.endsWith('.techlyup.com'))||!origins.includes(url.origin))throw new ApiError('configuration_required','The communication preference origin is not approved.',503);
  return url.origin;
}
async function boundedJson(response: Response) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('owner_response_invalid');
  const reader = response.body?.getReader(); if (!reader) throw new Error('owner_response_invalid');
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) { await reader.cancel(); throw new Error('owner_response_too_large'); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}
const intentSchema = z.object({
  id: reference, tenantId: reference, sourceService: reference,
  sourceEventId: reference, sourceResourceId: reference,
  status: z.enum(['CREATED','RESOLVING','RESOLVED','SUPPRESSED','DEFERRED','QUEUED','PROCESSING','COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED']),
}).passthrough();
function intent(raw: unknown, env: CrmEnv, input: {jobId:string;leadId:string}, expectedId?: string) {
  const value = intentSchema.parse(z.object({data:z.unknown()}).parse(raw).data);
  if (value.tenantId !== env.CRM_NOTIFICATION_TENANT_ID || value.sourceService !== env.CRM_NOTIFICATION_SUBJECT_ID || value.sourceEventId !== input.jobId || value.sourceResourceId !== input.leadId || expectedId && value.id !== expectedId) throw new Error('owner_binding_invalid');
  return value;
}

/** Existing notification-service owns intent, templates, preferences and channel plans;
 * messaging-service alone owns vendor transport. An intent receipt proves durable
 * intent acceptance and never recipient delivery. There is deliberately no retry here. */
export async function dispatchNotification(env: CrmEnv, input: DispatchInput, beforeSend: () => Promise<boolean>, fetcher: typeof fetch = fetch): Promise<ProviderOutcome> {
  if (!notificationConfigured(env,input.channel)) return {state:'blocked',errorCode:'notification_not_configured'};
  const c = configuration(env);
  if (!z.uuid().safeParse(input.jobId).success || !z.uuid().safeParse(input.leadId).success || !(input.channel === 'email' ? z.email().max(254).safeParse(input.recipient).success : /^\+[1-9]\d{7,14}$/.test(input.recipient)) || /[\r\n\0]/.test(input.recipient) || input.name.length > 160 || input.subject.length > 200 || input.body.length > 10000) return {state:'blocked',errorCode:'notification_payload_invalid'};
  let unsubscribe: URL;
  try { unsubscribe = new URL(input.unsubscribeUrl); if (unsubscribe.origin!==publicCrmOrigin(env)||unsubscribe.protocol !== 'https:' || unsubscribe.username || unsubscribe.password || unsubscribe.search || unsubscribe.pathname!=='/communication-preferences'||!/^#token=[A-Za-z0-9_-]{40,160}$/.test(unsubscribe.hash)) throw new Error(); }
  catch { return {state:'blocked',errorCode:'unsubscribe_required'}; }
  try { if (!await beforeSend()) return {state:'blocked',errorCode:'current_consent_required'}; }
  catch { return {state:'blocked',errorCode:'authority_unavailable'}; }
  try {
    const response = await fetcher(`${c.origin}/api/v1/notification-intents`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{authorization:`Bearer ${c.credential}`,'x-tenant-id':c.tenant,'content-type':'application/json','idempotency-key':`techlyup-crm:${input.jobId}`},
      body:JSON.stringify({typeKey:input.channel==='email'?env.CRM_NOTIFICATION_EMAIL_TYPE:env.CRM_NOTIFICATION_WHATSAPP_TYPE,
        sourceService:c.subject,sourceEventId:input.jobId,sourceResourceType:'techlyup-acquisition',sourceResourceId:input.leadId,
        recipientSpec:{type:'EXPLICIT_CONTACT',contacts:{[input.channel==='email'?'EMAIL':'WHATSAPP']:input.recipient}},
        payload:{name:input.name,subject:input.subject,body:input.body,unsubscribeUrl:unsubscribe.href},
        dedupeKey:`techlyup-crm:${input.jobId}`,priority:'NORMAL'}),
    });
    if (!response.ok) {
      // A known pre-acceptance 4xx is definitive. 408/429/5xx/redirect and all
      // malformed responses remain uncertain; neither fallback nor retry sends.
      return response.status >= 400 && response.status < 500 && ![408,429].includes(response.status)
        ? {state:'failed',errorCode:`notification_rejected_${response.status}`}
        : {state:'uncertain',errorCode:'notification_acceptance_unknown'};
    }
    const receipt = intent(await boundedJson(response),env,input);
    return {state:'accepted',nativeIntentId:receipt.id};
  } catch { return {state:'uncertain',errorCode:'notification_acceptance_unknown'}; }
}

/** Reconcile only a previously bound native intent. A caller-posted status or
 * arbitrary message ID cannot become evidence of delivery. */
export async function inspectNotification(env: CrmEnv, input:{jobId:string;leadId:string;nativeIntentId:string}, fetcher:typeof fetch=fetch) {
  const c=configuration(env);
  if(!reference.safeParse(input.nativeIntentId).success)throw new ApiError('crm_provider_proof_invalid','A bound native intent is required.',422);
  const response=await fetcher(`${c.origin}/api/v1/notification-intents/${encodeURIComponent(input.nativeIntentId)}`,{headers:{authorization:`Bearer ${c.credential}`,'x-tenant-id':c.tenant},redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new ApiError('crm_provider_unavailable','Native intent evidence is unavailable.',503);
  try {const value=intent(await boundedJson(response),env,input,input.nativeIntentId);return {nativeIntentId:value.id,nativeStatus:value.status,intentAccepted:true as const,deliveryVerified:false as const};}
  catch {throw new ApiError('crm_provider_proof_invalid','Native intent evidence does not match this job.',503);}
}
