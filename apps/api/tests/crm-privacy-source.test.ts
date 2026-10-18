import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixture';
import {syncCanonicalCrm} from '../src/crm/canonical-source';
import {cleanVisitors,VISITOR_POLICY} from '../src/crm/visitors';
import {exportAnonymousEvents} from '../src/crm/analytics-export';
import {CrmRepository} from '../src/crm/repository';

function setup(){const f=fixture();f.sqlite.exec(readFileSync(new URL('./fixtures/canonical-crm.sql',import.meta.url),'utf8'));for(const file of ['0048_crm_acquisition.sql','0049_crm_canonical_sources.sql','0050_crm_visitors.sql'])f.sqlite.exec(readFileSync(new URL(`../../../migrations/d1/${file}`,import.meta.url),'utf8'));f.env.APP_CRM_ENABLED='true';f.env.APP_CRM_CAPTURE_ENABLED='true';return f;}
const browser={client:'web',origin:'https://app.example.test'};
const consent={granted:true,external:false,policyVersion:VISITOR_POLICY};
const event={event:'page_view',page:'learn'};
function cookie(response:Response){return response.headers.get('set-cookie')!.split(';')[0];}
function submission(f:ReturnType<typeof setup>,id:string,payload:Record<string,unknown>,meta:Record<string,unknown>={},kind='website'){
 const at=new Date().toISOString();f.sqlite.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)').run(id,kind,JSON.stringify(payload),'new',JSON.stringify(meta),at,at);
}

test('anonymous analytics cannot store PII or events before consent; cookie is opaque and withdrawal works with app disabled',async()=>{
 const f=setup();try{
  assert.equal((await f.call('/crm/visitor/events',{...browser,body:event})).response.status,403);
  const grant=await f.call('/crm/visitor/consent',{...browser,body:consent});assert.equal(grant.response.status,201);assert.match(grant.response.headers.get('set-cookie')!,/HttpOnly.*SameSite=Strict.*Secure/);
  const current=cookie(grant.response),raw=current.split('=')[1];assert.equal(raw.length,64);assert.notEqual(f.sqlite.prepare('SELECT token_hash FROM crm_visitors').get()!.token_hash,raw);
  assert.equal((await f.call('/crm/visitor/events',{...browser,cookie:current,body:{...event,email:'secret@example.test'}})).response.status,422);
  assert.equal((await f.call('/crm/visitor/events',{...browser,cookie:current,body:event})).response.status,202);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_visitor_events').get()!.n,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()!.n,0);
  f.env.APP_ENABLED='false';f.env.APP_SIGNUP_ENABLED='false';f.env.APP_CRM_ENABLED='false';f.env.APP_CRM_CAPTURE_ENABLED='false';
  assert.equal((await f.call('/crm/visitor/consent',{...browser,cookie:current,body:{...consent,granted:false}})).response.status,200);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_visitor_events').get()!.n,0);
 }finally{f.close();}
});
test('GPC blocks optional analytics and separately refused external sharing never reaches a provider',async()=>{
 const f=setup();try{
  assert.equal((await f.call('/crm/visitor/consent',{...browser,headers:{'sec-gpc':'1'},body:consent})).response.status,409);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_visitors').get()!.n,0);
  f.env.CRM_ANALYTICS_EXPORT_ENABLED='true';f.env.CRM_POSTHOG_PROJECT_KEY='synthetic-project-not-a-secret';
  const grant=await f.call('/crm/visitor/consent',{...browser,body:consent});await f.call('/crm/visitor/events',{...browser,cookie:cookie(grant.response),body:event});
  let requests=0;await exportAnonymousEvents(f.env,async()=>{requests++;return new Response(null,{status:202});});assert.equal(requests,0);
 }finally{f.close();}
});
test('analytics exports use fixed anonymous payloads and unknown outcomes are not replayed',async()=>{
 const f=setup();try{
  f.env.CRM_ANALYTICS_EXPORT_ENABLED='true';f.env.CRM_POSTHOG_PROJECT_KEY='synthetic-project';
  const grant=await f.call('/crm/visitor/consent',{...browser,body:{...consent,external:true}});await f.call('/crm/visitor/events',{...browser,cookie:cookie(grant.response),body:event});
  let count=0;const fetcher:typeof fetch=async(url,options)=>{count++;assert.equal(String(url),'https://us.i.posthog.com/capture/');const body=JSON.parse(String(options?.body));assert.equal(body.properties.$process_person_profile,false);assert.deepEqual(Object.keys(body.properties).sort(),['$geoip_disable','$process_person_profile','distinct_id','page']);assert.equal(body.properties.page,'learn');throw new Error('synthetic uncertain outcome');};
  assert.deepEqual(await exportAnonymousEvents(f.env,fetcher),{attempted:1,accepted:0,uncertain:1});await exportAnonymousEvents(f.env,fetcher);assert.equal(count,1);
  await f.call('/crm/visitor/consent',{...browser,cookie:cookie(grant.response),body:{...consent,granted:false}});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_visitor_exports').get()!.n,0);
 }finally{f.close();}
});
test('anonymous data expires in bounded cleanup without touching contacts or canonical accounts',async()=>{
 const f=setup();try{const grant=await f.call('/crm/visitor/consent',{...browser,body:consent});await f.call('/crm/visitor/events',{...browser,cookie:cookie(grant.response),body:event});f.sqlite.prepare('UPDATE crm_visitors SET expires_at=?').run('2000-01-01T00:00:00.000Z');await cleanVisitors(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_visitors').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_visitor_events').get()!.n,0);}finally{f.close();}
});
test('canonical outbox is incremental, consent-scoped, excludes claims and safely replays a projection',async()=>{
 const f=setup();try{
  submission(f,'consented',{name:'Synthetic Contact',email:'person@example.test',consent:'true',consentVersion:'2026-09',sourcePath:'/contact'});
  submission(f,'no-consent',{name:'Never copy',email:'no@example.test'});
  submission(f,'private-claim',{name:'Private Claim',email:'claim@example.test',consent:'true',consentVersion:'2026-10',sourcePath:'/certification/request-claim'});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()!.n,0);
  assert.deepEqual(await syncCanonicalCrm(f.env),{processed:1,skipped:2,failed:0});
  const row=f.sqlite.prepare('SELECT * FROM crm_contacts').get()!;assert.equal(row.email,'person@example.test');
  assert.equal(f.sqlite.prepare('SELECT account_id FROM crm_leads').get()!.account_id,null);
  f.sqlite.prepare("UPDATE crm_canonical_outbox SET state='pending' WHERE source_id='consented'").run();await syncCanonicalCrm(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_leads').get()!.n,1);
 }finally{f.close();}
});
test('newsletter double opt-in is retained as unversioned source proof and never broadens marketing consent',async()=>{
 const f=setup();try{
  const at=new Date().toISOString();f.sqlite.prepare('INSERT INTO email_subscribers(email,name,status,unsubscribe_token,consent_at,last_requested_at) VALUES(?,?,?,?,?,?)').run('newsletter@example.test','Newsletter','pending','private-token',at,at);
  assert.deepEqual(await syncCanonicalCrm(f.env),{processed:0,skipped:1,failed:0});
  f.sqlite.prepare("UPDATE email_subscribers SET status='active',verified_at=?").run(at);assert.deepEqual(await syncCanonicalCrm(f.env),{processed:1,skipped:0,failed:0});
  const actor={orgId:f.env.TECHLYUP_ERP_ORG_ID!,accountId:null,requestId:'synthetic-newsletter'},repo=new CrmRepository(f.db);const lead=(await repo.listLeads(actor,{})).leads[0];
  assert.equal(lead.accountId,null);assert.equal((await repo.eligibility(actor,lead.id,'email','marketing')).eligible,false);
  const events=f.sqlite.prepare('SELECT event_key,source_id FROM crm_canonical_outbox').all();assert.equal(JSON.stringify(events).includes('newsletter@example.test'),false);
 }finally{f.close();}
});
