import { ApiError } from '../types';
import type { CrmEnv } from './providers';

const bytes = new TextEncoder();
const hex = (value:ArrayBuffer)=>Array.from(new Uint8Array(value),byte=>byte.toString(16).padStart(2,'0')).join('');
async function signingKey(secret:string) {
  if(secret.length<32||secret.length>4096)throw new ApiError('crm_webhook_unavailable','The approved webhook relay is not configured.',503);
  return crypto.subtle.importKey('raw',bytes.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
/** Protocol for an approved webhook-service normalization relay, not raw Meta or
 * LinkedIn authenticity. Provider-native signatures stay in their owning service. */
export async function signCrmRelay(secret:string,path:string,raw:string,nonce=crypto.randomUUID(),timestamp=Date.now()) {
  const digest=hex(await crypto.subtle.digest('SHA-256',bytes.encode(raw)));
  const message=`${timestamp}\n${nonce}\n${path}\n${digest}`;
  return {'x-techlyup-crm-time':String(timestamp),'x-techlyup-crm-nonce':nonce,'x-techlyup-crm-signature':hex(await crypto.subtle.sign('HMAC',await signingKey(secret),bytes.encode(message)))};
}
export async function verifyCrmRelay(env:CrmEnv,request:Request,raw:string,now=Date.now()) {
  const timestamp=request.headers.get('x-techlyup-crm-time')??'',nonce=request.headers.get('x-techlyup-crm-nonce')??'',signature=request.headers.get('x-techlyup-crm-signature')??'';
  if(!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>300000||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce)||!/^[0-9a-f]{64}$/.test(signature))throw new ApiError('crm_webhook_unauthorized','A current approved relay signature is required.',401);
  const key=await signingKey(env.CRM_WEBHOOK_SECRET??'');
  const digest=hex(await crypto.subtle.digest('SHA-256',bytes.encode(raw)));
  const expected=bytes.encode(`${timestamp}\n${nonce}\n${new URL(request.url).pathname}\n${digest}`);
  const valid=await crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g)!,byte=>parseInt(byte,16)),expected);
  if(!valid)throw new ApiError('crm_webhook_unauthorized','A current approved relay signature is required.',401);
  return nonce;
}
export function relayProviderApproved(env:CrmEnv,provider:'meta'|'linkedin'|'external') {return provider==='meta'?env.CRM_META_APPROVED==='true':provider==='linkedin'?env.CRM_LINKEDIN_APPROVED==='true':env.CRM_EXTERNAL_APPROVED==='true';}
