import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const directory=new URL('../test-results/studio-apps-20261021/',import.meta.url);
const setup=JSON.parse(await readFile(new URL('runtime-status.json',directory),'utf8'));
const cookie=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).filter(value=>value.split('=')[1]).join('; ');
const responseData=async response=>{const body=await response.json();if(!response.ok)throw new Error('Local acceptance request failed: '+response.status+' '+body.error?.code);return body;};
function valuesFor(resource){return Object.fromEntries(resource.fields.filter(field=>field.required).map(field=>[field.name,field.type==='checkbox'?true:field.type==='number'?Math.max(field.min??0,1):field.type==='select'?field.options[0].value:field.type==='date'?'2026-11-01':field.type==='url'?'https://techlyup.com/courses':field.name==='timezone'?'Asia/Kolkata':field.name==='startsAt'||field.name==='preferredTime'?'10:00':field.name==='endsAt'?'11:00':field.name.endsWith('Reference')?'assigned:synthetic-api-reference':`Synthetic API ${field.label}`]));}
const reports=[];
const ownershipChecks=[];
try{
 const fixture=await fetch(setup.qaTeacherUrl,{redirect:'manual'});assert.equal(fixture.status,303);
 const refresh=await fetch(setup.appOrigin+'/api/v1/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json',Origin:setup.appOrigin,'X-TechlyUp-Client':'web',Cookie:cookie(fixture)},body:'{}'});
 const central=await responseData(refresh),access=central.data.accessToken;assert.ok(access);assert.ok(central.data.user.id);
 for(const [id,base]of Object.entries(setup.productUrls)){
  // Each app is served by its own Worker through the central gateway at /studio/<app>.
  const origin=new URL(base).origin;
  const bare=await fetch(base,{redirect:'manual'});assert.equal(bare.status,308);assert.equal(bare.headers.get('location'),new URL(base).pathname+'/');
  const page=await fetch(base+'/'+id);assert.equal(page.status,200);assert.ok((await page.text()).includes(new URL(base).pathname+'/assets/'));
  const start=await fetch(base+'/api/auth/start',{redirect:'manual'});assert.equal(start.status,303);
  const authorize=new URL(start.headers.get('location')),challengeId=authorize.searchParams.get('challengeId');assert.ok(challengeId);
  const approved=await fetch(setup.appOrigin+'/api/v1/products/sign-in/authorize',{method:'POST',headers:{'Content-Type':'application/json',Origin:setup.appOrigin,'X-TechlyUp-Client':'web',Authorization:'Bearer '+access},body:JSON.stringify({challengeId})});
  const approval=await responseData(approved);assert.ok(approval.data.redirectUrl.startsWith(base+'/api/auth/callback?'));
  const callback=await fetch(approval.data.redirectUrl,{headers:{Cookie:cookie(start)},redirect:'manual'});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),new URL(base).pathname+'/');
  const sessionCookie=cookie(callback);assert.ok(sessionCookie);
  const headers={Cookie:sessionCookie,'X-TechlyUp-Account':central.data.user.id};
  const missingOwner=await fetch(base+'/api/workspace/',{headers:{Cookie:sessionCookie}});assert.equal(missingOwner.status,428);
  const changedOwner=await fetch(base+'/api/workspace/',{headers:{Cookie:sessionCookie,'X-TechlyUp-Account':'synthetic-stale-owner'}});assert.equal(changedOwner.status,409);
  const missingMutationOwner=await fetch(base+'/api/workspace/records',{method:'POST',headers:{Cookie:sessionCookie,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({resource:'intentionally-unknown',values:{}})});assert.equal(missingMutationOwner.status,428);
  const changedMutationOwner=await fetch(base+'/api/workspace/records',{method:'POST',headers:{Cookie:sessionCookie,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-TechlyUp-Account':'synthetic-stale-owner'},body:JSON.stringify({resource:'intentionally-unknown',values:{}})});assert.equal(changedMutationOwner.status,409);
  const metadata=await responseData(await fetch(base+'/api/workspace/',{headers}));
  assert.equal(metadata.capabilities.storage,'ready');assert.equal(metadata.capabilities.ownDrafts,true);
  assert.equal(metadata.capabilities.canonicalPublishing,false);assert.equal(metadata.capabilities.aiGeneration,false);
  let editable=0,gated=0;
  for(const resource of metadata.definition.resources){
   if(!resource.available){const denied=await fetch(base+'/api/workspace/records?resource='+resource.id,{headers});assert.equal(denied.status,503);gated++;continue;}
   const values=valuesFor(resource),key=randomUUID();
   const create=()=>fetch(base+'/api/workspace/records',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({resource:resource.id,values})});
   const created=await responseData(await create());assert.equal(created.record.status,'draft');assert.equal(created.record.version,1);
   const replay=await responseData(await create());assert.equal(replay.record.id,created.record.id);
   const records=await responseData(await fetch(base+'/api/workspace/records?resource='+resource.id+'&q=Synthetic%20API',{headers}));assert.ok(records.records.some(record=>record.id===created.record.id));
   const updateBody={version:1,values:{...values,title:'Synthetic API edited '+resource.label}};
   const updated=await responseData(await fetch(base+'/api/workspace/records/'+created.record.id,{method:'PATCH',headers:{...headers,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(updateBody)}));assert.equal(updated.record.version,2);
   const stale=await fetch(base+'/api/workspace/records/'+created.record.id,{method:'PATCH',headers:{...headers,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(updateBody)});assert.equal(stale.status,409);
   const archived=await responseData(await fetch(base+'/api/workspace/records/'+created.record.id+'/archive',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({version:2})}));assert.equal(archived.record.status,'archived');
   const fresh=await responseData(await fetch(base+'/api/workspace/records?resource='+resource.id,{headers}));assert.equal(fresh.records.some(record=>record.id===created.record.id),false);editable++;
  }
  const overview=await responseData(await fetch(base+'/api/workspace/overview',{headers}));assert.equal(overview.source,'own_workspace_records');
  const editableResource=metadata.definition.resources.find(resource=>resource.available);
  if(editableResource){
   const sentinel=await responseData(await fetch(base+'/api/workspace/records',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({resource:editableResource.id,values:{...valuesFor(editableResource),title:'Synthetic API owner isolation'}})}));
   ownershipChecks.push({id,base,origin,headers,resource:editableResource.id,record:sentinel.record});
  }
  const csrf=await fetch(base+'/api/auth/logout',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
  reports.push({app:id,authenticated:true,metadata:true,editableResourceJourneys:editable,canonicalGates:gated,overview:true,csrfDenied:true,missingAccountDenied:true,changedAccountDenied:true,missingAccountMutationDenied:true,changedAccountMutationDenied:true});
 }
 const learnerFixture=await fetch(setup.qaLearnerUrl,{redirect:'manual'});assert.equal(learnerFixture.status,303);
 const learnerCentral=await responseData(await fetch(setup.appOrigin+'/api/v1/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json',Origin:setup.appOrigin,'X-TechlyUp-Client':'web',Cookie:cookie(learnerFixture)},body:'{}'}));
 for(const item of ownershipChecks){
  const start=await fetch(item.base+'/api/auth/start',{redirect:'manual'}),challengeId=new URL(start.headers.get('location')).searchParams.get('challengeId');
  const approved=await responseData(await fetch(setup.appOrigin+'/api/v1/products/sign-in/authorize',{method:'POST',headers:{'Content-Type':'application/json',Origin:setup.appOrigin,'X-TechlyUp-Client':'web',Authorization:'Bearer '+learnerCentral.data.accessToken},body:JSON.stringify({challengeId})}));
  const callback=await fetch(approved.data.redirectUrl,{headers:{Cookie:cookie(start)},redirect:'manual'});assert.equal(callback.status,303);
  const learnerHeaders={Cookie:cookie(callback),'X-TechlyUp-Account':learnerCentral.data.user.id};
  const foreignRecords=await responseData(await fetch(item.base+'/api/workspace/records?resource='+item.resource,{headers:learnerHeaders}));assert.equal(foreignRecords.records.some(record=>record.id===item.record.id),false);
  const forbidden=await fetch(item.base+'/api/workspace/records/'+item.record.id,{method:'PATCH',headers:{...learnerHeaders,Origin:item.origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({version:1,values:item.record.values})});assert.equal(forbidden.status,403);
  const ownerReload=await responseData(await fetch(item.base+'/api/workspace/records?resource='+item.resource,{headers:item.headers}));assert.ok(ownerReload.records.some(record=>record.id===item.record.id));
  const archived=await responseData(await fetch(item.base+'/api/workspace/records/'+item.record.id+'/archive',{method:'POST',headers:{...item.headers,Origin:item.origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({version:1})}));assert.equal(archived.record.status,'archived');
 }
 await writeFile(new URL('api-acceptance.json',directory),JSON.stringify({passed:true,scope:'isolated-local-workerd-gateway-rpc-d1',apps:reports,resourceJourneys:reports.reduce((sum,item)=>sum+item.editableResourceJourneys,0),foreignOwnerReadDeniedApps:ownershipChecks.length,learnerWritesDeniedApps:ownershipChecks.length,externalProvidersExercised:false},null,2));
 process.stdout.write('PASS local authenticated workerd gateway/RPC/D1: 8 apps, '+reports.reduce((sum,item)=>sum+item.editableResourceJourneys,0)+' create/replay/reload/edit/version/archive resource journeys, '+ownershipChecks.length+' foreign-owner/learner-write denials, canonical gates and CSRF denials.\n');
}catch(error){process.stderr.write('Local API acceptance failed: '+error.message+'\n');process.exit(1);}
