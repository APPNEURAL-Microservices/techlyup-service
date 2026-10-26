import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const backend=fileURLToPath(new URL('../',import.meta.url));
const frontend=resolve(process.env.TECHLYUP_APPS_ROOT||resolve(backend,'../../../TechlyUp-App'));
const output=join(backend,'test-results/studio-apps-20261021');
const ids=['courses','mentorship','certificates','learners','earnings','promotion','insights','assistant'];
const appOrigin='http://127.0.0.1:8788';
// Every app is served by its own Worker through the central gateway, as in production.
const productUrls=Object.fromEntries(ids.map(id=>[id,`${appOrigin}/studio/${id}`]));
const qaSecret=randomUUID().replaceAll('-','');
const teacherPath=`/__local_qa_${qaSecret}/teacher`;
const learnerPath=`/__local_qa_${qaSecret}/learner`;
const freePort=async(port=0)=>new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>{const address=server.address();server.close(()=>resolve(address.port));});});
const buildOptions={bundle:true,write:false,format:'esm',platform:'node',target:'es2022',mainFields:['module','main'],conditions:['workerd'],external:['cloudflare:*','node:*'],banner:{js:"import { createRequire as __runtimeCreateRequire } from 'node:module'; const require = __runtimeCreateRequire('/worker.js');"}};
// Live file-backed ASSETS equivalent avoids caching stale export hashes while
// the user-facing local QA build is being rebuilt by the parent task.
const assetsFor=(directory,spa)=>async request=>{
 const address=new URL(request.url);let pathname;try{pathname=decodeURIComponent(address.pathname);}catch{return new Response(null,{status:400});}
 if(pathname.includes('\\')||pathname.split('/').includes('..'))return new Response(null,{status:403});
 const relative=pathname.replace(/^\/+/,''),candidates=relative?[relative,relative+'.html',join(relative,'index.html')]:['index.html'];
 if(spa)candidates.push('index.html');
 for(const candidate of candidates){
  const target=resolve(directory,candidate);if(!target.startsWith(resolve(directory)+'/'))continue;
  try{if(!(await stat(target)).isFile())continue;const content=await readFile(target),extension=target.split('.').pop();const mime={html:'text/html; charset=utf-8',js:'application/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml',json:'application/json',ttf:'font/ttf',png:'image/png',webp:'image/webp',ico:'image/x-icon'}[extension]||'application/octet-stream';return new Response(content,{headers:{'Content-Type':mime,'Cache-Control':'no-store'}});}catch{}
 }
 return new Response('Local exported page was not found.',{status:404});
};
let temporary,mf;
let cleanupPromise,shutdownTimer;
function cleanup(){
 if(cleanupPromise)return cleanupPromise;
 cleanupPromise=(async()=>{
  if(mf)await mf.dispose();
  if(temporary)await rm(temporary,{recursive:true,force:true});
  await writeFile(join(output,'runtime-status.json'),JSON.stringify({ready:false,stoppedAt:new Date().toISOString()},null,2),{mode:0o600});
 })();
 return cleanupPromise;
}
function requestShutdown(){
 // Referenced until asynchronous disposal, private-file removal and the stopped
 // receipt finish. Repeated signals share one cleanup promise and cannot exit early.
 shutdownTimer??=setInterval(()=>{},1000);
 cleanup().then(()=>{clearInterval(shutdownTimer);process.exit(0);},()=>{clearInterval(shutdownTimer);process.stderr.write('Owned local runtime cleanup failed; inspect its private status before retrying.\n');process.exit(1);});
}
function ownShutdownSignals(){
 // This script owns its process and explicitly disposes Miniflare. Its default
 // exit-hook force-exits synchronously on a signal, before our awaited cleanup.
 // Replace only these process signal hooks; natural-exit hooks remain installed.
 for(const signal of ['SIGTERM','SIGINT','SIGHUP']){process.removeAllListeners(signal);process.on(signal,requestShutdown);}
}
ownShutdownSignals();
try{
 await mkdir(output,{recursive:true});
 await freePort(8788);
 for(const id of ids)await stat(join(frontend,'apps',id,'dist/client/index.html'));
 await stat(join(frontend,'apps/mobile/dist/products/sign-in.html'));
 temporary=await mkdtemp('/tmp/techlyup-studio-browser-');
 const wrapper=`
export {TechlyUpProducts} from './apps/api/src/products/rpc.ts';
import central from './apps/api/src/index.ts';
import {hash,randomHex} from './apps/api/src/auth/crypto.ts';
import {StudioRepository} from './apps/api/src/studio/repository.ts';
export default {async fetch(request,env,ctx){
 const path=new URL(request.url).pathname;
 if(path===${JSON.stringify('/__local_qa_'+qaSecret+'/diagnose')}){
  try{await new StudioRepository(env.STUDIO_DB).ready();return Response.json({ready:true});}
  catch(error){return Response.json({error:{name:error.name,code:error.code}});}
 }
 if(path===${JSON.stringify(teacherPath)}||path===${JSON.stringify(learnerPath)}){
  if(env.APP_ENV!=='test'||new URL(request.url).hostname!=='127.0.0.1')return new Response(null,{status:404});
  const teacher=path===${JSON.stringify(teacherPath)};
  const email=teacher?'studio-browser-teacher@example.invalid':'studio-browser-learner@example.invalid';
  const existing=await env.REGISTRATIONS_DB.prepare('SELECT id FROM learner_accounts WHERE email=?').bind(email).first();
  const challengeId='otp_'+crypto.randomUUID().replaceAll('-',''),code=String(100000+crypto.getRandomValues(new Uint32Array(1))[0]%900000),purpose=existing?'login':'signup';
  await env.REGISTRATIONS_DB.prepare('INSERT INTO app_email_otp_challenges(id,purpose,email_hash,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(challengeId,purpose,await hash(email),await hash(challengeId+':'+code),new Date(Date.now()+300000).toISOString(),new Date().toISOString()).run();
  const body=existing?{email,challengeId,code}:{firstName:'Synthetic',lastName:teacher?'Studio Teacher':'Studio Learner',email,phone:'+919876543210',accountType:teacher?'teacher':'student',...(teacher?{teacherRole:'academic'}:{}),city:'Jaipur',preferredLanguage:'en',interestIds:[],ageGroup:'adult',updatesConsent:false,consent:true,consentVersion:'2026-10-21',challengeId,code};
  const signupRequest=new Request(${JSON.stringify(appOrigin)}+'/api/v1/auth/'+(existing?'otp/login':'signup'),{method:'POST',headers:{origin:${JSON.stringify(appOrigin)},'x-techlyup-client':'web','content-type':'application/json'},body:JSON.stringify(body)});
  const response=await central.fetch(signupRequest,env,ctx);
  if(!response.ok)return new Response('Local fixture sign-in unavailable.',{status:503});
  const headers=new Headers({Location:'/', 'Cache-Control':'no-store'});for(const value of response.headers.getSetCookie())headers.append('Set-Cookie',value);
  return new Response(null,{status:303,headers});
 }
 return central.fetch(request,env,ctx);
}};
`;
 const central=(await build({...buildOptions,stdin:{contents:wrapper,resolveDir:backend,sourcefile:'studio-local-qa.ts'}})).outputFiles[0].text;
 const workerScripts=await Promise.all(ids.map(async id=>({id,script:(await build({...buildOptions,entryPoints:[join(frontend,'apps',id,'server/worker.ts')],absWorkingDir:frontend})).outputFiles[0].text})));
 const studioBindings=Object.fromEntries(ids.map(id=>['STUDIO_'+id.toUpperCase(),{name:`studio-${id}`}]));
 const workers=[{name:'studio-canonical',modules:true,script:central,compatibilityDate:'2026-10-13',compatibilityFlags:['nodejs_compat'],unsafeDirectSockets:[{host:'127.0.0.1',port:8788}],d1Databases:{REGISTRATIONS_DB:'studio-qa-only',STUDIO_DB:'studio-drafts-qa-only'},bindings:{APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_PRODUCTS_ENABLED:'true',APP_PRODUCTS_APP_ORIGIN:appOrigin,APP_ANALYTICS_ENABLED:'false',APP_LEARNING_ENABLED:'false',APP_CRM_ENABLED:'false',TECHLYUP_ERP_ORG_ID:'appneural',APP_ALLOWED_ORIGINS:appOrigin},serviceBindings:{ASSETS:assetsFor(join(frontend,'apps/mobile/dist'),false),...studioBindings}},...workerScripts.map(({id,script})=>({name:`studio-${id}`,modules:true,script,compatibilityDate:'2026-10-13',compatibilityFlags:['nodejs_compat'],bindings:{APP_ENV:'test',PRODUCT_ENABLED:'true'},serviceBindings:{ASSETS:assetsFor(join(frontend,'apps',id,'dist/client'),true),TECHLYUP_PRODUCTS:{name:'studio-canonical',entrypoint:'TechlyUpProducts',props:{clientId:`techlyup-${id}`,product:'techlyup',tenantId:'appneural'}}}}))];
 mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,log:new Log(LogLevel.ERROR),workers}));
 ownShutdownSignals();
 await mf.ready;
 const studio=await mf.getD1Database('STUDIO_DB','studio-canonical'),studioSchema=new DatabaseSync(':memory:');
 try{
  studioSchema.exec(await readFile(join(backend,'migrations/studio/0001_studio_workspace.sql'),'utf8'));
  for(const object of studioSchema.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all())await studio.prepare(object.sql).run();
 }finally{studioSchema.close();}
 const db=await mf.getD1Database('REGISTRATIONS_DB','studio-canonical'),schema=new DatabaseSync(':memory:');
 try{
  schema.exec(await readFile(join(backend,'apps/api/tests/fixtures/canonical.sql'),'utf8'));
  for(const file of ['0047_native_app_foundation.sql','0054_account_registration_live_login.sql','0055_passwordless_registration.sql','0056_live_passcodes.sql','0057_products_login.sql'])schema.exec(await readFile(join(backend,'migrations/d1',file),'utf8'));
  const objects=schema.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all();
  for(const object of objects)await db.prepare(object.sql).run();
  for(const object of objects.filter(value=>value.type==='table'))for(const row of schema.prepare('SELECT * FROM "'+object.name+'"').all()){
   const keys=Object.keys(row);await db.prepare('INSERT INTO "'+object.name+'"('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>row[key])).run();
  }
 }finally{schema.close();}
 const healthResponse=await fetch(appOrigin+'/api/v1/health');
 if(!healthResponse.headers.get('content-type')?.includes('application/json'))throw new Error('private_fixture_health_nonjson_'+healthResponse.status);
 const health=await healthResponse.json();
 if(health.data?.status!=='ready')throw new Error('private_fixture_health_failed');
 await writeFile(join(output,'runtime-status.json'),JSON.stringify({ready:true,appOrigin,productUrls,qaTeacherUrl:appOrigin+teacherPath,qaLearnerUrl:appOrigin+learnerPath,diagnosticUrl:appOrigin+'/__local_qa_'+qaSecret+'/diagnose',pid:process.pid,startedAt:new Date().toISOString(),storage:'isolated-miniflare-d1',storageDirectory:temporary,d1:'isolated-miniflare'},null,2),{mode:0o600});
 process.stdout.write('Local Studio runtime ready: central 8788 with eight apps at /studio/<app>; private fixture URLs saved in runtime-status.json.\n');
 await new Promise(()=>{});
}catch(error){
 process.stderr.write('Local Studio runtime could not start: '+(error?.code||error?.message||'sanitized_failure')+'\n');
 await cleanup();process.exit(1);
}
