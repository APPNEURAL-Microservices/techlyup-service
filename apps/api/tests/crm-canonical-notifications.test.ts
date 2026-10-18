import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,account} from './fixture';
import {syncCanonicalCrm} from '../src/crm/canonical-source';
import {createCrmNotifications} from '../src/crm/notifications';
import {runCrmAutomation} from '../src/crm/automation';
import {enqueueDueTaskRules} from '../src/crm/task-due';
import {CrmRepository} from '../src/crm/repository';

function setup(){const f=fixture({fullCanonical:true,crm:true});f.env.APP_CRM_ENABLED='true';f.env.APP_CRM_CAPTURE_ENABLED='true';return f;}
async function staff(f:ReturnType<typeof setup>,email:string,role='admin',functional?:string){
 const logged=await account(f,'ios',email),user=logged.body.data.user,at=new Date().toISOString(),actor=`erp:${user.id}`;
 f.sqlite.prepare('INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user.id,'appneural',actor,role,email,'Synthetic staff','2099-01-01T00:00:00.000Z','synthetic',at,at);
 if(functional)f.sqlite.prepare('INSERT INTO webinar_erp_roles VALUES(?,?,?,?)').run('appneural',actor,functional,at);
 return {user,access:logged.body.data.accessToken,actor:{orgId:'appneural',accountId:user.id,requestId:'synthetic-manager'}};
}
const capture={name:'Supplied contact',email:'person@example.test',kind:'course' as const,interest:'One course',consent:{service:true,marketing:false,whatsapp:false,policyVersion:'2026-10' as const}};

test('full 46-migration website schema accepts additive CRM and requires complete privacy/audit storage for readiness',async()=>{
 const f=setup();try{
  assert.equal((await f.call('/health')).response.status,200);
  const source=f.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='live_crm_source_events'").get()!;assert.equal(source.n,1);
  assert.equal((await f.call('/crm/capture',{body:capture,headers:{'idempotency-key':'full-schema-capture'}})).response.status,202);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workshop_registrations').get()!.n,0);
  f.sqlite.exec('DROP TABLE crm_webhook_nonces');assert.equal((await f.call('/health')).response.status,503);
 }finally{f.close();}
});
test('new lead alerts and due reminders are persisted once, private to current staff and auditable',async()=>{
 const f=setup();try{
  const manager=await staff(f,'manager@example.test'),seller=await staff(f,'sales@example.test','member','sales'),other=await staff(f,'other@example.test','member','sales');
  const repo=new CrmRepository(f.db),lead=await repo.capture({orgId:'appneural',accountId:null,requestId:'public'},capture,'new-alert-lead');
  assert.equal((await createCrmNotifications(f.env)).created,1);assert.equal((await createCrmNotifications(f.env)).created,0);
  let inbox=await f.call('/crm/notifications',{access:manager.access});assert.equal(inbox.body.data.notifications.length,1);const notification=inbox.body.data.notifications[0];
  assert.equal((await f.call('/crm/notifications',{access:seller.access})).body.data.notifications.length,0);
  assert.equal((await f.call(`/crm/notifications/${notification.id}/read`,{access:other.access,body:{}})).response.status,404);
  assert.equal((await f.call(`/crm/notifications/${notification.id}/read`,{access:manager.access,body:{}})).body.data.read,true);
  const assigned=await repo.updateLead(manager.actor,lead.id,{expectedVersion:lead.version,ownerAccountId:seller.user.id},'assign-alert-owner');
  await repo.saveTask(manager.actor,assigned.id,{title:'Review learner enquiry',dueAt:new Date(Date.now()-60000).toISOString(),assignedAccountId:seller.user.id},'due-reminder-task');
  assert.equal((await createCrmNotifications(f.env)).created,1);assert.equal((await createCrmNotifications(f.env)).created,0);
  inbox=await f.call('/crm/notifications',{access:seller.access});assert.equal(inbox.body.data.notifications[0].kind,'task_due');
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_audit_events WHERE action='staff_alert'").get()!.n,2);
  f.sqlite.prepare('UPDATE live_core_staff_links SET revoked_at=? WHERE learner_account_id=?').run(new Date().toISOString(),seller.user.id);
  assert.equal((await f.call('/crm/notifications',{access:seller.access})).response.status,403);
 }finally{f.close();}
});
test('canonical registration links preserve account proof while ended-event and explicit attendance drive follow-ups',async()=>{
 const f=setup();try{
  const registered=await account(f,'ios','attendee@example.test'),accountId=registered.body.data.user.id,at=new Date().toISOString(),registration=crypto.randomUUID(),session=crypto.randomUUID(),workshop='synthetic-reviewed-webinar';
  // Existing legacy registration precedes its additive core session projection.
  f.sqlite.prepare('INSERT INTO workshop_registrations(id,workshop_id,workshop_title,workshop_datetime,workshop_venue,first_name,last_name,email,phone,status,manage_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(registration,workshop,'Reviewed webinar','2020-01-01T00:00:00.000Z','Online','Synthetic','Learner','attendee@example.test','+919000000001','confirmed',crypto.randomUUID(),at,at);
  f.sqlite.prepare('INSERT INTO live_core_session_catalog VALUES(?,?,?,?,?,?)').run(session,'appneural',workshop,1,JSON.stringify({status:'ENDED',startsAt:'2020-01-01T00:00:00.000Z',durationMinutes:60}),at);
  f.sqlite.prepare('INSERT INTO live_core_registration_links(registration_id,session_id,org_id,learner_account_id,consent_version,created_at) VALUES(?,?,?,?,?,?)').run(registration,session,'appneural',accountId,'2026-10',at);
  f.sqlite.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),'website',JSON.stringify({firstName:'Synthetic',lastName:'Learner',email:'attendee@example.test',phone:'+919000000001',consent:'true',consentVersion:'2026-10'}),'new',JSON.stringify({purpose:'webinar_registration',registrationId:registration}),at,at);
  assert.equal((await syncCanonicalCrm(f.env)).processed,1);
  const actor={orgId:'appneural',accountId:null,requestId:'synthetic-rules'},repo=new CrmRepository(f.db),lead=(await repo.listLeads(actor,{})).leads[0];assert.equal(lead.accountId,accountId);
  assert.equal((await repo.eligibility(actor,lead.id,'email','marketing')).eligible,false);
  await repo.saveRule(actor,{name:'Explicit no-show evidence',type:'score',trigger:'no_show',points:5,enabled:true},'no-show-test-rule');
  // No attendance row is unknown; it is never an inferred no-show.
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,0);
  f.sqlite.prepare('INSERT INTO workshop_attendance VALUES(?,?,?)').run(registration,0,at);assert.equal((await syncCanonicalCrm(f.env)).processed,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,1);
  const updated=(await repo.detail(actor,lead.id)).lead;assert.equal(updated.scoreReasons.some(reason=>reason.label==='Explicit no-show evidence'),true);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workshop_registrations').get()!.n,1);
 }finally{f.close();}
});

test('attendance recorded before completion is deferred and a sparse completion event wakes it exactly once',async()=>{
 const f=setup();try{
  const at=new Date().toISOString(),registration=crypto.randomUUID(),session=crypto.randomUUID(),workshop='synthetic-completion-after-attendance';
  f.sqlite.prepare('INSERT INTO workshop_registrations(id,workshop_id,workshop_title,workshop_datetime,workshop_venue,first_name,last_name,email,phone,status,manage_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(registration,workshop,'Completion timing test','2020-01-01T00:00:00.000Z','Online','Synthetic','Learner','before-end@example.test','+919000000001','confirmed',crypto.randomUUID(),at,at);
  const snapshot={status:'LIVE',startsAt:'2020-01-01T00:00:00.000Z',durationMinutes:60};f.sqlite.prepare('INSERT INTO live_core_session_catalog VALUES(?,?,?,?,?,?)').run(session,'appneural',workshop,1,JSON.stringify(snapshot),at);
  f.sqlite.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),'website',JSON.stringify({name:'Synthetic',email:'before-end@example.test',consent:true,consentVersion:'2026-10'}),'new',JSON.stringify({purpose:'webinar_registration',registrationId:registration}),at,at);
  const actor={orgId:'appneural',accountId:null,requestId:'completion-timing'},repo=new CrmRepository(f.db);await repo.saveRule(actor,{name:'Proven post-event attendance',type:'score',trigger:'post_event',points:7,enabled:true},'completion-timing-rule');
  f.sqlite.prepare('INSERT INTO workshop_attendance VALUES(?,?,?)').run(registration,1,at);await syncCanonicalCrm(f.env);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,0);const waiting=f.sqlite.prepare("SELECT state,result_code FROM crm_canonical_outbox WHERE source_kind='attendance'").get()!;assert.equal(waiting.state,'pending');assert.equal(waiting.result_code,'awaiting_completion_evidence');
  f.sqlite.exec("UPDATE crm_canonical_outbox SET attempts=7,available_at='2000-01-01T00:00:00.000Z' WHERE source_kind='attendance'");await syncCanonicalCrm(f.env);assert.equal(f.sqlite.prepare("SELECT state FROM crm_canonical_outbox WHERE source_kind='attendance'").get()!.state,'failed');
  // A new authoritative end transition wakes deferred rows before their timer;
  // each explicit attendance event retains its original stable rule key.
  f.sqlite.prepare('UPDATE live_core_session_catalog SET session_version=2,session_json=?,updated_at=? WHERE session_id=?').run(JSON.stringify({...snapshot,status:'ENDED'}),new Date().toISOString(),session);
  await syncCanonicalCrm(f.env);await syncCanonicalCrm(f.env);await syncCanonicalCrm(f.env);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,1);assert.equal(f.sqlite.prepare("SELECT state FROM crm_canonical_outbox WHERE source_kind='attendance'").get()!.state,'done');
 }finally{f.close();}
});

test('completion dispatch is bounded and never sweeps historical attendance',async()=>{
 const f=setup();try{
  const at=new Date().toISOString(),workshop='synthetic-paged-completion';
  const insert=f.sqlite.prepare('INSERT INTO workshop_registrations(id,workshop_id,workshop_title,workshop_datetime,workshop_venue,first_name,last_name,email,phone,status,manage_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  // Simulate a canonical attendance row existing before installation of the
  // additive capture trigger. It must remain outside this incremental bridge.
  f.sqlite.exec('DROP TRIGGER crm_attendance_insert');insert.run('historical-attendance',workshop,'Historical row','2020-01-01T00:00:00.000Z','Online','Synthetic','Legacy','legacy@example.test','+919000000000','confirmed',crypto.randomUUID(),at,at);f.sqlite.prepare('INSERT INTO workshop_attendance VALUES(?,?,?)').run('historical-attendance',0,at);
  f.sqlite.exec("CREATE TRIGGER crm_attendance_insert AFTER INSERT ON workshop_attendance BEGIN INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at) VALUES('attendance:'||NEW.registration_id||':'||NEW.attended||':'||NEW.recorded_at,'attendance',NEW.registration_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;");
  for(let n=0;n<26;n++){const registration=`bounded-attendance-${String(n).padStart(2,'0')}`;insert.run(registration,workshop,'Explicit captured row','2020-01-01T00:00:00.000Z','Online','Synthetic','Learner',`bounded-${n}@example.test`,'+919000000001','confirmed',crypto.randomUUID(),at,at);f.sqlite.prepare('INSERT INTO workshop_attendance VALUES(?,?,?)').run(registration,n===25?0:1,at);}
  // Put captured rows to sleep so this call exercises only the dispatcher.
  f.sqlite.exec("UPDATE crm_canonical_outbox SET available_at='2099-01-01T00:00:00.000Z' WHERE source_kind='attendance'");
  f.sqlite.prepare('INSERT INTO workshop_updates VALUES(?,?,?)').run(workshop,JSON.stringify({status:'completed'}),at);await syncCanonicalCrm(f.env);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_canonical_outbox WHERE source_kind='attendance' AND available_at<'2099'").get()!.n,25);assert.equal(f.sqlite.prepare("SELECT state FROM crm_canonical_outbox WHERE source_kind='completion'").get()!.state,'pending');
  await syncCanonicalCrm(f.env,100);assert.equal(f.sqlite.prepare("SELECT state FROM crm_canonical_outbox WHERE source_kind='completion'").get()!.state,'done');assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_canonical_outbox WHERE source_kind='attendance' AND source_id='historical-attendance'").get()!.n,0);
 }finally{f.close();}
});

test('due-task workflows run once per explicit task version and automation tasks cannot recursively trigger them',async()=>{
 const f=setup();try{
  const manager=await staff(f,'due-rule-manager@example.test'),repo=new CrmRepository(f.db),lead=await repo.capture(manager.actor,capture,'due-rule-lead');const assigned=await repo.updateLead(manager.actor,lead.id,{expectedVersion:lead.version,ownerAccountId:manager.user.id},'due-rule-owner');
  const task=await repo.saveTask(manager.actor,lead.id,{title:'Explicit staff due task',dueAt:new Date(Date.now()-60000).toISOString(),assignedAccountId:manager.user.id},'due-rule-task');
  await repo.saveRule(manager.actor,{name:'Explain due follow-up',type:'score',trigger:'task_due',points:4,enabled:true},'due-score-rule');await repo.saveRule(manager.actor,{name:'Single follow-up review task',type:'automation',trigger:'task_due',taskTitle:'Review due request once',enabled:true},'due-task-rule');
  await runCrmAutomation(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,2);assert.equal((await repo.detail(manager.actor,lead.id)).lead.score,assigned.score+4);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n,2);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_tasks WHERE origin='automation'").get()!.n,1);
  await runCrmAutomation(f.env);await runCrmAutomation(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,2);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_tasks').get()!.n,2);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_outbox WHERE event_type='task_due'").get()!.n,1);
  await repo.saveTask(manager.actor,lead.id,{taskId:task.id,title:task.title,dueAt:task.dueAt,assignedAccountId:task.assignedAccountId,expectedVersion:task.version,status:'done'},'due-original-complete');await runCrmAutomation(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,2);
 }finally{f.close();}
});
test('closed or permission-revoked task versions never execute a queued due workflow',async()=>{
 const f=setup();try{
  const manager=await staff(f,'due-proof-manager@example.test'),repo=new CrmRepository(f.db),lead=await repo.capture(manager.actor,capture,'due-proof-lead');await repo.updateLead(manager.actor,lead.id,{expectedVersion:lead.version,ownerAccountId:manager.user.id},'due-proof-owner');await repo.saveRule(manager.actor,{name:'Only current due task proof',type:'score',trigger:'task_due',points:9,enabled:true},'due-proof-rule');
  const task=await repo.saveTask(manager.actor,lead.id,{title:'Do not run after closure',dueAt:new Date(Date.now()-60000).toISOString(),assignedAccountId:manager.user.id},'due-proof-task');assert.equal((await enqueueDueTaskRules(f.env)).queued,1);
  await repo.saveTask(manager.actor,lead.id,{taskId:task.id,title:task.title,dueAt:task.dueAt,assignedAccountId:task.assignedAccountId,expectedVersion:task.version,status:'done'},'due-proof-close');await runCrmAutomation(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,0);assert.equal(f.sqlite.prepare("SELECT state FROM crm_outbox WHERE event_type='task_due'").get()!.state,'blocked');
  const second=await repo.saveTask(manager.actor,lead.id,{title:'Do not run after revocation',dueAt:new Date(Date.now()-60000).toISOString(),assignedAccountId:manager.user.id},'due-proof-second');assert.equal((await enqueueDueTaskRules(f.env)).queued,1);f.sqlite.prepare('UPDATE live_core_staff_links SET revoked_at=? WHERE learner_account_id=?').run(new Date().toISOString(),manager.user.id);await runCrmAutomation(f.env);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,0);assert.equal(f.sqlite.prepare("SELECT state FROM crm_outbox WHERE id=?").get(`task_due:${second.id}:${second.version}`)!.state,'blocked');
 }finally{f.close();}
});
test('a due-task closure immediately before the rule transaction rolls back its outcome',async()=>{
 const f=setup();try{
  const manager=await staff(f,'due-cas-manager@example.test'),repo=new CrmRepository(f.db),lead=await repo.capture(manager.actor,capture,'due-cas-lead');await repo.updateLead(manager.actor,lead.id,{expectedVersion:lead.version,ownerAccountId:manager.user.id},'due-cas-owner');await repo.saveRule(manager.actor,{name:'Atomic due proof',type:'score',trigger:'task_due',points:11,enabled:true},'due-cas-rule');
  const task=await repo.saveTask(manager.actor,lead.id,{title:'Close before outcome commit',dueAt:new Date(Date.now()-60000).toISOString(),assignedAccountId:manager.user.id},'due-cas-task');let armed=true;
  const raced=new CrmRepository({...f.db,async batch(statements){if(armed){armed=false;f.sqlite.prepare("UPDATE crm_tasks SET status='done',version=version+1 WHERE id=?").run(task.id);}return f.db.batch(statements);}});
  await assert.rejects(()=>raced.runRules(manager.actor,lead.id,'task_due',`task_due:${task.id}:${task.version}`,{dueTask:{id:task.id,version:task.version}}),{status:409});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_rule_runs').get()!.n,0);
 }finally{f.close();}
});

test('new completion triggers preserve canonical writes with invalid or unrelated legacy metadata',()=>{
 const f=setup();try{
  const at=new Date().toISOString();assert.doesNotThrow(()=>f.sqlite.prepare('INSERT INTO workshop_updates VALUES(?,?,?)').run('synthetic-unrelated-update','legacy metadata not JSON',at));
  assert.doesNotThrow(()=>f.sqlite.prepare('INSERT INTO live_core_session_catalog VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),'appneural','synthetic-unrelated-session',1,'legacy metadata not JSON',at));assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_canonical_outbox WHERE source_kind='completion'").get()!.n,0);
 }finally{f.close();}
});
