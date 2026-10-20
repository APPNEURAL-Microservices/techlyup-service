import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

test('real workerd TechlyUpIdentity RPC trusts only deployment binding props and completes one PKCE sign-in',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const bundled=await build({stdin:{contents:"export {TechlyUpIdentity} from './apps/api/src/live/rpc.ts';import {handleLiveLoginHttp} from './apps/api/src/live/login.ts';import {signup} from './apps/api/src/auth/service.ts';export default {async fetch(r,e){try{if(new URL(r.url).pathname==='/fixture/signup')return Response.json(await signup(e.REGISTRATIONS_DB,'appneural',await r.json(),'ios','fixture'));return await handleLiveLoginHttp(r,e,'fixture','local')||new Response(null,{status:404});}catch(x){return Response.json({error:{code:x.code||'DENIED'}},{status:x.status||503});}}};",resolveDir:root,sourcefile:'live-login-runtime-fixture.ts'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',mainFields:['module','main'],external:['cloudflare:workers','node:*']});
 const caller="export default {async fetch(r,e){const path=new URL(r.url).pathname,body=await r.json();if(path==='/begin')return Response.json(await e.GOOD.beginLiveLogin(body));if(path==='/begin-none')return Response.json(await e.NONE.beginLiveLogin(body));if(path==='/begin-wrong')return Response.json(await e.WRONG.beginLiveLogin(body));if(path==='/consume')return Response.json(await e.GOOD.consumeLiveLogin(body));return new Response(null,{status:404});}};";
 const good={clientId:'techlyup-live',product:'techlyup',tenantId:'appneural'};
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'canonical',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-13',compatibilityFlags:['nodejs_compat'],d1Databases:{REGISTRATIONS_DB:'live-login-local'},bindings:{APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_ALLOWED_ORIGINS:'https://app.example.test',TECHLYUP_ERP_ORG_ID:'appneural',APP_LIVE_LOGIN_ENABLED:'true',LIVE_LOGIN_CLIENT_ID:'techlyup-live',LIVE_LOGIN_APP_ORIGIN:'https://app.example.test',LIVE_LOGIN_CALLBACK_URL:'https://live.example.test/api/auth/techlyup/callback'}},
  {name:'frontend',modules:true,script:caller,compatibilityDate:'2026-10-13',serviceBindings:{GOOD:{name:'canonical',entrypoint:'TechlyUpIdentity',props:good},NONE:{name:'canonical',entrypoint:'TechlyUpIdentity'},WRONG:{name:'canonical',entrypoint:'TechlyUpIdentity',props:{...good,clientId:'unapproved'}}}},
 ]}));
 try{
  const db=await mf.getD1Database('REGISTRATIONS_DB','canonical'),schema=new DatabaseSync(':memory:');
  try{schema.exec(readFileSync(root+'apps/api/tests/fixtures/canonical.sql','utf8'));for(const name of ['0047_native_app_foundation.sql','0054_account_registration_live_login.sql'])schema.exec(readFileSync(root+'migrations/d1/'+name,'utf8'));
   const objects=schema.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all() as {type:string;name:string;sql:string}[];for(const item of objects)await db.prepare(item.sql).run();
   for(const item of objects.filter(v=>v.type==='table')){const rows=schema.prepare('SELECT * FROM "'+item.name+'"').all();for(const row of rows){const keys=Object.keys(row);await db.prepare('INSERT INTO "'+item.name+'"('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(k=>row[k])).run();}}
  }finally{schema.close();}
  const session=await mf.dispatchFetch('https://app.example.test/fixture/signup',{method:'POST',body:JSON.stringify({firstName:'Runtime',lastName:'Teacher',email:'runtime@example.invalid',password:'a private runtime password 123',phone:'+919876543210',accountType:'teacher',city:'Jaipur',consent:true,consentVersion:'2026-10'})}).then(r=>r.json()) as any;
  assert.match(session.accessToken,/^tlu_a_/);assert.equal(session.user.registration.accountType,'teacher');
  const frontend=await mf.getWorker('frontend');
  const verifier='v'.repeat(43),pkceChallenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  for(const route of ['/begin-none','/begin-wrong']){const denied=await frontend.fetch('https://fixture.test'+route,{method:'POST',body:JSON.stringify({pkceChallenge})}).then(r=>r.json()) as any;assert.equal(denied.ok,false);assert.equal(denied.error.code,'live_login_caller_denied');}
  const begun=await frontend.fetch('https://fixture.test/begin',{method:'POST',body:JSON.stringify({pkceChallenge})}).then(r=>r.json()) as any;
  assert.equal(begun.ok,true);assert.equal(begun.data.authorizeUrl,'https://app.example.test/live/sign-in?challengeId='+begun.data.challengeId);
  const approved=await mf.dispatchFetch('https://app.example.test/api/v1/live/sign-in/authorize',{method:'POST',headers:{authorization:'Bearer '+session.accessToken,'content-type':'application/json'},body:JSON.stringify({challengeId:begun.data.challengeId})}).then(r=>r.json()) as any;
  const redirect=new URL(approved.data.redirectUrl);assert.equal(redirect.origin,'https://live.example.test');
  const input={challengeId:begun.data.challengeId,code:redirect.searchParams.get('code'),verifier};
  const identity=await frontend.fetch('https://fixture.test/consume',{method:'POST',body:JSON.stringify(input)}).then(r=>r.json()) as any;
  assert.deepEqual(identity,{ok:true,data:{accountId:session.user.id,email:'runtime@example.invalid',name:'Runtime Teacher',emailVerified:false,accountType:'teacher'}});
  const replay=await frontend.fetch('https://fixture.test/consume',{method:'POST',body:JSON.stringify(input)}).then(r=>r.json()) as any;
  assert.equal(replay.ok,false);assert.equal(replay.error.code,'live_login_code_invalid');
 }finally{await mf.dispose();}
});
