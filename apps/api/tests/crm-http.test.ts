import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture,account } from './fixture';
import { signCrmRelay } from '../src/crm/integrations';
import { CrmRepository, canonicalCrmContactHash } from '../src/crm/repository';
import { runCrmAutomation } from '../src/crm/automation';

function crmFixture(){const f=fixture();f.sqlite.exec(readFileSync(new URL('./fixtures/canonical-crm.sql',import.meta.url),'utf8'));for(const name of ['0048_crm_acquisition.sql','0049_crm_canonical_sources.sql','0050_crm_visitors.sql'])f.sqlite.exec(readFileSync(new URL(`../../../migrations/d1/${name}`,import.meta.url),'utf8'));f.env.APP_CRM_ENABLED='true';f.env.APP_CRM_CAPTURE_ENABLED='true';return f;}
function staff(f:ReturnType<typeof crmFixture>,user:{id:string;email:string},role='admin',functional?:string){const instant=new Date().toISOString();f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user.id,'appneural',`actor:${user.id}`,role,user.email,'Synthetic CRM staff',new Date(Date.now()+3600000).toISOString(),'synthetic-review',instant,instant);if(functional)f.sqlite.prepare('INSERT INTO webinar_erp_roles VALUES(?,?,?,?)').run('appneural',`actor:${user.id}`,functional,instant);}
const input={name:'=Synthetic unsafe spreadsheet formula',email:'lead@example.test',kind:'course' as const,interest:'A learning enquiry',consent:{service:false,marketing:false,whatsapp:false,policyVersion:'2026-10' as const}};
const headers=()=>({'idempotency-key':crypto.randomUUID()});

test('CRM HTTP denies learners, resolves current staff, protects private search, scoped assignments, tasks and CSV export',async()=>{
 const f=crmFixture();try{
  assert.equal((await f.call('/crm/leads')).response.status,401);
  const admin=(await account(f,'ios','admin@example.test')).body.data;
  assert.equal((await f.call('/crm/leads',{access:admin.accessToken})).response.status,403);
  staff(f,admin.user);const caps=await f.call('/crm/capabilities',{access:admin.accessToken});assert.equal(caps.body.data.canAssign,true);assert.equal(caps.body.data.dispatchEnabled,false);
  assert.equal((await f.call('/crm/leads',{body:{...input,consent:{...input.consent,marketing:true}},access:admin.accessToken,headers:headers()})).response.status,422);
  const created=await f.call('/crm/leads',{body:input,access:admin.accessToken,headers:headers()});assert.equal(created.response.status,201);const lead=created.body.data;
  assert.equal((await f.call('/crm/leads?q=private-email',{access:admin.accessToken})).response.status,422);
  const search=await f.call('/crm/leads/search',{body:{q:'spreadsheet'},access:admin.accessToken});assert.equal(search.body.data.leads.length,1);
  const sales=(await account(f,'ios','sales@example.test')).body.data;staff(f,sales.user,'member','sales');
  assert.equal((await f.call('/crm/leads',{access:sales.accessToken})).body.data.leads.length,0);
  assert.equal((await f.call(`/crm/leads/${lead.id}`,{access:sales.accessToken})).response.status,404);
  const assigned=await f.call(`/crm/leads/${lead.id}`,{method:'PATCH',body:{expectedVersion:lead.version,ownerAccountId:sales.user.id},access:admin.accessToken,headers:headers()});assert.equal(assigned.response.status,200);
  assert.equal((await f.call('/crm/leads',{access:sales.accessToken})).body.data.leads.length,1);
  assert.equal((await f.call(`/crm/leads/${lead.id}`,{method:'PATCH',body:{expectedVersion:assigned.body.data.version,ownerAccountId:null},access:sales.accessToken,headers:headers()})).response.status,403);
  const task=await f.call(`/crm/leads/${lead.id}/tasks`,{body:{title:'Return requested information',dueAt:new Date(Date.now()+3600000).toISOString(),assignedAccountId:sales.user.id},access:sales.accessToken,headers:headers()});assert.equal(task.response.status,201);
  const tasks=await f.call('/crm/tasks?status=open&limit=100',{access:sales.accessToken});assert.equal(tasks.body.data.tasks.length,1);
  const done=await f.call(`/crm/tasks/${task.body.data.id}`,{method:'PATCH',body:{title:task.body.data.title,dueAt:task.body.data.dueAt,assignedAccountId:sales.user.id,status:'done',expectedVersion:task.body.data.version},access:sales.accessToken,headers:headers()});assert.equal(done.response.status,200);
  const exported=await f.call('/crm/export',{body:{},access:admin.accessToken,headers:headers()});assert.equal(exported.response.status,200);assert.equal(exported.body.data.format,'csv');assert.match(exported.body.data.content,/'=Synthetic/);
  f.sqlite.prepare('UPDATE live_core_staff_links SET revoked_at=? WHERE learner_account_id=?').run(new Date().toISOString(),admin.user.id);
  assert.equal((await f.call('/crm/export',{body:{},access:admin.accessToken,headers:headers()})).response.status,403);
 }finally{f.close();}
});

test('anonymous capture cannot claim canonical identity, roles or verified consent and manual entry cannot grant permission',async()=>{
 const f=crmFixture();try{
  const canonical=(await account(f,'ios',input.email)).body.data;
  assert.equal((await f.call('/crm/capture',{body:input})).response.status,422);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()?.n,0);
  const captured=await f.call('/crm/capture',{body:{...input,consent:{...input.consent,service:true,marketing:true,whatsapp:true}}});assert.equal(captured.response.status,202);
  const row=f.sqlite.prepare('SELECT account_id FROM crm_leads WHERE id=?').get(captured.body.data.reference);assert.equal(row?.account_id,null);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_contact_permissions WHERE state='granted'").get()?.n,0);
  assert.equal((await f.call('/crm/capture',{body:{...input,accountId:canonical.user.id}})).response.status,422);
  assert.equal((await f.call('/crm/capture',{body:{...input,roles:['admin']}})).response.status,422);
  assert.equal((await f.call('/crm/capture',{body:{...input,consent:{...input.consent,policyVersion:'2026-09'}}})).response.status,422);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM learner_accounts').get()?.n,1);
 }finally{f.close();}
});

test('approved relay requires exact source registration and fresh signed nonce, dedupes stable events, and never grants provider checkbox consent',async()=>{
 const f=crmFixture();try{
  f.env.APP_CRM_INTEGRATIONS_ENABLED='true';f.env.CRM_WEBHOOK_SECRET='synthetic-relay-key-only-for-local-tests-123456789';f.env.CRM_EXTERNAL_APPROVED='true';
  const repo=new CrmRepository(f.db),actor={orgId:'appneural',accountId:null,requestId:crypto.randomUUID()};
  const integration=await repo.saveIntegration(actor,{name:'Synthetic external form',provider:'external',channel:'email',sourceRef:'approved-form-1',enabled:true},crypto.randomUUID());
  const body={provider:'external',integrationId:integration.id,sourceRef:'approved-form-1',externalId:'event-one',processing:{policyVersion:'2026-10',occurredAt:new Date().toISOString(),serviceRequested:true},capture:{...input,consent:{...input.consent,marketing:true,whatsapp:true}}};
  const {processing:omitted,...withoutProof}=body;void omitted;
  const missingProof=await f.call('/crm/webhooks/relay',{body:withoutProof,headers:await signCrmRelay(f.env.CRM_WEBHOOK_SECRET,'/api/v1/crm/webhooks/relay',JSON.stringify(withoutProof))});assert.equal(missingProof.response.status,422);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_contacts').get()?.n,0);
  const signed=await signCrmRelay(f.env.CRM_WEBHOOK_SECRET,'/api/v1/crm/webhooks/relay',JSON.stringify(body));
  const first=await f.call('/crm/webhooks/relay',{body,headers:signed});assert.equal(first.response.status,202);
  assert.equal((await f.call('/crm/webhooks/relay',{body,headers:signed})).response.status,409);
  const second=await f.call('/crm/webhooks/relay',{body,headers:await signCrmRelay(f.env.CRM_WEBHOOK_SECRET,'/api/v1/crm/webhooks/relay',JSON.stringify(body))});assert.equal(second.response.status,202);assert.equal(second.body.data.reference,first.body.data.reference);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_contact_permissions WHERE state='granted'").get()?.n,0);
  const wrong={...body,sourceRef:'foreign-form'};assert.equal((await f.call('/crm/webhooks/relay',{body:wrong,headers:await signCrmRelay(f.env.CRM_WEBHOOK_SECRET,'/api/v1/crm/webhooks/relay',JSON.stringify(wrong))})).response.status,403);
  const changed={...body,capture:{...body.capture,interest:'modified event body'}};assert.equal((await f.call('/crm/webhooks/relay',{body:changed,headers:await signCrmRelay(f.env.CRM_WEBHOOK_SECRET,'/api/v1/crm/webhooks/relay',JSON.stringify(changed))})).response.status,409);
 }finally{f.close();}
});

async function deliverable(f:ReturnType<typeof crmFixture>){
 Object.assign(f.env,{APP_CRM_SENDING_ENABLED:'true',CRM_NOTIFICATION_AUTHORITY_APPROVED:'true',CRM_DELIVERY_AUTH_SECRET:'synthetic-delivery-decision-local-secret-123456789',CRM_NOTIFICATION_ORIGIN:'http://127.0.0.1:9999',CRM_NOTIFICATION_ALLOW_LOCAL:'true',CRM_NOTIFICATION_CREDENTIAL:'synthetic-private-workload-credential-local',CRM_NOTIFICATION_TENANT_ID:'appneural',CRM_NOTIFICATION_SUBJECT_ID:'techlyup-service',CRM_NOTIFICATION_EMAIL_TYPE:'techlyup.acquisition.email',CRM_PUBLIC_ORIGIN:'https://app.techlyup.com',APP_ALLOWED_ORIGINS:'https://app.example.test,https://app.techlyup.com'});
 const instant=new Date().toISOString();
 f.sqlite.prepare('INSERT INTO email_subscribers(email,name,status,unsubscribe_token,consent_at,verified_at,last_requested_at) VALUES(?,?,?,?,?,?,?)').run(input.email,input.name,'active',crypto.randomUUID(),instant,instant,instant);
 const repo=new CrmRepository(f.db),actor={orgId:'appneural',accountId:null,requestId:crypto.randomUUID()};
 const lead=await repo.capture(actor,{...input,consent:{...input.consent,marketing:true}},crypto.randomUUID(),{verifiedSource:{kind:'newsletter',reference:'newsletter:local-test',verifiedAt:instant}});
 const integration=await repo.saveIntegration(actor,{name:'Native notification owner',provider:'native_notification',channel:'email',sourceRef:'techlyup-service',enabled:true},crypto.randomUUID());
 const campaign=await repo.saveCampaign(actor,{name:'Synthetic approved campaign',channel:'email',templateRef:'techlyup.acquisition.email',integrationId:integration.id,enabled:true},crypto.randomUUID());
 await repo.enqueueCampaign(actor,campaign.id,crypto.randomUUID());
 return {repo,actor,lead,campaign};
}

test('bounded CRM runner persists native intent acceptance and signed final decision immediately rejects withdrawal, recipient swaps and replay',async()=>{
 const f=crmFixture();try{
  const {repo,actor,lead}=await deliverable(f);let sends=0;
  const fetcher=async(_url:unknown,init?:RequestInit)=>{sends++;const body=JSON.parse(String(init?.body));return Response.json({data:{id:'nfi_local_bound_intent',tenantId:'appneural',sourceService:'techlyup-service',sourceEventId:body.sourceEventId,sourceResourceId:body.sourceResourceId,status:'CREATED'}});};
  const result=await runCrmAutomation(f.env,fetcher as typeof fetch);assert.equal(result.accepted,1);assert.equal(sends,1);
  const job=(await repo.listJobs(actor))[0];assert.equal(job.state,'accepted');assert.equal(job.nativeIntentId,'nfi_local_bound_intent');assert.equal(job.providerMessageId,null);
  const body={tenantId:'appneural',jobId:job.id,leadId:lead.id,channel:'email',purpose:'marketing',recipientHash:await canonicalCrmContactHash('email',input.email)};
  const signed=await signCrmRelay(f.env.CRM_DELIVERY_AUTH_SECRET!,'/api/v1/crm/delivery/authorize',JSON.stringify(body));
  const current=await f.call('/crm/delivery/authorize',{body,headers:signed});assert.equal(current.response.status,200);assert.equal(current.body.data.allowed,true);assert.equal(JSON.stringify(current.body).includes(input.email),false);
  const audited=f.sqlite.prepare("SELECT metadata FROM crm_audit_events WHERE id=? AND action='delivery_authorization'").get(current.body.data.decisionId);assert.equal(JSON.parse(String(audited?.metadata)).allowed,true);
  assert.equal((await f.call('/crm/delivery/authorize',{body,headers:signed})).response.status,409);
  const swapped={...body,recipientHash:'a'.repeat(64)};assert.equal((await f.call('/crm/delivery/authorize',{body:swapped,headers:await signCrmRelay(f.env.CRM_DELIVERY_AUTH_SECRET!,'/api/v1/crm/delivery/authorize',JSON.stringify(swapped))})).body.data.allowed,false);
  const token=await repo.issuePreferenceToken(actor,lead.id,'email');
  assert.equal((await f.call('/crm/preferences/revoke',{body:{token}})).response.status,200);
  const withdrawn=await f.call('/crm/delivery/authorize',{body,headers:await signCrmRelay(f.env.CRM_DELIVERY_AUTH_SECRET!,'/api/v1/crm/delivery/authorize',JSON.stringify(body))});assert.equal(withdrawn.body.data.allowed,false);
  f.sqlite.exec("CREATE TRIGGER synthetic_decision_audit_failure BEFORE INSERT ON crm_audit_events WHEN NEW.action='delivery_authorization' BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  const noAudit=await f.call('/crm/delivery/authorize',{body,headers:await signCrmRelay(f.env.CRM_DELIVERY_AUTH_SECRET!,'/api/v1/crm/delivery/authorize',JSON.stringify(body))});assert.equal(noAudit.response.status,503);
  f.sqlite.exec('DROP TRIGGER synthetic_decision_audit_failure');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM live_communication_suppressions').get()?.n,2);
  await runCrmAutomation(f.env,fetcher as typeof fetch);assert.equal(sends,1);
  f.env.APP_CRM_ENABLED='false';f.env.APP_CRM_CAPTURE_ENABLED='false';f.env.APP_CRM_SENDING_ENABLED='false';
  const invalid=await f.call('/crm/preferences/revoke',{body:{token:'x'.repeat(64)}});assert.equal(invalid.response.status,422);assert.equal(invalid.body.error.code,'preference_link_invalid');
 }finally{f.close();}
});

test('ambiguous native intent acceptance and interrupted sends remain uncertain with no repeated or fallback dispatch',async()=>{
 const f=crmFixture();try{
  const {repo,actor}=await deliverable(f);let sends=0;
  const failing=async()=>{sends++;throw new Error('synthetic transport lost after dispatch');};
  const first=await runCrmAutomation(f.env,failing as typeof fetch);assert.equal(first.uncertain,1);assert.equal(sends,1);
  assert.equal((await repo.listJobs(actor))[0].state,'uncertain');
  await runCrmAutomation(f.env,failing as typeof fetch);assert.equal(sends,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_job_attempts').get()?.n,1);
 }finally{f.close();}
});

test('an interrupted durable sending lease becomes uncertain without redispatching its provider request',async()=>{
 const f=crmFixture();try{
  const {repo,actor}=await deliverable(f),job=(await repo.listJobs(actor))[0];
  await repo.claimJob(actor,job.id,'synthetic-crashed-worker',new Date().toISOString());
  f.sqlite.prepare("UPDATE crm_jobs SET claimed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
  let sends=0;const result=await runCrmAutomation(f.env,(async()=>{sends++;throw new Error('must never send');}) as typeof fetch);
  assert.equal(result.uncertain,1);assert.equal(sends,0);assert.equal((await repo.getJob(actor,job.id)).state,'uncertain');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_job_attempts').get()?.n,1);
 }finally{f.close();}
});
