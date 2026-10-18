/** Bounded local workerd/D1 measurement; no deployed URL or external provider. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url)),port=8901,origin=`http://127.0.0.1:${port}`,wrangler=join(root,'node_modules/wrangler/bin/wrangler.js');
const probe=createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',()=>reject(new Error('Owned load-test port unavailable.')));probe.listen(port,'127.0.0.1',()=>probe.close(()=>resolve()));});
const temporary=await mkdtemp('/tmp/techlyup-crm-bounded-load-');let worker:ChildProcess|undefined;
const start=new Date().toISOString();
try{
 const config=join(temporary,'wrangler.json'),persist=join(temporary,'state');
 await writeFile(config,JSON.stringify({name:'techlyup-crm-bounded-local-load',main:join(root,'apps/api/src/index.ts'),compatibility_date:'2026-10-13',compatibility_flags:['nodejs_compat'],workers_dev:false,vars:{APP_ENV:'test',APP_ENABLED:'true',APP_SIGNUP_ENABLED:'false',APP_ANALYTICS_ENABLED:'false',APP_LEARNING_ENABLED:'false',APP_PLATFORM_ENABLED:'false',APP_CRM_ENABLED:'true',APP_CRM_CAPTURE_ENABLED:'true',APP_CRM_SENDING_ENABLED:'false',APP_CRM_INTEGRATIONS_ENABLED:'false',CRM_ANALYTICS_EXPORT_ENABLED:'false',TECHLYUP_ERP_ORG_ID:'appneural',APP_ALLOWED_ORIGINS:origin},d1_databases:[{binding:'REGISTRATIONS_DB',database_name:'techlyup-crm-load-local-only',database_id:'00000000-0000-0000-0000-000000000049',migrations_dir:join(root,'migrations/d1')}]}),{mode:0o600});
 const environment={...process.env,CI:'1',WRANGLER_SEND_METRICS:'false'};
 const cli=(args:string[])=>{const result=spawnSync(process.execPath,[wrangler,...args,'--config',config,'--persist-to',persist],{cwd:root,env:environment,encoding:'utf8',timeout:30000});assert.equal(result.status===0,true,'Isolated local D1 command failed; raw diagnostics suppressed.');return result.stdout;};
 cli(['d1','execute','REGISTRATIONS_DB','--local','--file',join(root,'apps/api/tests/fixtures/website-schema-2026-10-16.sql')]);
 cli(['d1','migrations','apply','REGISTRATIONS_DB','--local']);
 worker=spawn(process.execPath,[wrangler,'dev','--local','--config',config,'--persist-to',persist,'--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--log-level','error','--show-interactive-dev-session=false'],{cwd:root,env:environment,detached:true,stdio:['ignore','pipe','pipe']});worker.stdout?.on('data',()=>{});worker.stderr?.on('data',()=>{});
 let ready=false;for(let count=0;count<200;count++){if(worker.exitCode!==null||worker.signalCode!==null)throw new Error('Isolated load Worker exited.');try{const response=await fetch(`${origin}/api/v1/health`,{signal:AbortSignal.timeout(500)});if(response.status===200){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(ready,true);
 const captures=Array.from({length:40},(_,index)=>({key:randomUUID(),body:{name:`Synthetic load ${index}`,email:`synthetic-bounded-load-${index}@example.invalid`,kind:'course',interest:'Synthetic bounded source measurement',consent:{service:true,marketing:false,whatsapp:false,policyVersion:'2026-10'}},ip:`198.18.0.${index+1}`}));
 const measurements:{phase:string;ms:number;status:number;code:string|null}[]=[];
 const references=new Map<number,string>();
 const request=async(index:number,phase:string,key=captures[index].key)=>{
  const input=captures[index],before=performance.now();const response=await fetch(`${origin}/api/v1/crm/capture`,{method:'POST',headers:{'content-type':'application/json','x-techlyup-client':'ios','idempotency-key':key,'cf-connecting-ip':input.ip},body:JSON.stringify(input.body),signal:AbortSignal.timeout(10000)});const value=await response.json() as any;
  measurements.push({phase,ms:performance.now()-before,status:response.status,code:value.error?.code??null});assert.equal(response.status===202,true,`Synthetic ${phase} failed with sanitized HTTP ${response.status} ${value.error?.code??''}.`);
  if(phase==='capture')references.set(index,value.data.reference);else assert.equal(value.data.reference===references.get(index),true,'Idempotent/deduped reference changed.');
 };
 const parallel=async(indexes:number[],phase:string,fresh=false)=>{let cursor=0;await Promise.all(Array.from({length:Math.min(10,indexes.length)},async()=>{while(cursor<indexes.length){const index=indexes[cursor++];await request(index,phase,fresh?randomUUID():undefined);}}));};
 const runStart=performance.now();await parallel(captures.map((_,index)=>index),'capture');await parallel(Array.from({length:10},(_,index)=>index),'idempotency_replay');await parallel(Array.from({length:10},(_,index)=>index),'contact_deduplication',true);const runMs=performance.now()-runStart;
 const countQuery="SELECT (SELECT count(*) FROM crm_contacts) contacts,(SELECT count(*) FROM crm_leads) leads,(SELECT count(*) FROM crm_commands WHERE operation='capture') captureReceipts,(SELECT count(*) FROM crm_audit_events WHERE action='capture') captureAudits,(SELECT count(*) FROM crm_jobs) communicationJobs,(SELECT count(*) FROM crm_contact_permissions WHERE state='granted') verifiedPermissions";
 const counts=JSON.parse(cli(['d1','execute','REGISTRATIONS_DB','--local','--command',countQuery,'--json']))[0].results[0];assert.deepEqual(counts,{contacts:40,leads:40,captureReceipts:50,captureAudits:50,communicationJobs:0,verifiedPermissions:0});
 const foreignKeys=JSON.parse(cli(['d1','execute','REGISTRATIONS_DB','--local','--command','PRAGMA foreign_key_check','--json']))[0].results;assert.equal(foreignKeys.length,0);
 const quickCheck=JSON.parse(cli(['d1','execute','REGISTRATIONS_DB','--local','--command','PRAGMA quick_check','--json']))[0].results;assert.deepEqual(quickCheck,[{quick_check:'ok'}]);
 const summarize=(items:typeof measurements)=>{const sorted=items.map(item=>item.ms).sort((a,b)=>a-b),percentile=(q:number)=>Number(sorted[Math.max(0,Math.ceil(sorted.length*q)-1)].toFixed(2));return {requests:items.length,p50Ms:percentile(.50),p95Ms:percentile(.95),p99Ms:percentile(.99),maximumMs:Number(sorted.at(-1)!.toFixed(2)),successes:items.filter(item=>item.status===202).length,failureCodes:[...new Set(items.filter(item=>item.status!==202).map(item=>`${item.status}:${item.code}`))]};};
 const files=['apps/api/src/index.ts','apps/api/src/crm/http.ts','apps/api/src/crm/repository.ts','migrations/d1/0048_crm_acquisition.sql','migrations/d1/0049_crm_canonical_sources.sql','migrations/d1/0050_crm_visitors.sql','migrations/d1/0051_crm_staff_alerts.sql'];
 const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')])));
 const report={startedAt:start,completedAt:new Date().toISOString(),environment:{scope:'isolated loopback workerd and SQLite-backed local D1; not staging or Cloudflare deployed capacity',node:process.version,platform:process.platform,architecture:process.arch,concurrency:10,uniqueSyntheticContacts:40,trustedIpSimulation:'40 distinct benchmarking-range headers, accepted only inside this isolated harness; no production trust bypass',sendingEnabled:false,integrationsEnabled:false,analyticsExportEnabled:false},summary:summarize(measurements),phases:Object.fromEntries(['capture','idempotency_replay','contact_deduplication'].map(phase=>[phase,summarize(measurements.filter(item=>item.phase===phase))])),elapsedRunMs:Number(runMs.toFixed(2)),persisted:counts,integrity:{foreignKeyViolations:0,quickCheck:'ok'},databaseQueryCount:'Not instrumented. Persisted audit/receipt counts are not SQL query counts.',limitations:['No attendee/stream/provider/payment/notification/AI cost load tested.','Warm local request sample only; bootstrap excluded.','No production throughput or SLA extrapolation.'],sourceSha256:hashes};
 await writeFile(new URL('./loopback-crm-load-result.json',import.meta.url),`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify(report,null,2));
}finally{
 if(worker&&worker.exitCode===null&&worker.signalCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{try{process.kill(-worker!.pid!,'SIGKILL');}catch{}resolve();},5000);worker!.once('exit',()=>{clearTimeout(timer);resolve();});try{process.kill(-worker!.pid!,'SIGTERM');}catch{clearTimeout(timer);resolve();}});
 await rm(temporary,{recursive:true,force:true});
}
