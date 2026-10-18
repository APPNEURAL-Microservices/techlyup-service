/** Negative contracts over actual API handlers and complete isolated canonical
 * schema. Role grants are synthetic and never sent to staging or production. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,account} from '../../apps/api/tests/fixture';

test('visitor, learner, mentor, instructor, organizer, support and foreign organization admin cannot gain CRM or global admin authority',async()=>{
 const f=fixture({fullCanonical:true,crm:true});f.env.APP_CRM_ENABLED='true';f.env.APP_CRM_CAPTURE_ENABLED='true';
 try{
  assert.equal((await f.call('/crm/leads')).response.status,401);assert.equal((await f.call('/admin/overview')).response.status,401);
  const cases=[{name:'learner'},{name:'mentor',functional:'mentor'},{name:'instructor',functional:'teacher'},{name:'organizer',functional:'host'},{name:'support',functional:'support'},{name:'organization-admin',actorRole:'admin',org:'unrelated-organization'}];
  for(const item of cases){
   const session=(await account(f,'ios',`synthetic-negative-${item.name}@example.invalid`)).body.data;
   if(item.functional||item.actorRole){const now=new Date().toISOString(),actorId=`synthetic:${session.user.id}`;f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(session.user.id,item.org??'appneural',actorId,item.actorRole??'member',session.user.email,'Synthetic role test','2099-01-01T00:00:00.000Z','isolated-test',now,now);if(item.functional)f.sqlite.prepare('INSERT INTO webinar_erp_roles VALUES(?,?,?,?)').run(item.org??'appneural',actorId,item.functional,now);}
   const caps=await f.call('/crm/capabilities',{access:session.accessToken});assert.equal(caps.response.status,200);assert.equal(caps.body.data.canRead,false,`${item.name} must have no accidental CRM privilege.`);
   assert.equal((await f.call('/crm/leads',{access:session.accessToken})).response.status,403);assert.equal((await f.call('/crm/export',{access:session.accessToken,body:{},headers:{'idempotency-key':randomUUID()}})).response.status,403);assert.equal((await f.call('/admin/overview',{access:session.accessToken})).response.status,403);
  }
  const owner=(await account(f,'ios','synthetic-negative-owner@example.invalid')).body.data,now=new Date().toISOString();
  f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(owner.user.id,'appneural','synthetic-owner','owner',owner.user.email,'Synthetic owner','2099-01-01T00:00:00.000Z','isolated-test',now,now);
  assert.equal((await f.call('/admin/overview',{access:owner.accessToken})).response.status,200);
  assert.equal((await f.call('/crm/leads?orgId=unrelated-organization',{access:owner.accessToken})).response.status,422,'Even a current owner cannot choose a different tenant through request parameters.');
  f.sqlite.prepare('UPDATE live_core_staff_links SET revoked_at=? WHERE learner_account_id=?').run(now,owner.user.id);
  assert.equal((await f.call('/admin/overview',{access:owner.accessToken})).response.status,403);
 }finally{f.close();}
});

test('CRM private input binds SQL values and cross-site public mutations fail without persisting partial details',async()=>{
 const f=fixture({fullCanonical:true,crm:true});f.env.APP_CRM_ENABLED='true';f.env.APP_CRM_CAPTURE_ENABLED='true';
 try{
  const input={name:'<img src=x onerror=alert(1)>',email:'synthetic-injection@example.invalid',kind:'general',interest:"' OR 1=1 --",consent:{service:true,marketing:false,whatsapp:false,policyVersion:'2026-10'}};
  const denied=await f.call('/crm/capture',{client:'web',origin:'https://unrelated.example',body:input});assert.equal(denied.response.status,403);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()?.n,0);
  assert.equal((await f.call('/crm/capture',{client:'web',origin:'https://app.example.test',headers:{'sec-fetch-site':'cross-site'},body:input})).response.status,403);
  assert.equal((await f.call('/crm/capture',{body:{...input,consent:{...input.consent,service:false}}})).response.status,422);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()?.n,0);
  const saved=await f.call('/crm/capture',{body:input,headers:{'idempotency-key':randomUUID()}});assert.equal(saved.response.status,202);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()?.n,1);
  assert.equal(f.sqlite.prepare('SELECT name FROM crm_contacts').get()?.name,input.name);assert.equal(f.sqlite.prepare('SELECT interest FROM crm_leads').get()?.interest,input.interest);
  // JSON persistence is intentionally literal. Browser escaping/keyboard/media
  // acceptance remains a distinct UI test, not inferred from this SQL check.
  assert.equal(saved.response.headers.get('content-type'),'application/json');assert.equal(saved.response.headers.get('x-content-type-options'),'nosniff');
 }finally{f.close();}
});
