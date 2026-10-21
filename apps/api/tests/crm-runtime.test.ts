/** Actual workerd + D1 HTTP acceptance over the complete schema-only canonical
 * website fixture. Every grant, identity and store is disposable and local. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { ApiResponse, AuthSession, CrmLead, CrmLeadDetail, CrmTask } from '@techlyup/contracts';
import { seededCode, signupInput } from './fixture';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const port = 8899;
const origin = `http://127.0.0.1:${port}`;

async function requireOwnedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Isolated CRM runtime port is unavailable.')));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else { clearTimeout(timer); resolve(); } } catch { clearTimeout(timer); resolve(); }
  });
}

test('real workerd and canonical D1 support CRM CRUD, current grants, atomic audit rollback and private visitor withdrawal', {timeout:120000,skip:process.env.APP_RUNTIME_ACCEPTANCE==='false'}, async()=>{
  await requireOwnedPort();
  const directory=await mkdtemp('/tmp/techlyup-crm-runtime-');
  let worker:ChildProcess|undefined;
  try {
    const schemaPath=join(root,'apps/api/tests/fixtures/website-schema-2026-10-16.sql');
    const [schema,manifestRaw]=await Promise.all([readFile(schemaPath,'utf8'),readFile(join(root,'apps/api/tests/fixtures/website-schema-2026-10-16.json'),'utf8')]);
    const manifest=JSON.parse(manifestRaw) as {snapshotSha256:string;migrations:unknown[]};
    assert.equal(manifest.migrations.length,46,'Use the complete canonical migration provenance, not a minimal substitute.');
    assert.equal(createHash('sha256').update(schema).digest('hex'),manifest.snapshotSha256,'Canonical schema snapshot does not match its recorded provenance.');
    const config=join(directory,'wrangler.json'),persist=join(directory,'state');
    await writeFile(config,JSON.stringify({
      name:`techlyup-crm-runtime-${randomUUID().slice(0,8)}`,
      main:join(root,'apps/api/src/index.ts'),compatibility_date:'2026-10-13',compatibility_flags:['nodejs_compat'],workers_dev:false,
      vars:{APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'true',APP_ANALYTICS_ENABLED:'false',APP_LEARNING_ENABLED:'false',APP_PLATFORM_ENABLED:'false',APP_CRM_ENABLED:'true',APP_CRM_CAPTURE_ENABLED:'true',APP_CRM_SENDING_ENABLED:'false',APP_CRM_INTEGRATIONS_ENABLED:'false',CRM_ANALYTICS_EXPORT_ENABLED:'false',TECHLYUP_ERP_ORG_ID:'appneural',APP_ALLOWED_ORIGINS:origin},
      d1_databases:[{binding:'REGISTRATIONS_DB',database_name:'techlyup-crm-runtime-local-only',database_id:'00000000-0000-0000-0000-000000000048',migrations_dir:join(root,'migrations/d1')}],
    }),{mode:0o600});
    const environment={...process.env,CI:'1',WRANGLER_SEND_METRICS:'false'};
    const cli=(args:string[])=>{
      const result=spawnSync(process.execPath,[wrangler,...args,'--config',config,'--persist-to',persist],{cwd:root,env:environment,encoding:'utf8',timeout:30000});
      assert.equal(result.status,0,'Disposable local CRM D1 operation failed. Raw private diagnostics are suppressed.');
      return result.stdout;
    };
    const sql=(query:string)=>{
      const output=cli(['d1','execute','REGISTRATIONS_DB','--local','--command',query,'--json']);
      try{return JSON.parse(output) as {results:Record<string,unknown>[];success:boolean}[];}catch{throw new Error('Disposable D1 did not return valid structured results.');}
    };
    cli(['d1','execute','REGISTRATIONS_DB','--local','--file',schemaPath]);
    cli(['d1','migrations','apply','REGISTRATIONS_DB','--local']);
    worker=spawn(process.execPath,[wrangler,'dev','--local','--config',config,'--persist-to',persist,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--test-scheduled','--log-level','error','--show-interactive-dev-session=false'],{cwd:root,env:environment,detached:true,stdio:['ignore','pipe','pipe']});
    // Drain without logging: even disposable sessions/tokens stay private.
    worker.stdout?.on('data',()=>{});worker.stderr?.on('data',()=>{});
    let ready=false;
    for(let count=0;count<200;count++){
      if(worker.exitCode!==null||worker.signalCode!==null)throw new Error('Disposable CRM Worker exited before readiness.');
      try{const response=await fetch(`${origin}/api/v1/health`,{signal:AbortSignal.timeout(500)});if(response.status===200&&(await response.json() as {data?:{status:string}}).data?.status==='ready'){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,'Disposable CRM Worker did not report migrated storage readiness.');
    async function call<T=unknown>(path:string,options:{method?:string;body?:unknown;access?:string;key?:string;web?:boolean;cookie?:string}={}){
      const response=await fetch(`${origin}/api/v1${path}`,{method:options.method??(options.body===undefined?'GET':'POST'),headers:{'X-TechlyUp-Client':options.web?'web':'ios',...(options.web?{Origin:origin}:{}),...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.access?{Authorization:`Bearer ${options.access}`} :{}),...(options.key?{'Idempotency-Key':options.key}:{}),...(options.cookie?{Cookie:options.cookie}:{})},...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),signal:AbortSignal.timeout(10000)});
      const body=await response.json() as ApiResponse<T>;
      assert.match(response.headers.get('cache-control')??'',/no-store/);
      return {status:response.status,data:'data' in body?body.data:null,error:'error' in body?body.error.code:null,headers:response.headers};
    }
    const signup=(email:string)=>{const issued=seededCode(email);sql(issued.sql);return call<AuthSession>('/auth/signup',{body:{...signupInput,firstName:'Synthetic',lastName:'CRM Runtime',email,challengeId:issued.challengeId,code:issued.code}});};
    const staff=await signup('crm-runtime-staff@example.invalid'),learner=await signup('crm-runtime-learner@example.invalid');
    assert.equal(staff.status,201);assert.equal(learner.status,201);assert.ok(staff.data?.accessToken);assert.ok(learner.data?.accessToken);
    const access=staff.data!.accessToken,staffId=staff.data!.user.id;
    assert.match(staffId,/^[A-Za-z0-9_-]+$/,'Synthetic canonical account ID must be safe for the fixed local fixture statement.');
    assert.equal((await call('/crm/leads',{access})).status,403);
    sql(`INSERT INTO live_core_staff_links(learner_account_id,org_id,actor_id,actor_role,actor_email,actor_name,expires_at,linked_by_actor_id,created_at,updated_at) VALUES('${staffId}','appneural','synthetic-runtime-admin','admin','crm-runtime-staff@example.invalid','Synthetic CRM Runtime','2099-01-01T00:00:00.000Z','local-runtime-test',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    const capabilities=await call<{canRead:boolean;dispatchEnabled:boolean}>('/crm/capabilities',{access});assert.equal(capabilities.status,200);assert.equal(capabilities.data?.canRead,true);assert.equal(capabilities.data?.dispatchEnabled,false);
    const capture={name:'Synthetic Runtime Prospect',email:'crm-runtime-prospect@example.invalid',kind:'course',interest:'Runtime learning enquiry',consent:{service:true,marketing:true,whatsapp:true,policyVersion:'2026-10'}};
    const rejected=await call('/crm/capture',{body:{...capture,consent:{...capture.consent,service:false}},key:randomUUID()});assert.equal(rejected.status,422);
    const key=randomUUID(),created=await call<{accepted:boolean;reference:string}>('/crm/capture',{body:capture,key});assert.equal(created.status,202);assert.ok(created.data?.reference);
    const replay=await call<{reference:string}>('/crm/capture',{body:capture,key});assert.equal(replay.status,202);assert.equal(replay.data?.reference,created.data!.reference);
    const deduped=await call<{reference:string}>('/crm/capture',{body:{...capture,name:'Untrusted duplicate name'},key:randomUUID()});assert.equal(deduped.status,202);assert.equal(deduped.data?.reference,created.data!.reference);
    const search=await call<{leads:CrmLead[]}>('/crm/leads/search',{access,body:{q:'Runtime learning'}});assert.equal(search.status,200);assert.equal(search.data?.leads.length,1);assert.equal(search.data?.leads[0].name,capture.name);assert.equal(search.data?.leads[0].accountId,null);
    const leadId=created.data!.reference,current=search.data!.leads[0];
    const patched=await call<CrmLead>(`/crm/leads/${leadId}`,{method:'PATCH',access,key:randomUUID(),body:{expectedVersion:current.version,stage:'qualified',ownerAccountId:staffId}});assert.equal(patched.status,200);assert.equal(patched.data?.version,current.version+1);
    const stale=await call(`/crm/leads/${leadId}`,{method:'PATCH',access,key:randomUUID(),body:{expectedVersion:current.version,stage:'lost'}});assert.equal(stale.status,409);assert.equal(stale.error,'crm_conflict');
    const note=await call(`/crm/leads/${leadId}/activities`,{access,key:randomUUID(),body:{kind:'note',note:'Synthetic runtime follow-up requested.'}});assert.equal(note.status,201);
    const task=await call<CrmTask>(`/crm/leads/${leadId}/tasks`,{access,key:randomUUID(),body:{title:'Review requested information',dueAt:'2026-12-01T00:00:00.000Z',assignedAccountId:staffId}});assert.equal(task.status,201);assert.ok(task.data?.id);
    const reloaded=await call<CrmLeadDetail>(`/crm/leads/${leadId}`,{access});assert.equal(reloaded.status,200);assert.equal(reloaded.data?.lead.stage,'qualified');assert.equal(reloaded.data?.tasks.length,1);assert.ok(reloaded.data?.activities.some(item=>item.kind==='note'));assert.ok(reloaded.data?.consents.every(item=>item.state==='pending'));
    assert.equal((await call(`/crm/leads/${leadId}`,{access:learner.data!.accessToken})).status,403);
    const event={event:'page_view',page:'learn'},consent={granted:true,external:false,policyVersion:'crm-analytics-2026-10'};
    assert.equal((await call('/crm/visitor/events',{web:true,body:event})).status,403);
    const visitor=await call('/crm/visitor/consent',{web:true,body:consent});assert.equal(visitor.status,201);const visitorCookie=visitor.headers.get('set-cookie')?.split(';')[0];assert.ok(visitorCookie);assert.match(visitor.headers.get('set-cookie')??'',/HttpOnly.*SameSite=Strict/);
    assert.equal((await call('/crm/visitor/events',{web:true,cookie:visitorCookie,body:{...event,email:'forbidden@example.invalid'}})).status,422);
    assert.equal((await call('/crm/visitor/events',{web:true,cookie:visitorCookie,body:event})).status,202);
    assert.equal((await call('/crm/visitor/consent',{web:true,cookie:visitorCookie,body:{...consent,granted:false}})).status,200);
    assert.equal((await call('/crm/visitor/events',{web:true,cookie:visitorCookie,body:event})).status,403);
    // Actual D1 batch rollback must include contact/lead, declarations, receipt
    // and audit. A synthetic trigger is scoped to this disposable database only.
    sql("CREATE TRIGGER crm_runtime_synthetic_audit_failure BEFORE INSERT ON crm_audit_events BEGIN SELECT RAISE(ABORT,'synthetic runtime audit failure'); END");
    const failed=await call('/crm/capture',{key:randomUUID(),body:{...capture,email:'crm-runtime-rollback@example.invalid'}});assert.equal(failed.status,503);assert.equal(failed.error,'crm_storage_unavailable');
    sql('DROP TRIGGER crm_runtime_synthetic_audit_failure');
    const counts=sql(`SELECT (SELECT count(*) FROM crm_contacts) contacts,(SELECT count(*) FROM crm_contacts WHERE email='crm-runtime-rollback@example.invalid') rolledBackContacts,(SELECT count(*) FROM crm_leads) leads,(SELECT count(*) FROM crm_contact_permissions WHERE state='granted') verifiedPermissions,(SELECT count(*) FROM crm_pipeline_history) stageChanges,(SELECT count(*) FROM crm_visitor_events) visitorEvents,(SELECT count(*) FROM learner_accounts) canonicalAccounts,(SELECT count(*) FROM crm_jobs) jobs,(SELECT count(*) FROM crm_audit_events WHERE action='capture') captureAudits,(SELECT count(*) FROM crm_commands WHERE operation='capture') captureReceipts,(SELECT count(*) FROM crm_consent_events) consentEvents`)[0].results[0];
    assert.deepEqual(counts,{contacts:1,rolledBackContacts:0,leads:1,verifiedPermissions:0,stageChanges:1,visitorEvents:0,canonicalAccounts:2,jobs:0,captureAudits:2,captureReceipts:2,consentEvents:4});
    // Exercise the real canonical form trigger and scheduled projection without
    // copying the old form API or adding historical identity inference.
    sql(`INSERT INTO submissions(id,kind,payload,status,meta,created_at,updated_at) VALUES('synthetic-runtime-canonical-form','website','{"name":"Synthetic Canonical Runtime Contact","email":"crm-runtime-canonical@example.invalid","consent":"true","consentVersion":"2026-10","sourcePath":"/contact"}','new','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    const scheduled=await fetch(`${origin}/__scheduled`,{signal:AbortSignal.timeout(10000)});assert.equal(scheduled.status,200);
    const projected=await call<{leads:CrmLead[]}>('/crm/leads/search',{access,body:{q:'crm-runtime-canonical@example.invalid'}});assert.equal(projected.status,200);assert.equal(projected.data?.leads.length,1);assert.equal(projected.data?.leads[0].accountId,null);
    const projectedState=sql("SELECT state FROM crm_canonical_outbox WHERE source_id='synthetic-runtime-canonical-form'")[0].results[0];assert.equal(projectedState.state,'done');
    sql(`UPDATE live_core_staff_links SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE learner_account_id='${staffId}'`);
    assert.equal((await call(`/crm/leads/${leadId}`,{access})).status,403);
    assert.equal((await call('/crm/capabilities',{access})).data!==null,true);
  }finally{if(worker)await stop(worker);await rm(directory,{recursive:true,force:true});}
});
