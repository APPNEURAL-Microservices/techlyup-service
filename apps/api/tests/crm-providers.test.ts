import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dispatchNotification, inspectNotification, notificationConfigured, type CrmEnv, type DispatchInput } from '../src/crm/providers';
import { signCrmRelay, verifyCrmRelay } from '../src/crm/integrations';

const jobId='77777777-7777-4777-8777-777777777777',leadId='88888888-8888-4888-8888-888888888888';
const input:DispatchInput={jobId,leadId,channel:'email',recipient:'synthetic@example.test',name:'Synthetic',subject:'Requested learning updates',body:'A synthetic local fixture.',unsubscribeUrl:`https://app.techlyup.com/communication-preferences#token=${'x'.repeat(43)}`};
const base:CrmEnv={APP_ENV:'test',CRM_NOTIFICATION_ALLOW_LOCAL:'true',CRM_NOTIFICATION_CREDENTIAL:'synthetic-private-workload-credential',CRM_NOTIFICATION_TENANT_ID:'techlyup',CRM_NOTIFICATION_SUBJECT_ID:'techlyup-service',CRM_NOTIFICATION_EMAIL_TYPE:'techlyup.acquisition.email',CRM_PUBLIC_ORIGIN:'https://app.techlyup.com',APP_ALLOWED_ORIGINS:'https://app.techlyup.com'};
const receipt={id:'nfi_123',tenantId:'techlyup',sourceService:'techlyup-service',sourceEventId:jobId,sourceResourceId:leadId,status:'CREATED'};

test('acquisition delegates fixed intent protocol to existing notification owner over real local HTTP and preserves acceptance boundary',async()=>{
  const seen:Array<{path:string|undefined;headers:Record<string,unknown>;body:any}>=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;seen.push({path:req.url,headers:req.headers,body:raw?JSON.parse(raw):null});res.setHeader('content-type','application/json');res.end(JSON.stringify({data:receipt}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const env={...base,CRM_NOTIFICATION_ORIGIN:`http://127.0.0.1:${address.port}`};
  try{
    const result=await dispatchNotification(env,input,async()=>true);
    assert.deepEqual(result,{state:'accepted',nativeIntentId:'nfi_123'});
    assert.equal(seen.length,1);assert.equal(seen[0].path,'/api/v1/notification-intents');
    assert.equal(seen[0].headers['x-tenant-id'],'techlyup');assert.equal(seen[0].headers['idempotency-key'],`techlyup-crm:${jobId}`);
    assert.deepEqual(seen[0].body.recipientSpec,{type:'EXPLICIT_CONTACT',contacts:{EMAIL:input.recipient}});
    assert.equal(seen[0].body.sourceService,'techlyup-service');assert.equal(seen[0].body.sourceResourceId,leadId);
    assert.equal(seen[0].body.payload.unsubscribeUrl,input.unsubscribeUrl);
    const proof=await inspectNotification(env,{jobId,leadId,nativeIntentId:'nfi_123'});
    assert.equal(proof.intentAccepted,true);assert.equal(proof.deliveryVerified,false);assert.equal(proof.nativeStatus,'CREATED');
    assert.equal(seen[1].path,'/api/v1/notification-intents/nfi_123');
    const denied=await dispatchNotification(env,input,async()=>false);assert.equal(denied.state,'blocked');assert.equal(seen.length,2);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('provider responses, redirects, stale consent and unknown acceptance cannot create blind retries or delivered proof',async()=>{
  const env={...base,CRM_NOTIFICATION_ORIGIN:'http://127.0.0.1:9999'};let sends=0;
  const fake=(response:()=>Response)=>async()=>{sends++;return response();};
  for(const response of [()=>new Response('',{status:503}),()=>new Response('',{status:429}),()=>new Response('',{status:302,headers:{location:'https://untrusted.example'}}),()=>Response.json({data:{...receipt,tenantId:'foreign'}}),()=>Response.json({data:{...receipt,status:'DELIVERED'}}),()=>Response.json({data:receipt},{headers:{'content-type':'text/plain'}}),()=>Response.json({data:{...receipt,padding:'x'.repeat(66000)}})]){
    const before=sends;const result=await dispatchNotification(env,input,async()=>true,fake(response) as typeof fetch);assert.equal(result.state,'uncertain');assert.equal(sends,before+1);
  }
  const rejected=await dispatchNotification(env,input,async()=>true,fake(()=>new Response('',{status:403})) as typeof fetch);assert.equal(rejected.state,'failed');
  const before=sends;await dispatchNotification(env,input,async()=>{throw new Error('private source unavailable');},fake(()=>Response.json({data:receipt})) as typeof fetch);assert.equal(sends,before);
  for(const unsubscribeUrl of ['https://foreign.example/communication-preferences#token='+('x'.repeat(43)), 'https://app.techlyup.com/communication-preferences?token='+('x'.repeat(43)), 'https://app.techlyup.com/account']){
    const denied=await dispatchNotification(env,{...input,unsubscribeUrl},async()=>true,fake(()=>Response.json({data:receipt})) as typeof fetch);assert.equal(denied.state,'blocked');assert.equal(sends,before);
  }
  const production={...env,APP_ENV:'production'};assert.equal(notificationConfigured(production,'email'),false);
  assert.equal(notificationConfigured({...env,CRM_NOTIFICATION_ORIGIN:'https://owner.example/path'},'email'),false);
  await assert.rejects(inspectNotification(env,{jobId,leadId,nativeIntentId:'arbitrary/foreign'},fake(()=>Response.json({data:receipt})) as typeof fetch));
});

test('approved relay signature binds bounded exact payload, path, freshness and nonce rather than implying raw vendor authenticity',async()=>{
  const secret='synthetic-local-approved-relay-secret-1234567890',path='/api/v1/crm/webhooks/relay',raw='{"provider":"external"}';
  const headers=await signCrmRelay(secret,path,raw);
  const request=new Request(`https://app.example.test${path}`,{method:'POST',headers,body:raw});
  assert.equal(await verifyCrmRelay({CRM_WEBHOOK_SECRET:secret},request,raw),headers['x-techlyup-crm-nonce']);
  await assert.rejects(verifyCrmRelay({CRM_WEBHOOK_SECRET:secret},request,raw+' '));
  await assert.rejects(verifyCrmRelay({CRM_WEBHOOK_SECRET:secret},new Request('https://app.example.test/api/v1/crm/capture',{headers}),raw));
  await assert.rejects(verifyCrmRelay({CRM_WEBHOOK_SECRET:secret},request,raw,Date.now()+301000));
});
