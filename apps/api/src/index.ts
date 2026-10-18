import { z } from 'zod';
import { analyticsSchema, loginSchema, profileSchema, signupSchema, currentPublicCatalog } from '@techlyup/contracts';
import { config, database } from './config';
import { ApiError, type Env } from './types';
import { checkOrigin, clientPlatform, failure, jsonBody, secureResponse, success } from './http';
import { authenticate, login, logout, logoutRefresh, rateLimit, refresh, signup, updateProfile } from './auth/service';
import { clientSession, refreshCookie, setRefreshCookie } from './auth/cookies';
import { cleanup } from './maintenance';
import { handleLearning } from './learning/http';
import { platformCapabilities,publicPlatformFlags } from './platform';
import { handleCrm,handleCrmPublic } from './crm/http';
import { handleVisitors,cleanVisitors } from './crm/visitors';
import { syncCanonicalCrm } from './crm/canonical-source';
import { runCrmAutomation } from './crm/automation';
import { exportAnonymousEvents } from './crm/analytics-export';
import { createCrmNotifications,handleCrmNotifications } from './crm/notifications';
import {crmStorageReady} from './crm/schema';

const refreshSchema = z.object({ refreshToken: z.string().max(100).optional() }).strict();
const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'local';

async function route(request: Request, env: Env, requestId: string, settings: ReturnType<typeof config>) {
  const path = new URL(request.url).pathname.replace(/\/$/, '');
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('origin');
    if (!origin || !settings.origins.includes(origin)) throw new ApiError('origin_denied','This app origin is not authorized.',403);
    const response = new Response(null,{status:204});
    response.headers.set('Access-Control-Allow-Methods','GET, POST, PATCH, PUT, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, X-TechlyUp-Client, Idempotency-Key');
    response.headers.set('Access-Control-Max-Age','600');
    return response;
  }
  if (path === '/api/v1/health' && request.method === 'GET') {
    if (!settings.enabled) return success({status:'disabled',enabled:false},requestId);
    const row = await database(env).prepare("SELECT count(*) AS ready FROM sqlite_master WHERE type='table' AND name IN ('learner_accounts','live_core_staff_links','webinar_erp_roles','app_sessions','app_access_tokens','app_refresh_tokens','app_audit_events','app_analytics_events','app_rate_limits')").first<{ready:number}>();
    if (row?.ready !== 9) throw new ApiError('storage_unavailable','App storage is not ready.',503);
    if(settings.crm){
      if(!await crmStorageReady(database(env)))throw new ApiError('storage_unavailable','CRM storage is not ready.',503);
    }
    return success({status:'ready',enabled:true},requestId);
  }
  if(path==='/api/v1/crm/preferences/revoke')return (await handleCrmPublic(request,env,requestId,settings))!;
  if(path==='/api/v1/crm/visitor/consent')return (await handleVisitors(request,env,requestId,settings))!;
  if (!settings.enabled) throw new ApiError('feature_disabled','The TechlyUp app API is not enabled in this environment.',503);
  const db = database(env), orgId = env.TECHLYUP_ERP_ORG_ID!;
  if(path.startsWith('/api/v1/crm/')){
    const visitorResponse=await handleVisitors(request,env,requestId,settings);
    if(visitorResponse)return visitorResponse;
    const publicResponse=await handleCrmPublic(request,env,requestId,settings);
    if(publicResponse)return publicResponse;
    const identity=await authenticate(db,orgId,request.headers.get('authorization'));
    const notificationResponse=await handleCrmNotifications(request,env,identity,requestId,settings);
    if(notificationResponse)return notificationResponse;
    return handleCrm(request,env,identity,requestId,settings);
  }
  if(path==='/api/v1/featureflags'&&request.method==='GET'){
    await rateLimit(db,'public-featureflags',clientIp(request),120,60);
    return publicPlatformFlags(env,requestId,settings);
  }
  if (path === '/api/v1/catalog' && request.method === 'GET') {
    const url = new URL(request.url), kind = url.searchParams.get('kind'), search = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (kind && !['course','webinar','mentorship','career'].includes(kind) || search.length > 100) throw new ApiError('invalid_filter','Choose a listed catalog category and shorter search.',422);
    const catalog=currentPublicCatalog();
    return success({...catalog,items:catalog.items.filter(item=>(!kind||item.kind===kind)&&(!search||`${item.title} ${item.description} ${item.category}`.toLowerCase().includes(search)))},requestId);
  }
  if (path === '/api/v1/auth/signup' && request.method === 'POST') {
    if (!settings.signup) throw new ApiError('signup_disabled','New app accounts are not enabled in this environment.',503);
    const input = signupSchema.parse(await jsonBody(request));
    await rateLimit(db,'signup-ip',clientIp(request),12);
    await rateLimit(db,'signup-email',input.email,5);
    const session = await signup(db,orgId,input,clientPlatform(request),requestId);
    const response = success(clientSession(session,request),requestId,201);
    if (clientPlatform(request)==='web') setRefreshCookie(response,request,session.refreshToken!);
    return response;
  }
  if (path === '/api/v1/auth/login' && request.method === 'POST') {
    const input = loginSchema.parse(await jsonBody(request));
    await rateLimit(db,'login-ip',clientIp(request),50);
    await rateLimit(db,'login-email',input.email,15);
    const session = await login(db,orgId,input.email,input.password,clientPlatform(request),requestId);
    const response = success(clientSession(session,request),requestId);
    if (clientPlatform(request)==='web') setRefreshCookie(response,request,session.refreshToken!);
    return response;
  }
  if (path === '/api/v1/auth/refresh' && request.method === 'POST') {
    const input = refreshSchema.parse(await jsonBody(request));
    const client = clientPlatform(request);
    if (client==='web' && input.refreshToken) throw new ApiError('invalid_request','Browser refresh uses the secure app cookie.',422);
    await rateLimit(db,'refresh-ip',clientIp(request),120);
    const token = client==='web' ? refreshCookie(request) : input.refreshToken ?? '';
    const session = await refresh(db,orgId,token,client,requestId);
    const response = success(clientSession(session,request),requestId);
    if (client==='web') setRefreshCookie(response,request,session.refreshToken!);
    return response;
  }
  if (path === '/api/v1/auth/logout' && request.method === 'POST') {
    const input = refreshSchema.parse(await jsonBody(request)), client = clientPlatform(request);
    if (client==='web' && input.refreshToken) throw new ApiError('invalid_request','Browser logout uses the secure app cookie.',422);
    await rateLimit(db,'logout-ip',clientIp(request),120);
    const token = client==='web' ? refreshCookie(request) : input.refreshToken;
    if (token) await logoutRefresh(db,token,client,requestId);
    else await logout(db,await authenticate(db,orgId,request.headers.get('authorization')),requestId);
    const response=success({signedOut:true},requestId);
    if(client==='web')setRefreshCookie(response,request,'',true);
    return response;
  }
  const protectedPaths = ['/api/v1/me','/api/v1/profile','/api/v1/admin/overview','/api/v1/events','/api/v1/platform/capabilities'];
  if (!protectedPaths.includes(path)&&!path.startsWith('/api/v1/learning/')) throw new ApiError('not_found','API route not found.',404);
  const identity = await authenticate(db,orgId,request.headers.get('authorization'));
  if(path.startsWith('/api/v1/learning/'))return handleLearning(request,env,identity,requestId,settings);
  if(path==='/api/v1/platform/capabilities'&&request.method==='GET'){
    if(!identity.user.permissions.includes('admin'))throw new ApiError('forbidden','Administrator permission is required.',403);
    await rateLimit(db,'platform-capabilities',identity.user.id,30);
    return platformCapabilities(env,requestId,settings);
  }
  if (path === '/api/v1/me' && request.method === 'GET') return success(identity.user,requestId);
  if (path === '/api/v1/profile' && request.method === 'PATCH') {
    const input = profileSchema.parse(await jsonBody(request));
    await rateLimit(db,'profile',identity.user.id,60);
    return success(await updateProfile(db,orgId,identity,input,requestId),requestId);
  }
  if (path === '/api/v1/admin/overview' && request.method === 'GET') {
    if (!identity.user.permissions.includes('admin')) throw new ApiError('forbidden','Administrator permission is required.',403);
    await rateLimit(db,'admin-overview',identity.user.id,60);
    const row=await db.prepare(`SELECT (SELECT count(*) FROM learner_accounts) AS accounts,
      (SELECT count(*) FROM app_sessions WHERE client IN ('ios','android') AND revoked_at IS NULL AND expires_at>?) AS nativeSessions,
      (SELECT count(*) FROM app_audit_events) AS auditEvents`).bind(new Date().toISOString()).first<{accounts:number;nativeSessions:number;auditEvents:number}>();
    if(!row)throw new ApiError('storage_unavailable','Verified administrator counts are unavailable.',503);
    return success(row,requestId);
  }
  if (path === '/api/v1/events' && request.method === 'POST') {
    if(!settings.analytics)throw new ApiError('feature_disabled','App analytics are not enabled in this environment.',503);
    const input=analyticsSchema.parse(await jsonBody(request));
    await rateLimit(db,'analytics',identity.user.id,120,60);
    await db.prepare('INSERT INTO app_analytics_events(id,account_id,event,screen,item_kind,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),identity.user.id,input.event,input.screen,input.itemKind??null,new Date().toISOString()).run();
    return success({accepted:true},requestId,202);
  }
  throw new ApiError('method_not_allowed','This API method is not supported.',405);
}

export async function fetch(request: Request, env: Env): Promise<Response> {
  if (!new URL(request.url).pathname.startsWith('/api/')) {
    if(env.APP_ENV==='production'&&new URL(request.url).protocol!=='https:')return new Response('HTTPS is required.',{status:403});
    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options','nosniff');
      headers.set('Referrer-Policy','strict-origin-when-cross-origin');
      headers.set('Content-Security-Policy',"frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      if(new URL(request.url).protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
      return new Response(response.body,{status:response.status,headers});
    }
    return new Response('TechlyUp app assets have not been built.',{status:503});
  }
  const requestId=crypto.randomUUID();let origins:string[]=[];
  try {
    const settings=config(env);origins=settings.origins;
    const relay = ['/api/v1/crm/webhooks/relay','/api/v1/crm/delivery/authorize'].includes(new URL(request.url).pathname) && request.method === 'POST';
    if(relay){
      if(settings.mode==='production'&&new URL(request.url).protocol!=='https:')throw new ApiError('https_required','Use the secure TechlyUp app address.',403);
    } else checkOrigin(request,settings);
    return secureResponse(await route(request,env,requestId,settings),request,origins);
  }catch(error){return secureResponse(failure(error,requestId),request,origins);}
}
export async function scheduled(_event: unknown, env: Env) {
  await cleanup(env);
  const settings=config(env);
  if(settings.crm){
    await syncCanonicalCrm(env);
    await createCrmNotifications(env);
    await runCrmAutomation(env);
    await cleanVisitors(env);
    await exportAnonymousEvents(env);
  }
}
export default { fetch, scheduled };
