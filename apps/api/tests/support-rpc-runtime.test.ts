import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

test('real workerd RPC trusts deployment binding props, rejects forged/missing caller context and keeps named financial entrypoints off public HTTP',async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const bundled=await build({stdin:{contents:"export {TechlyUpSupport,TechlyUpFunding} from './apps/api/src/credits/rpc.ts';import {handleSupportHttp} from './apps/api/src/credits/http.ts';export default {async fetch(r,e){try{return await handleSupportHttp(r,e,'fixture')||new Response(null,{status:404});}catch(x){return Response.json({error:{code:x.code||'DENIED'}},{status:x.status||503});}}};",resolveDir:root,sourcefile:'support-runtime-fixture.ts'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',mainFields:['module','main'],external:['cloudflare:workers','node:*']});
 const caller=`export default {async fetch(r,e){const path=new URL(r.url).pathname;try{if(path==='/catalog')return Response.json(await e.GOOD.catalog());if(path==='/missing')return Response.json(await e.NONE.catalog());if(path==='/wrong')return Response.json(await e.WRONG.catalog());if(path==='/begin')return Response.json(await e.GOOD.beginLink(await r.json()));if(path==='/fund-denied'){try{await e.FUND_WRONG.readCapture('00000000-0000-4000-8000-000000000001');return Response.json({denied:false});}catch{return Response.json({denied:true});}}return new Response(null,{status:404});}catch{return Response.json({failed:true});}}};`;
 const good={clientId:'techlyup-live',product:'techlyup',tenantId:'appneural'};
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[
  {name:'canonical',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-13',compatibilityFlags:['nodejs_compat'],d1Databases:{REGISTRATIONS_DB:'support-rpc-local'},bindings:{APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_ALLOWED_ORIGINS:'https://app.example.test',TECHLYUP_ERP_ORG_ID:'appneural',APP_SUPPORT_CREDITS_ENABLED:'true',APP_SUPPORT_TEST_PAYMENTS_ENABLED:'false',SUPPORT_EXPECTED_CLIENT_ID:'techlyup-live',SUPPORT_LEARNER_ISSUER:'techlyup-learners',SUPPORT_PUBLIC_ORIGIN:'https://app.example.test'}},
  {name:'frontend',modules:true,script:caller,compatibilityDate:'2026-10-13',serviceBindings:{GOOD:{name:'canonical',entrypoint:'TechlyUpSupport',props:good},NONE:{name:'canonical',entrypoint:'TechlyUpSupport'},WRONG:{name:'canonical',entrypoint:'TechlyUpSupport',props:{...good,clientId:'unapproved'}},FUND_WRONG:{name:'canonical',entrypoint:'TechlyUpFunding',props:good}}},
 ]}));
 try{
  const db=await mf.getD1Database('REGISTRATIONS_DB','canonical'),schema=new DatabaseSync(':memory:');
  try{schema.exec(readFileSync(root+'apps/api/tests/fixtures/canonical.sql','utf8'));for(const name of ['0047_native_app_foundation.sql','0052_support_credits.sql'])schema.exec(readFileSync(root+'migrations/d1/'+name,'utf8'));
   const objects=schema.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all() as {type:string;name:string;sql:string}[];for(const item of objects)await db.prepare(item.sql).run();
   for(const item of objects.filter(v=>v.type==='table')){const rows=schema.prepare('SELECT * FROM "'+item.name+'"').all();for(const row of rows){const keys=Object.keys(row);await db.prepare('INSERT INTO "'+item.name+'"('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(k=>row[k])).run();}}
  }finally{schema.close();}
  const frontend=await mf.getWorker('frontend');
  const goodReply=await frontend.fetch('https://fixture.test/catalog').then(r=>r.json()) as any;assert.equal(goodReply.ok,true);assert.equal(goodReply.data.mode,'TEST');assert.equal(goodReply.data.packs[0].pricePaise,10000);
  for(const route of ['/missing','/wrong']){const r=await frontend.fetch('https://fixture.test'+route).then(r=>r.json()) as any;assert.equal(r.ok,false);assert.equal(r.error.code,'support_caller_denied');}
  assert.equal((await frontend.fetch('https://fixture.test/fund-denied').then(r=>r.json()) as any).denied,true);
  const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('v'.repeat(43)))).toString('base64url');
  const begun=await frontend.fetch('https://fixture.test/begin',{method:'POST',body:JSON.stringify({liveSubject:'live-fixture',sessionBinding:'a'.repeat(64),pkceChallenge:challenge,props:{...good,clientId:'forged'}})}).then(r=>r.json()) as any;assert.equal(begun.ok,true);assert.equal(new URL(begun.data.authorizeUrl).origin,'https://app.example.test');
  const publicDenied=await mf.dispatchFetch('https://app.example.test/api/v1/support/settleQuestion',{method:'POST',headers:{origin:'https://app.example.test','content-type':'application/json'},body:'{}'});assert.equal(publicDenied.status,404,'public HTTP must not expose privileged RPC commands');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM app_support_link_challenges').first<any>()).n,1);
 }finally{await mf.dispose();}
});
