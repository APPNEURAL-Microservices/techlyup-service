import { z } from 'zod';
import type { UserProfile } from '@techlyup/contracts';
import { ApiError, type Env } from '../types';
import { database } from '../config';
import { hash, randomHex } from '../auth/crypto';
import { authenticate, rateLimit, userProfile, type Identity } from '../auth/service';
import { jsonBody, success } from '../http';
import { handleStudioRequest } from '../studio/http';

export const productIds = ['courses','mentorship','certificates','learners','earnings','promotion','insights','assistant'] as const;
export type ProductId = typeof productIds[number];
export interface ProductBindingProps { clientId: string; product: 'techlyup'; tenantId: string }
export type ProductUser = Pick<UserProfile,'id'|'name'|'email'|'emailVerified'|'roles'|'permissions'> & { registration?: Pick<NonNullable<UserProfile['registration']>,'accountType'|'teacherRole'> };
export interface ProductSessionResult { sessionToken: string; expiresAt: string; user: ProductUser; returnPath: string }
export interface ProductRequestInput { sessionToken: string; method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE'; path: string; body?: unknown; idempotencyKey?: string }
export interface ProductRequestResult { status: number; body: unknown }
const names: Record<ProductId,string> = { courses:'Courses',mentorship:'Mentorship',certificates:'Certificates',learners:'Learners',earnings:'Earnings',promotion:'Promotion',insights:'Insights',assistant:'AI Assistant' };
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const tokenSchema = z.string().regex(/^tlu_p_[a-f0-9]{64}$/);
const unavailable = () => new ApiError('products_unavailable','TechlyUp product apps are not available in this environment.',503);
const unauthorized = () => new ApiError('product_session_invalid','Sign in again with your TechlyUp account.',401);
const invalidCode = () => new ApiError('product_login_code_invalid','This sign-in request is invalid or expired. Start again from the app.',409);
const clock = () => new Date().toISOString();
/** Product apps receive only what they need for identity and current access. */
function productUser(user:UserProfile):ProductUser{
  return {id:user.id,name:user.name,email:user.email,emailVerified:user.emailVerified,roles:user.roles,permissions:user.permissions,...(user.registration?{registration:{accountType:user.registration.accountType,...(user.registration.teacherRole?{teacherRole:user.registration.teacherRole}:{})}}:{})};
}

/** Product destinations are operator-owned, never supplied by a browser or RPC payload. */
export function productConfiguration(env: Env) {
  if(env.APP_ENABLED!=='true'||env.APP_PRODUCTS_ENABLED!=='true'||!env.TECHLYUP_ERP_ORG_ID)throw unavailable();
  const origins = (env.APP_ALLOWED_ORIGINS??'').split(',').map(value=>value.trim());
  const raw = env.APP_PRODUCTS_APP_ORIGIN || origins[0];
  let app:URL;
  try{app=new URL(raw!);}catch{throw unavailable();}
  const local=['test','development'].includes(env.APP_ENV??'development');
  const loopback=app.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(app.hostname);
  if(app.origin!==raw||!origins.includes(app.origin)||app.username||app.password||(!local&&app.origin!=='https://app.techlyup.com')||(app.protocol!=='https:'&&!(local&&loopback)))throw unavailable();
  const destinations=Object.fromEntries(productIds.map(id=>[id,`https://${id}.techlyup.com`])) as Record<ProductId,string>;
  if(env.APP_PRODUCTS_LOCAL_ORIGINS){
    if(!local)throw unavailable();
    let overrides:unknown;try{overrides=JSON.parse(env.APP_PRODUCTS_LOCAL_ORIGINS);}catch{throw unavailable();}
    if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw unavailable();
    for(const [key,value] of Object.entries(overrides)){
      if(!productIds.includes(key as ProductId)||typeof value!=='string')throw unavailable();
      let origin:URL;try{origin=new URL(value);}catch{throw unavailable();}
      if(origin.origin!==value||origin.username||origin.password||origin.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.port!==String(18921+productIds.indexOf(key as ProductId)))throw unavailable();
      destinations[key as ProductId]=origin.origin;
    }
  }
  return {db:database(env),appOrigin:app.origin,destinations,tenantId:env.TECHLYUP_ERP_ORG_ID};
}
export function productCaller(env:Env,props:ProductBindingProps|undefined){
  const setup=productConfiguration(env);
  const appId=productIds.find(id=>props?.clientId===`techlyup-${id}`);
  if(!appId||props?.product!=='techlyup'||props?.tenantId!==setup.tenantId)throw new ApiError('product_caller_denied','This app is not authorized to use TechlyUp accounts.',403);
  return {...setup,appId,clientId:`techlyup-${appId}`};
}
function returnPath(value:unknown){
  if(value===undefined)return '/';
  if(typeof value!=='string'||value.length>300||!value.startsWith('/')||value.startsWith('//')||value.startsWith('/api/')||/[\\\s\u0000-\u001f]/.test(value))throw new ApiError('product_return_invalid','Choose a page inside this app.',422);
  let decoded:string;try{decoded=decodeURIComponent(value);}catch{throw new ApiError('product_return_invalid','Choose a page inside this app.',422);}
  if(decoded.startsWith('//')||/[\\\s\u0000-\u001f]/.test(decoded))throw new ApiError('product_return_invalid','Choose a page inside this app.',422);
  return value;
}
async function s256(verifier:string){return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}

export async function beginProductLogin(env:Env,props:ProductBindingProps|undefined,raw:{pkceChallenge:string;returnPath?:string}){
  const {db,appId,clientId,appOrigin}=productCaller(env,props);
  const input=z.object({pkceChallenge:challengeSchema,returnPath:z.string().optional()}).strict().parse(raw);
  const next=returnPath(input.returnPath),at=clock();
  await rateLimit(db,'product-login-begin',clientId,600,600);
  const id=crypto.randomUUID(),expiresAt=new Date(Date.now()+300000).toISOString();
  await db.prepare('INSERT INTO app_product_login_challenges(id,app_id,client_id,pkce_challenge,return_path,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,appId,clientId,input.pkceChallenge,next,expiresAt,at).run();
  return {challengeId:id,expiresAt,authorizeUrl:`${appOrigin}/products/sign-in?challengeId=${id}`};
}
interface ChallengeRow {id:string;app_id:ProductId;client_id:string;return_path:string;expires_at:string;authorized_account_id:string|null}
async function challenge(env:Env,id:string,identity:Identity){
  const setup=productConfiguration(env),valid=z.uuid().parse(id),at=clock();
  const row=await setup.db.prepare('SELECT id,app_id,client_id,return_path,expires_at,authorized_account_id FROM app_product_login_challenges WHERE id=? AND expires_at>? AND consumed_at IS NULL AND attempts<5').bind(valid,at).first<ChallengeRow>();
  if(!row||!productIds.includes(row.app_id)||row.client_id!==`techlyup-${row.app_id}`||row.authorized_account_id&&row.authorized_account_id!==identity.user.id)throw invalidCode();
  return {...setup,row};
}
export async function productLoginRequest(env:Env,identity:Identity,id:string){
  const {row,destinations}=await challenge(env,id,identity);
  return {appId:row.app_id,appName:names[row.app_id],appOrigin:destinations[row.app_id],expiresAt:row.expires_at,returnPath:row.return_path};
}
export async function authorizeProductLogin(env:Env,identity:Identity,id:string){
  const {db,row,destinations}=await challenge(env,id,identity),at=clock(),code=randomHex();
  const changed=await db.prepare(`UPDATE app_product_login_challenges SET authorized_account_id=?,authorized_session_id=?,code_hash=?,authorized_at=? WHERE id=? AND client_id=? AND expires_at>? AND consumed_at IS NULL AND attempts<5 AND (authorized_account_id IS NULL OR authorized_account_id=?)`).bind(identity.user.id,identity.sessionId,await hash(code),at,row.id,row.client_id,at,identity.user.id).run();
  if(changed.meta.changes!==1)throw invalidCode();
  const redirect=new URL('/api/auth/callback',destinations[row.app_id]);
  redirect.searchParams.set('challengeId',row.id);redirect.searchParams.set('code',code);
  return {redirectUrl:redirect.href,appName:names[row.app_id],accountDisplay:identity.user.name};
}

type CanonicalRow=Identity['account']&{canonical_session_id:string;password_fingerprint:string;canonical_expires_at:string};
export async function consumeProductLogin(env:Env,props:ProductBindingProps|undefined,raw:{challengeId:string;code:string;verifier:string}):Promise<ProductSessionResult>{
  const {db,appId,clientId,tenantId}=productCaller(env,props);
  const input=z.object({challengeId:z.uuid(),code:z.string().regex(/^[a-f0-9]{64}$/),verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)}).strict().parse(raw),at=clock();
  const row=await db.prepare(`SELECT a.*,s.id AS canonical_session_id,s.password_fingerprint,s.expires_at AS canonical_expires_at,c.pkce_challenge,c.code_hash,c.return_path FROM app_product_login_challenges c JOIN learner_accounts a ON a.id=c.authorized_account_id JOIN app_sessions s ON s.id=c.authorized_session_id WHERE c.id=? AND c.app_id=? AND c.client_id=? AND c.expires_at>? AND c.consumed_at IS NULL AND c.attempts<5 AND s.account_id=a.id AND s.revoked_at IS NULL AND s.expires_at>?`).bind(input.challengeId,appId,clientId,at,at).first<CanonicalRow&{pkce_challenge:string;code_hash:string;return_path:string}>();
  const codeHash=await hash(input.code);
  if(!row||row.code_hash!==codeHash||row.pkce_challenge!==await s256(input.verifier)||row.password_fingerprint!==await hash(row.password_hash)){
    await db.prepare('UPDATE app_product_login_challenges SET attempts=MIN(attempts+1,5) WHERE id=? AND app_id=? AND client_id=? AND consumed_at IS NULL').bind(input.challengeId,appId,clientId).run();
    throw invalidCode();
  }
  const sessionId=crypto.randomUUID(),sessionToken=`tlu_p_${randomHex()}`,tokenHash=await hash(sessionToken),expiresAt=new Date(Math.min(Date.parse(row.canonical_expires_at),Date.now()+86400000)).toISOString();
  const result=await db.batch([
    db.prepare('UPDATE app_product_login_challenges SET consumed_at=?,product_session_id=? WHERE id=? AND app_id=? AND client_id=? AND consumed_at IS NULL AND code_hash=? AND attempts<5 AND expires_at>?').bind(at,sessionId,input.challengeId,appId,clientId,codeHash,at),
    db.prepare('INSERT INTO app_product_sessions(id,app_id,token_hash,account_id,canonical_session_id,created_at,expires_at) SELECT ?,?,?,?,?,?,? FROM app_product_login_challenges WHERE id=? AND product_session_id=? AND consumed_at=?').bind(sessionId,appId,tokenHash,row.id,row.canonical_session_id,at,expiresAt,input.challengeId,sessionId,at),
    db.prepare("INSERT INTO app_audit_events(id,account_id,session_id,action,request_id,created_at) SELECT ?,?,?,'auth.login',?,? FROM app_product_sessions WHERE id=? AND token_hash=?").bind(crypto.randomUUID(),row.id,row.canonical_session_id,sessionId,at,sessionId,tokenHash),
  ]);
  if(result[0]?.meta.changes!==1||result[1]?.meta.changes!==1)throw invalidCode();
  return {sessionToken,expiresAt,user:productUser(await userProfile(db,tenantId,row)),returnPath:row.return_path};
}
async function currentProductSession(env:Env,props:ProductBindingProps|undefined,raw:{sessionToken:string}){
  const setup=productCaller(env,props),input=z.object({sessionToken:tokenSchema}).strict().parse(raw),at=clock();
  const row=await setup.db.prepare(`SELECT a.*,s.id AS canonical_session_id,s.password_fingerprint,s.expires_at AS canonical_expires_at,p.expires_at AS product_expires_at FROM app_product_sessions p JOIN app_sessions s ON s.id=p.canonical_session_id AND s.account_id=p.account_id JOIN learner_accounts a ON a.id=p.account_id WHERE p.token_hash=? AND p.app_id=? AND p.revoked_at IS NULL AND p.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>?`).bind(await hash(input.sessionToken),setup.appId,at,at).first<CanonicalRow&{product_expires_at:string}>();
  if(!row||row.password_fingerprint!==await hash(row.password_hash))throw unauthorized();
  const user=await userProfile(setup.db,setup.tenantId,row);
  return {...setup,user,expiresAt:row.product_expires_at};
}
export async function productSession(env:Env,props:ProductBindingProps|undefined,input:{sessionToken:string}){
  const current=await currentProductSession(env,props,input);
  return {user:productUser(current.user),expiresAt:current.expiresAt};
}
export async function endProductSession(env:Env,props:ProductBindingProps|undefined,raw:{sessionToken:string}){
  const {db,appId}=productCaller(env,props),input=z.object({sessionToken:tokenSchema}).strict().parse(raw);
  await db.prepare('UPDATE app_product_sessions SET revoked_at=? WHERE app_id=? AND token_hash=? AND revoked_at IS NULL').bind(clock(),appId,await hash(input.sessionToken)).run();
  return {signedOut:true};
}
export async function productRequest(env:Env,props:ProductBindingProps|undefined,raw:ProductRequestInput):Promise<ProductRequestResult>{
  const input=z.object({sessionToken:tokenSchema,method:z.enum(['GET','POST','PATCH','PUT','DELETE']),path:z.string().min(1).max(300),body:z.unknown().optional(),idempotencyKey:z.uuid().optional()}).strict().parse(raw);
  if(!input.path.startsWith('/')||input.path.startsWith('//')||/[\\\u0000-\u0020]/.test(input.path))throw new ApiError('product_request_invalid','Choose a valid app resource.',422);
  if(input.body!==undefined){let encoded:string;try{encoded=JSON.stringify(input.body);}catch{throw new ApiError('product_request_invalid','Send valid app data.',422);}if(!encoded||new TextEncoder().encode(encoded).length>16000)throw new ApiError('body_too_large','Request is too large.',413);}
  const current=await currentProductSession(env,props,{sessionToken:input.sessionToken});
  await rateLimit(current.db,'product-request',`${current.appId}:${current.user.id}`,180,60);
  return handleStudioRequest(env,current.appId,current.user,{method:input.method,path:input.path,body:input.body,idempotencyKey:input.idempotencyKey});
}
export async function handleProductsHttp(request:Request,env:Env,requestId:string,ip:string,domain:typeof handleStudioRequest=handleStudioRequest){
  const url=new URL(request.url),path=url.pathname.replace(/\/$/,'');
  if(!['/api/v1/products/sign-in/request','/api/v1/products/sign-in/authorize','/api/v1/products/overview'].includes(path))return null;
  const {db,tenantId}=productConfiguration(env);
  await rateLimit(db,'product-login-http',ip,120,60);
  const identity=await authenticate(db,tenantId,request.headers.get('authorization'));
  if(path==='/api/v1/products/overview'&&request.method==='GET'){
    const result=await domain(env,'insights',identity.user,{method:'GET',path:'/overview'});
    return success(result.body,requestId,result.status);
  }
  if(path.endsWith('/request')&&request.method==='GET')return success(await productLoginRequest(env,identity,z.uuid().parse(url.searchParams.get('challengeId'))),requestId);
  if(path.endsWith('/authorize')&&request.method==='POST'){
    const input=z.object({challengeId:z.uuid()}).strict().parse(await jsonBody(request));
    return success(await authorizeProductLogin(env,identity,input.challengeId),requestId);
  }
  throw new ApiError('method_not_allowed','This API method is not supported.',405);
}
