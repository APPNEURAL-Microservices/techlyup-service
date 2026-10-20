import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixture';
import {ingestWebinarCrmEvent,processWebinarCrmIntake,type WebinarCrmEnv} from '../src/crm/webinar-ingestion';

function setup(){
 const f=fixture({crm:true});
 for(const name of ['0052_support_credits.sql','0053_webinar_crm.sql'])f.sqlite.exec(readFileSync(new URL(`../../../migrations/d1/${name}`,import.meta.url),'utf8'));
 const at=new Date().toISOString(),env:WebinarCrmEnv={...f.env,APP_CRM_ENABLED:'true',APP_CRM_CAPTURE_ENABLED:'true',APP_CRM_WEBINAR_ENABLED:'true',SUPPORT_EXPECTED_CLIENT_ID:'techlyup-live'};
 f.sqlite.prepare("INSERT INTO learner_accounts(id,email,name,password_hash,email_verified,consent_version,created_at,updated_at) VALUES('canonical-learner','canonical@example.test','Generated learner','not-a-login-hash',1,'2026-10',?,?)").run(at,at);
 f.sqlite.prepare("INSERT INTO app_support_link_challenges(id,client_id,live_subject,session_binding,pkce_challenge,expires_at,authorized_account_id,created_at) VALUES('fixture-challenge','techlyup-live','live-learner','fixture-session','fixture-pkce',?,'canonical-learner',?)").run(new Date(Date.now()+300000).toISOString(),at);
 f.sqlite.prepare("INSERT INTO app_support_links(client_id,live_subject,account_id,challenge_id,linked_at) VALUES('techlyup-live','live-learner','canonical-learner','fixture-challenge',?)").run(at);
 const identity={orgId:'appneural',accountId:'canonical-learner',liveSubject:'live-learner'};
 const event=(kind:'REGISTRATION_CONFIRMED'|'ATTENDANCE_REVIEWED'|'OFFER_INTEREST'='REGISTRATION_CONFIRMED')=>({eventId:crypto.randomUUID(),sessionId:'session-local',kind,occurredAt:new Date().toISOString(),consentReceiptId:'local-consent-1',serviceConsent:true as const,marketingDeclared:true});
 return {...f,env,identity,event};
}
test('webinar CRM requires explicit flags and the exact active dual-auth link, never an email guess',async()=>{
 const f=setup();try{
  await assert.rejects(ingestWebinarCrmEvent({...f.env,APP_CRM_WEBINAR_ENABLED:'false'},f.identity,f.event()),{code:'webinar_crm_disabled'});
  await assert.rejects(ingestWebinarCrmEvent(f.env,{...f.identity,liveSubject:'same-email-unlinked'},f.event()),{code:'link_required'});
  await assert.rejects(ingestWebinarCrmEvent(f.env,{...f.identity,orgId:'another-org'},f.event()),{code:'webinar_crm_disabled'});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_webinar_crm_intake').get()!.n,0);
 }finally{f.close();}
});
test('intake is bounded, idempotent and sparse, and rejects private content or conflicting event reuse',async()=>{
 const f=setup();try{
  const event=f.event();
  assert.equal((await ingestWebinarCrmEvent(f.env,f.identity,event)).state,'PENDING');
  await ingestWebinarCrmEvent(f.env,f.identity,event);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_webinar_crm_intake').get()!.n,1);
  await assert.rejects(ingestWebinarCrmEvent(f.env,f.identity,{...event,kind:'OFFER_INTEREST'}),{code:'webinar_event_conflict'});
  await assert.rejects(ingestWebinarCrmEvent(f.env,f.identity,{...f.event(),privateQuestion:'Must never enter CRM'}));
  await assert.rejects(ingestWebinarCrmEvent(f.env,f.identity,{...f.event(),occurredAt:'2000-01-01T00:00:00Z'}),{code:'webinar_event_time_invalid'});
  const columns=f.sqlite.prepare('PRAGMA table_info(app_webinar_crm_intake)').all().map(row=>row.name);
  assert.equal(columns.some(name=>['email','text','body','transcript'].includes(String(name))),false);
 }finally{f.close();}
});
test('projection reuses canonical CRM and preserves marketing consent, source idempotency and no-send boundaries',async()=>{
 const f=setup();try{
  const event=f.event('OFFER_INTEREST');await ingestWebinarCrmEvent(f.env,f.identity,event);
  assert.equal((await processWebinarCrmIntake(f.env)).processed,1);
  const lead=f.sqlite.prepare('SELECT account_id,kind,source,contact_id FROM crm_leads').get()!;
  assert.equal(lead.account_id,'canonical-learner');assert.equal(lead.kind,'webinar');assert.equal(lead.source,'app:webinar');
  const marketing=f.sqlite.prepare("SELECT state,proof_kind FROM crm_contact_permissions WHERE contact_id=? AND channel='email' AND purpose='marketing'").get(lead.contact_id)!;
  assert.equal(marketing.state,'pending');assert.equal(marketing.proof_kind,'declared');
  assert.equal(f.sqlite.prepare("SELECT state FROM crm_contact_permissions WHERE channel='email' AND purpose='service'").get()!.state,'granted');
  const counts=()=>[f.sqlite.prepare('SELECT count(*) n FROM crm_source_events').get()!.n,f.sqlite.prepare('SELECT count(*) n FROM crm_activities').get()!.n,f.sqlite.prepare('SELECT count(*) n FROM crm_outbox').get()!.n];
  const before=counts();f.sqlite.prepare("UPDATE app_webinar_crm_intake SET state='PROCESSING',lease_until='2000-01-01T00:00:00Z',lease_id='crashed-lease'").run();
  assert.equal((await processWebinarCrmIntake(f.env)).processed,1);assert.deepEqual(counts(),before);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_jobs').get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_webhook_nonces').get()!.n,0);
 }finally{f.close();}
});
test('revoked links are suppressed before CRM projection',async()=>{
 const f=setup();try{
  await ingestWebinarCrmEvent(f.env,f.identity,f.event());f.sqlite.prepare('UPDATE app_support_links SET revoked_at=?').run(new Date().toISOString());
  assert.equal((await processWebinarCrmIntake(f.env)).suppressed,1);
  assert.equal(f.sqlite.prepare('SELECT state FROM app_webinar_crm_intake').get()!.state,'SUPPRESSED');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM crm_leads').get()!.n,0);
 }finally{f.close();}
});
