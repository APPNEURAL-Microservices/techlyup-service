import {z} from 'zod';
import type {Env} from '../types';
import {ApiError} from '../types';
import {database} from '../config';
import {authenticate,rateLimit} from '../auth/service';
import {jsonBody,success} from '../http';
import {authorizeLink,supportEnabled,canonicalOrigin,localSupportOrigin} from './link';
import {supportWebhook} from './payments';
import type {SupportEnv} from './types';

export async function handleSupportHttp(request:Request,native:Env,requestId:string){
 const path=new URL(request.url).pathname;if(!path.startsWith('/api/v1/support/'))return null;
 const env=native as SupportEnv;supportEnabled(env);
 if(path==='/api/v1/support/webhook'&&request.method==='POST'){
  if(Number(request.headers.get('content-length')??0)>256000)throw new ApiError('body_too_large','Payment event is too large.',413);
  const reader=request.body?.getReader();if(!reader)throw new ApiError('invalid_request','A signed payment event is required.',400);
  let raw='',bytes=0;const decoder=new TextDecoder('utf-8',{fatal:true});try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>256000){await reader.cancel();throw new ApiError('body_too_large','Payment event is too large.',413);}raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}
  return success(await supportWebhook(env,raw,request.headers.get('x-razorpay-signature')??'',request.headers.get('x-razorpay-event-id')??''),requestId);
 }
 if(path==='/api/v1/support/link/authorize'&&request.method==='POST'){
  const identity=await authenticate(database(env),env.TECHLYUP_ERP_ORG_ID!,request.headers.get('authorization'));
  await rateLimit(database(env),'support-link-authorize',identity.user.id,20);
  const input=z.object({challengeId:z.uuid(),confirm:z.literal(true)}).strict().parse(await jsonBody(request));
  return success(await authorizeLink(env,identity,input.challengeId,input.confirm),requestId);
 }
 throw new ApiError('not_found','Support API route not found.',404);
}

/** Canonical-origin UI; credentials use the existing auth API. Its access token
 * stays only in this page's memory and is never sent to the webinar application. */
export function supportLinkPage(request:Request,native:Env):Response|null{
 const url=new URL(request.url);if(url.pathname!=='/support/link')return null;
 const env=native as SupportEnv;
 try{supportEnabled(env);if(url.origin!==canonicalOrigin(env)||(url.protocol!=='https:'&&!localSupportOrigin(env,url)))return new Response('Use the canonical secure account authorization address.',{status:403,headers:{'cache-control':'no-store'}});}catch{return new Response('Canonical account linking is not enabled in this environment.',{status:503,headers:{'cache-control':'no-store','content-type':'text/plain'}});}
 const challengeId=url.searchParams.get('challengeId');if(!z.uuid().safeParse(challengeId).success)return new Response('Open the account authorization URL from your webinar profile.',{status:422,headers:{'cache-control':'no-store'}});
 const nonce=crypto.randomUUID();
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Connect your TechlyUp account</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;background:#f4f0fb;color:#231638;margin:0;padding:32px 16px}main{background:white;border:1px solid #ddd2ef;max-width:540px;margin:auto;padding:28px}label{display:grid;gap:8px;margin:16px 0}input,button{font:inherit;padding:12px;border:1px solid #b6a4d5;border-radius:0}button{background:#6427b8;color:white;cursor:pointer}button:disabled{opacity:.5}#code{width:100%;box-sizing:border-box;font-family:monospace}p{line-height:1.5}#notice{min-height:24px}small{color:#60516d}</style><main><h1>Connect your TechlyUp account</h1><p>Sign in to your canonical TechlyUp account, then explicitly authorize this connection. We will give you a one-use code to paste into your original webinar window.</p><form id="login"><label>Email<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>Sign in</button></form><div id="authorize" hidden><p id="account"></p><p>This links your webinar profile to this account’s support credits. It does not make a payment, buy credits or grant webinar staff access.</p><button id="confirm">Authorize account connection</button></div><div id="result" hidden><label>One-use connection code<input id="code" readonly type="password" autocomplete="off"></label><button id="show">Show / hide code</button><p>Return to your original webinar window and paste this code there. Never share your password or access token.</p><small id="expires"></small></div><p id="notice" role="status" aria-live="polite"></p><a href="/">Back to TechlyUp</a></main><script nonce="${nonce}">
let access=null;const el=id=>document.getElementById(id),notice=t=>el('notice').textContent=t;async function call(path,body,authenticated=false){const response=await fetch('/api/v1'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-TechlyUp-Client':'web',...(authenticated?{Authorization:'Bearer '+access}:{})},body:JSON.stringify(body)});let value;try{value=await response.json();}catch{throw Error('Account service is unavailable.');}if(!response.ok)throw Error(value.error?.message||'This request could not complete.');return value.data;}function signed(session){access=session.accessToken;el('account').textContent='Signed in as '+session.user.name;el('login').hidden=true;el('authorize').hidden=false;notice('Review and authorize the connection.');}el('login').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button'),form=new FormData(e.currentTarget);button.disabled=true;notice('Signing in…');try{signed(await call('/auth/login',{email:form.get('email'),password:form.get('password')}));e.target.reset();}catch(error){notice(error.message);}finally{button.disabled=false;}});el('confirm').addEventListener('click',async()=>{el('confirm').disabled=true;try{const value=await call('/support/link/authorize',{challengeId:${JSON.stringify(challengeId)},confirm:true},true);el('code').value=value.code;el('expires').textContent='Expires '+new Date(value.expiresAt).toLocaleString();el('authorize').hidden=true;el('result').hidden=false;access=null;notice('Connection authorized. Complete it in your original webinar window.');setTimeout(()=>{el('code').value='';el('result').hidden=true;notice('The connection code expired. Start a new request in your webinar window.');},Math.max(0,Date.parse(value.expiresAt)-Date.now()));}catch(error){notice(error.message);el('confirm').disabled=false;}});el('show').addEventListener('click',()=>{el('code').type=el('code').type==='password'?'text':'password';});call('/auth/refresh',{}).then(signed).catch(()=>notice('Sign in to continue.'));
</script></html>`;
 return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`}});
}
