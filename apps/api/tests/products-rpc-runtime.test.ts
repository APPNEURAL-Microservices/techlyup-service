import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {seededCode,signupInput} from './fixture';

test('real workerd product RPC completes app-bound PKCE and rechecks the parent session',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const bundled=await build({stdin:{contents:"export {TechlyUpProducts} from './apps/api/src/products/rpc.ts';import {handleProductsHttp} from './apps/api/src/products/identity.ts';import {signup} from './apps/api/src/auth/service.ts';export default {async fetch(r,e){try{if(new URL(r.url).pathname==='/fixture/signup')return Response.json(await signup(e.REGISTRATIONS_DB,'appneural',await r.json(),'ios','fixture'));return await handleProductsHttp(r,e,'fixture','local')||new Response(null,{status:404});}catch(x){return Response.json({error:{code:x.code||'DENIED'}},{status:x.status||503});}}};",resolveDir:root,sourcefile:'product-login-runtime-fixture.ts'},bundle:true,write:false,format:'esm',platform:'node',target:'es2022',mainFields:['module','main'],external:['cloudflare:workers','node:*','pg-native'],banner:{js:"import { createRequire as __productCreateRequire } from 'node:module'; const require = __productCreateRequire('/worker.js');"}});
 const caller="export default {async fetch(r,e){const p=new URL(r.url).pathname,b=await r.json();if(p==='/begin')return Response.json(await e.GOOD.beginProductLogin(b));if(p==='/begin-none')return Response.json(await e.NONE.beginProductLogin(b));if(p==='/begin-wrong')return Response.json(await e.WRONG.beginProductLogin(b));if(p==='/consume')return Response.json(await e.GOOD.consumeProductLogin(b));if(p==='/consume-other')return Response.json(await e.OTHER.consumeProductLogin(b));if(p==='/session')return Response.json(await e.GOOD.productSession(b));if(p==='/session-other')return Response.json(await e.OTHER.productSession(b));if(p==='/end')return Response.json(await e.GOOD.endProductSession(b));return new Response(null,{status:404});}};";
 const good={clientId:'techlyup-courses',product:'techlyup',tenantId:'appneural'};
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'canonical-products',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-13',compatibilityFlags:['nodejs_compat'],d1Databases:{REGISTRATIONS_DB:'product-login-local'},bindings:{APP_ENV:'test',APP_ENABLED:'true',APP_PRODUCTS_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_ALLOWED_ORIGINS:'https://app.example.test',TECHLYUP_ERP_ORG_ID:'appneural'}},
  {name:'frontend-products',modules:true,script:caller,compatibilityDate:'2026-10-13',serviceBindings:{GOOD:{name:'canonical-products',entrypoint:'TechlyUpProducts',props:good},OTHER:{name:'canonical-products',entrypoint:'TechlyUpProducts',props:{...good,clientId:'techlyup-earnings'}},NONE:{name:'canonical-products',entrypoint:'TechlyUpProducts'},WRONG:{name:'canonical-products',entrypoint:'TechlyUpProducts',props:{...good,tenantId:'foreign'}}}},
 ]}));
 try{
  const db=await mf.getD1Database('REGISTRATIONS_DB','canonical-products'),schema=new DatabaseSync(':memory:');
  try{
   schema.exec(readFileSync(root+'apps/api/tests/fixtures/canonical.sql','utf8'));
   for(const name of ['0047_native_app_foundation.sql','0054_account_registration_live_login.sql','0055_passwordless_registration.sql','0056_live_passcodes.sql','0057_products_login.sql'])schema.exec(readFileSync(root+'migrations/d1/'+name,'utf8'));
   const objects=schema.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all() as {type:string;name:string;sql:string}[];
   for(const item of objects)await db.prepare(item.sql).run();
   for(const item of objects.filter(value=>value.type==='table'))for(const row of schema.prepare('SELECT * FROM "'+item.name+'"').all()){
    const keys=Object.keys(row);await db.prepare('INSERT INTO "'+item.name+'"('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>row[key])).run();
   }
  }finally{schema.close();}
  const issued=seededCode('products-runtime@example.invalid');await db.prepare(issued.sql).run();
  const session=await mf.dispatchFetch('https://app.example.test/fixture/signup',{method:'POST',body:JSON.stringify({...signupInput,firstName:'Product',lastName:'Teacher',email:'products-runtime@example.invalid',phone:'+919876543210',accountType:'teacher',teacherRole:'academic',challengeId:issued.challengeId,code:issued.code,interestIds:[]})}).then(r=>r.json()) as any;
  assert.match(session.accessToken,/^tlu_a_/);
  const frontend=await mf.getWorker('frontend-products');
  const call=(path:string,body:unknown)=>frontend.fetch('https://fixture.test'+path,{method:'POST',body:JSON.stringify(body)}).then(r=>r.json()) as Promise<any>;
  const verifier='v'.repeat(43),pkceChallenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
  for(const path of ['/begin-none','/begin-wrong']){const denied=await call(path,{pkceChallenge});assert.equal(denied.ok,false);assert.equal(denied.error.code,'product_caller_denied');}
  const begun=await call('/begin',{pkceChallenge,returnPath:'/curriculum'});assert.equal(begun.ok,true);
  const metadata=await mf.dispatchFetch('https://app.example.test/api/v1/products/sign-in/request?challengeId='+begun.data.challengeId,{headers:{authorization:'Bearer '+session.accessToken}}).then(r=>r.json()) as any;
  assert.equal(metadata.data.appName,'Courses');assert.equal(metadata.data.appOrigin,'https://courses.techlyup.com');
  const approved=await mf.dispatchFetch('https://app.example.test/api/v1/products/sign-in/authorize',{method:'POST',headers:{authorization:'Bearer '+session.accessToken,'content-type':'application/json'},body:JSON.stringify({challengeId:begun.data.challengeId})}).then(r=>r.json()) as any;
  const redirect=new URL(approved.data.redirectUrl);assert.equal(redirect.origin,'https://courses.techlyup.com');
  const input={challengeId:begun.data.challengeId,code:redirect.searchParams.get('code'),verifier};
  assert.equal((await call('/consume-other',input)).ok,false);
  const signed=await call('/consume',input);assert.equal(signed.ok,true);assert.equal(signed.data.user.id,session.user.id);assert.equal(signed.data.returnPath,'/curriculum');
  const replay=await call('/consume',input);assert.equal(replay.error.code,'product_login_code_invalid');assert.equal(replay.error.status,409);
  const token={sessionToken:signed.data.sessionToken};assert.equal((await call('/session',token)).ok,true);assert.equal((await call('/session-other',token)).error.code,'product_session_invalid');
  await db.prepare('UPDATE app_sessions SET revoked_at=? WHERE account_id=?').bind(new Date().toISOString(),session.user.id).run();
  const revoked=await call('/session',token);assert.equal(revoked.error.code,'product_session_invalid');assert.equal(revoked.error.status,401);
  assert.deepEqual(await call('/end',token),{ok:true,data:{signedOut:true}});
 }finally{await mf.dispose();}
});
