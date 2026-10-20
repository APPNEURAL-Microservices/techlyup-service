import {z} from 'zod';
import {ApiError,type D1Database} from '../types';
import {database} from '../config';
import {hash} from '../auth/crypto';
import type {Identity} from '../auth/service';
import type {LiveContext,SupportEnv,SupportProps} from './types';
const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/);
const context=z.object({liveSubject:identifier,sessionBinding:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough();
export function supportEnabled(env:SupportEnv){if(env.APP_ENABLED!=='true'||env.APP_SUPPORT_CREDITS_ENABLED!=='true')throw new ApiError('support_disabled','Support credits are not enabled.',503);if(!env.SUPPORT_EXPECTED_CLIENT_ID||!env.TECHLYUP_ERP_ORG_ID||!env.SUPPORT_LEARNER_ISSUER)throw new ApiError('support_not_configured','Support identity is not configured.',503);return database(env);}
export function caller(env:SupportEnv,props:SupportProps){supportEnabled(env);if(props?.clientId!==env.SUPPORT_EXPECTED_CLIENT_ID||props?.product!=='techlyup'||props?.tenantId!==env.TECHLYUP_ERP_ORG_ID)throw new ApiError('support_caller_denied','This service binding is not authorized for support credits.',403);return props.clientId;}
export function liveContext(input:unknown){return context.parse(input);}
export function localSupportOrigin(env:SupportEnv,url:URL){return ['test','development'].includes(env.APP_ENV??'')&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);}
export function canonicalOrigin(env:SupportEnv){let u:URL;try{u=new URL(env.SUPPORT_PUBLIC_ORIGIN??'');}catch{throw new ApiError('support_not_configured','Canonical account authorization is not configured.',503);}if(u.origin!==env.SUPPORT_PUBLIC_ORIGIN||u.username||u.password||(u.protocol!=='https:'&&!localSupportOrigin(env,u))||!(env.APP_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).includes(u.origin))throw new ApiError('support_not_configured','Canonical account authorization is not configured.',503);return u.origin;}
const now=()=>new Date().toISOString();
function opaque(){return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function guard(db:D1Database,condition:string,values:unknown[]){return db.prepare(`INSERT INTO app_support_guards(id,satisfied) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(crypto.randomUUID(),...values);}
export async function beginLink(env:SupportEnv,props:SupportProps,raw:LiveContext&{pkceChallenge:string}){
 const origin=canonicalOrigin(env),client=caller(env,props),input=context.extend({pkceChallenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).parse(raw),db=database(env),id=crypto.randomUUID(),created=now(),expiresAt=new Date(Date.now()+300000).toISOString();
 const recent=await db.prepare('SELECT COUNT(*) n FROM app_support_link_challenges WHERE client_id=? AND live_subject=? AND created_at>?').bind(client,input.liveSubject,new Date(Date.now()-3600000).toISOString()).first<{n:number}>();if((recent?.n??0)>=10)throw new ApiError('rate_limited','Please wait before starting another account link.',429);
 await db.prepare('INSERT INTO app_support_link_challenges(id,client_id,live_subject,session_binding,pkce_challenge,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,client,input.liveSubject,input.sessionBinding,input.pkceChallenge,expiresAt,created).run();
 return {challengeId:id,expiresAt,authorizeUrl:`${origin}/support/link?challengeId=${id}`};
}
export async function authorizeLink(env:SupportEnv,identity:Identity,challengeId:string,confirm:boolean){
 const db=supportEnabled(env);z.uuid().parse(challengeId);if(confirm!==true)throw new ApiError('link_confirmation_required','Confirm the account link to continue.',422);
 const code=opaque(),codeHash=await hash(code),at=now();
 const row=await db.prepare('SELECT expires_at FROM app_support_link_challenges WHERE id=? AND client_id=? AND expires_at>? AND consumed_at IS NULL AND attempts<5 AND (authorized_account_id IS NULL OR authorized_account_id=?)').bind(challengeId,env.SUPPORT_EXPECTED_CLIENT_ID!,at,identity.user.id).first<{expires_at:string}>();
 if(!row)throw new ApiError('link_unavailable','This link request expired or is no longer available. Start a new request.',409);
 try{await db.batch([
  guard(db,'EXISTS(SELECT 1 FROM app_sessions s JOIN learner_accounts a ON a.id=s.account_id WHERE s.id=? AND s.account_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND a.password_hash=?) AND EXISTS(SELECT 1 FROM app_support_link_challenges WHERE id=? AND client_id=? AND expires_at>? AND consumed_at IS NULL AND attempts<5 AND (authorized_account_id IS NULL OR authorized_account_id=?))',[identity.sessionId,identity.user.id,at,identity.account.password_hash,challengeId,env.SUPPORT_EXPECTED_CLIENT_ID!,at,identity.user.id]),
  db.prepare('UPDATE app_support_link_challenges SET authorized_account_id=?,authorized_session_id=?,code_hash=?,authorized_at=? WHERE id=?').bind(identity.user.id,identity.sessionId,codeHash,at,challengeId),
  db.prepare("INSERT INTO app_support_audit_events(id,account_id,action,source_ref,created_at) VALUES(?,?,'LINK_AUTHORIZED',?,?)").bind(crypto.randomUUID(),identity.user.id,challengeId,at),
 ]);}catch{throw new ApiError('link_unavailable','Account authorization changed. Start a new account link.',409);}
 return {code,expiresAt:row.expires_at,accountDisplay:identity.user.name};
}
export async function consumeLink(env:SupportEnv,props:SupportProps,raw:LiveContext&{challengeId:string;code:string;verifier:string}){
 const client=caller(env,props),input=context.extend({challengeId:z.uuid(),code:z.string().regex(/^[a-f0-9]{64}$/),verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)}).parse(raw),db=database(env);
 const pkce=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.verifier))))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''),codeHash=await hash(input.code),at=now();
 const challenge=await db.prepare('SELECT c.*,a.name,s.password_fingerprint,a.password_hash FROM app_support_link_challenges c JOIN learner_accounts a ON a.id=c.authorized_account_id JOIN app_sessions s ON s.id=c.authorized_session_id WHERE c.id=? AND c.client_id=? AND c.live_subject=? AND c.session_binding=? AND c.expires_at>? AND c.attempts<5 AND s.revoked_at IS NULL AND s.expires_at>?').bind(input.challengeId,client,input.liveSubject,input.sessionBinding,at,at).first<{authorized_account_id:string;name:string;password_fingerprint:string;password_hash:string;code_hash:string;pkce_challenge:string;consumed_at:string|null}>();
 if(!challenge||challenge.code_hash!==codeHash||challenge.pkce_challenge!==pkce||challenge.password_fingerprint!==await hash(challenge.password_hash)){
  await db.prepare('UPDATE app_support_link_challenges SET attempts=attempts+1 WHERE id=? AND client_id=? AND live_subject=? AND session_binding=? AND consumed_at IS NULL').bind(input.challengeId,client,input.liveSubject,input.sessionBinding).run();throw new ApiError('link_code_invalid','The one-use code is invalid, expired or belongs to another sign-in. Start again if needed.',409);
 }
 const current=await db.prepare('SELECT account_id,challenge_id FROM app_support_links WHERE client_id=? AND live_subject=? AND revoked_at IS NULL').bind(client,input.liveSubject).first<{account_id:string;challenge_id:string}>();
 if(challenge.consumed_at){if(current?.account_id===challenge.authorized_account_id&&current.challenge_id===input.challengeId)return {linked:true as const,accountDisplay:challenge.name};throw new ApiError('link_code_consumed','This code has already been used.',409);}
 if(current&&current.account_id!==challenge.authorized_account_id)throw new ApiError('link_already_exists','Unlink the existing canonical account before connecting another.',409);
 try{await db.batch([
  guard(db,'EXISTS(SELECT 1 FROM app_support_link_challenges c JOIN app_sessions s ON s.id=c.authorized_session_id JOIN learner_accounts a ON a.id=c.authorized_account_id WHERE c.id=? AND c.consumed_at IS NULL AND c.code_hash=? AND c.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND a.password_hash=?)',[input.challengeId,codeHash,at,at,challenge.password_hash]),
  db.prepare('INSERT INTO app_support_links(client_id,live_subject,account_id,challenge_id,linked_at) VALUES(?,?,?,?,?) ON CONFLICT(client_id,live_subject) DO UPDATE SET account_id=excluded.account_id,challenge_id=excluded.challenge_id,linked_at=excluded.linked_at,revoked_at=NULL WHERE app_support_links.revoked_at IS NOT NULL OR app_support_links.account_id=excluded.account_id').bind(client,input.liveSubject,challenge.authorized_account_id,input.challengeId,at),
  guard(db,'EXISTS(SELECT 1 FROM app_support_links WHERE client_id=? AND live_subject=? AND account_id=? AND challenge_id=? AND revoked_at IS NULL)',[client,input.liveSubject,challenge.authorized_account_id,input.challengeId]),
  db.prepare('UPDATE app_support_link_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').bind(at,input.challengeId),
  db.prepare("INSERT INTO app_support_audit_events(id,account_id,action,source_ref,created_at) VALUES(?,?,'ACCOUNT_LINKED',?,?)").bind(crypto.randomUUID(),challenge.authorized_account_id,input.challengeId,at),
 ]);}catch{throw new ApiError('link_conflict','This account is already linked or the authorization changed. Refresh before trying again.',409);}
 return {linked:true as const,accountDisplay:challenge.name};
}
export async function linkedAccount(env:SupportEnv,props:SupportProps,raw:LiveContext){const client=caller(env,props),input=liveContext(raw),row=await database(env).prepare('SELECT l.account_id,a.name FROM app_support_links l JOIN learner_accounts a ON a.id=l.account_id WHERE l.client_id=? AND l.live_subject=? AND l.revoked_at IS NULL').bind(client,input.liveSubject).first<{account_id:string;name:string}>();return row;}
export async function unlink(env:SupportEnv,props:SupportProps,raw:LiveContext){const client=caller(env,props),input=liveContext(raw),db=database(env),at=now();await db.batch([db.prepare('UPDATE app_support_links SET revoked_at=? WHERE client_id=? AND live_subject=? AND revoked_at IS NULL').bind(at,client,input.liveSubject),db.prepare('UPDATE app_support_link_challenges SET expires_at=?,code_hash=NULL WHERE client_id=? AND live_subject=? AND consumed_at IS NULL').bind(at,client,input.liveSubject)]);return {linked:false as const};}
