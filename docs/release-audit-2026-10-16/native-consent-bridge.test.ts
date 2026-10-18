/** Cross-owner source acceptance. Only disposable SQLite and a loopback HTTP
 * synthetic gateway are used. This is not a staging/vendor delivery receipt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fixture} from '../../apps/api/tests/fixture';
import {CrmRepository} from '../../apps/api/src/crm/repository';
import {runCrmAutomation} from '../../apps/api/src/crm/automation';
import {DeliveryAuthorities} from '../../../messaging-service/src/transport/delivery-authority';
import {NativeMessagingProvider} from '../../../messaging-service/src/transport/providers';
import {TransportService} from '../../../messaging-service/src/transport/service';
import {observedOwners,observedProviders} from '../../../messaging-service/src/observability/transport';
import {deliverySourceMetadata,assertAcquisitionDeliveryMode,assertDeliverySourceMetadata} from '../../../notification-service/src/orchestration/delivery-source';
import {NotificationOrchestrator} from '../../../notification-service/src/orchestration/service';
import {hash} from '../../../notification-service/src/orchestration/context';

test('native notification provenance and instrumented provider guard use a valid current CRM decision; withdrawal, swaps and replay never dispatch',async()=>{
 const f=fixture({fullCanonical:true,crm:true}),directory=await mkdtemp('/tmp/techlyup-native-authority-');
 const secret=randomBytes(48).toString('hex'),secretFile=join(directory,'authority.key');
 let vendorPosts=0,callbackCalls=0;let callbackFailure:'none'|'outage'|'expired'|'forged'|'replay'='none';let replay:{body:unknown;headers:Record<string,string>}|undefined;
 const server=createServer((request,response)=>{
  vendorPosts++;
  let raw='';request.on('data',chunk=>{raw+=chunk;});request.on('end',()=>{
   const body=JSON.parse(raw);
   response.writeHead(200,{'content-type':'application/json'});
   response.end(JSON.stringify({tenantId:body.tenantId,accountRef:body.accountRef,messageId:body.messageId,idempotencyKey:body.idempotencyKey,contentHash:body.contentHash,status:'SENT',providerMessageId:'synthetic-loopback-acceptance',providerRequestId:null,definitiveAbsence:false,errorCategory:null,retryAfterSeconds:null}));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const gatewayOrigin=`http://127.0.0.1:${address.port}`;
 try{
  await writeFile(secretFile,secret,{mode:0o600});
  Object.assign(f.env,{APP_CRM_ENABLED:'true',APP_CRM_CAPTURE_ENABLED:'true',APP_CRM_SENDING_ENABLED:'true',CRM_NOTIFICATION_AUTHORITY_APPROVED:'true',CRM_DELIVERY_AUTH_SECRET:secret,CRM_NOTIFICATION_ORIGIN:'http://127.0.0.1:9999',CRM_NOTIFICATION_ALLOW_LOCAL:'true',CRM_NOTIFICATION_CREDENTIAL:randomBytes(32).toString('hex'),CRM_NOTIFICATION_TENANT_ID:'appneural',CRM_NOTIFICATION_SUBJECT_ID:'techlyup-service',CRM_NOTIFICATION_EMAIL_TYPE:'techlyup.acquisition.email',CRM_PUBLIC_ORIGIN:'https://app.techlyup.com',APP_ALLOWED_ORIGINS:'https://app.example.test,https://app.techlyup.com'});
  const at=new Date().toISOString(),email='synthetic-bridge-recipient@example.invalid';
  f.sqlite.prepare('INSERT INTO email_subscribers(email,name,status,unsubscribe_token,consent_at,verified_at,last_requested_at) VALUES(?,?,?,?,?,?,?)').run(email,'Synthetic recipient','active',randomUUID(),at,at,at);
  const repo=new CrmRepository(f.db),actor={orgId:'appneural',accountId:null,requestId:randomUUID()};
  const lead=await repo.capture(actor,{name:'Synthetic recipient',email,kind:'course',interest:'Synthetic local bridge',consent:{service:true,marketing:true,whatsapp:false,policyVersion:'2026-10'}},randomUUID(),{verifiedSource:{kind:'newsletter',reference:'newsletter:bridge-test',verifiedAt:at}});
  const integration=await repo.saveIntegration(actor,{name:'Synthetic native owner',provider:'native_notification',channel:'email',sourceRef:'techlyup-service',enabled:true},randomUUID());
  const campaign=await repo.saveCampaign(actor,{name:'Synthetic campaign',channel:'email',templateRef:'techlyup.acquisition.email',integrationId:integration.id,enabled:true},randomUUID());
  await repo.enqueueCampaign(actor,campaign.id,randomUUID());
  const intentId='nfi_synthetic_native_bridge';
  await runCrmAutomation(f.env,(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));return Response.json({data:{id:intentId,tenantId:'appneural',sourceService:'techlyup-service',sourceEventId:body.sourceEventId,sourceResourceId:body.sourceResourceId,status:'CREATED'}});}) as typeof fetch);
  const job=(await repo.listJobs(actor))[0];assert.equal(job.state,'accepted');
  const authority=new DeliveryAuthorities(JSON.stringify({appneural:{origin:'https://app.techlyup.com',secretFile,notificationSubject:'notification-service',sourceSubject:'techlyup-service',typeKeys:['techlyup.acquisition.email']}}),'test',async(url,method,headers,body)=>{
   callbackCalls++;if(callbackFailure==='outage')throw new Error('Synthetic authority timeout');assert.equal(method,'POST');assert.equal(url.pathname,'/api/v1/crm/delivery/authorize');
   const payload=JSON.parse(body!.toString());replay??={body:payload,headers};
   const receipt=await f.call('/crm/delivery/authorize',callbackFailure==='replay'?replay!:{body:payload,headers:callbackFailure==='forged'?{...headers,'x-techlyup-crm-signature':'0'.repeat(64)}:headers});
   if(callbackFailure==='expired'&&receipt.body.data)receipt.body.data.expiresAt=new Date(Date.now()-1000).toISOString();
   return {status:receipt.response.status,bytes:Buffer.from(JSON.stringify(receipt.body)),contentType:'application/json',headers:{},retryAfterSeconds:null};
  });
  const metadata={intentId,...deliverySourceMetadata({id:intentId,sourceService:'techlyup-service',sourceSubjectId:'techlyup-service',sourceEventId:job.id,sourceResourceType:'techlyup-acquisition',sourceResourceId:lead.id,typeKey:'techlyup.acquisition.email'})};
  const tenantId='appneural',connectionReference=randomUUID(),accountRef='synthetic-account',authReference='secret://synthetic-key';
  const senderIdentity={id:'identity-synthetic-sender',tenantId,normalizedValue:'synthetic-sender@example.invalid',status:'ACTIVE'};
  const sender={id:'sender-synthetic',tenantId,providerKey:'synthetic-gateway',identityId:senderIdentity.id,accountRef,connectionReference,displayName:'Synthetic sender',status:'ACTIVE',revision:1};
  const provider={id:'provider-synthetic',tenantId,key:'synthetic-gateway',accountRef,authReference};
  const route={id:'route-synthetic',tenantId,providerKey:provider.key,status:'ACTIVE',revision:1};
  const message={id:'msg_synthetic_bridge',tenantId,createdBy:'notification-service',channel:'EMAIL',status:'SENDING',classification:'MARKETING',subject:'Synthetic local acceptance',contentHash:'a'.repeat(64),contentRedactedAt:null,expiresAt:null,senderRevision:1,routeRevision:1,metadataSafe:metadata};
  const dispatch={message,sender,senderIdentity,provider,route,recipients:[{recipient:{id:'recipient-synthetic',tenantId,recipientType:'TO'},identity:{id:'identity-synthetic-recipient',tenantId,status:'ACTIVE',normalizedValue:email,identityHash:'b'.repeat(64)}}],attachments:[]};
  const nativeOwners={
   http:{config:{APP_ENV:'test',TRANSFER_MAX_BYTES:65536,OWNER_MAX_JSON_BYTES:65536,PROVIDER_TIMEOUT_MS:3000},credential:async()=>randomBytes(32).toString('hex')},
   authorize:async()=>{},publish:async()=>{},validateSender:async()=>{},body:async()=>({textBody:'Synthetic bounded content',htmlBody:null}),
   validateDeliverySource:(ctx:any,value:any)=>authority.validateCreation(ctx,value),authorizeExternalDispatch:(ctx:any,value:any)=>authority.authorize(ctx,value),
  };
  const owners=observedOwners(nativeOwners as any),registry={list:()=>[],get:()=>new NativeMessagingProvider(provider.key,tenantId,{protocol:'APPROVED_GATEWAY',origin:gatewayOrigin,region:'test',allowExternal:true,allowPrivateEndpoint:true,tenants:{[tenantId]:{accountRef,authReference,connectionReference,channels:['EMAIL'],allowedSenders:[senderIdentity.normalizedValue]}}} as any,owners as any)};
  const adapter=observedProviders(registry).get(provider.key,tenantId);
  const tx={assertLease:async()=>{},get:async(table:string,id:string)=>table==='messages'?message:table==='senders'?sender:table==='routes'?route:null,list:async()=>[]};
  const service=new TransportService({transaction:async(_tenant:string,run:any)=>run(tx)} as any,owners,registry,{identityHashKey:randomBytes(32).toString('hex')});
  const ctx={tenant:tenantId,subject:'messaging-worker',principalType:'SERVICE' as const,permissions:['messaging.admin'],requestId:randomUUID(),signal:AbortSignal.timeout(10000)};
  const creationCtx={...ctx,subject:'notification-service'};
  owners.validateDeliverySource!(creationCtx,metadata);
  assert.throws(()=>owners.validateDeliverySource!({...creationCtx,principalType:'USER'},metadata),error=>error instanceof Error&&error.message==='MESSAGING_EXTERNAL_SOURCE_INVALID');
  const send=()=>adapter.send(ctx,dispatch as any,()=>service.confirmDispatch(ctx,{} as any,dispatch as any));
  const valid=await send();assert.equal(valid.status,'SENT');assert.equal(vendorPosts,1);assert.equal(callbackCalls,1);
  assert.ok(replay);const repeated=await f.call('/crm/delivery/authorize',replay);assert.equal(repeated.response.status,409);
  for(const failure of ['outage','expired','forged','replay'] as const){callbackFailure=failure;const denied=await send();assert.equal(denied.status,'FAILED',`Synthetic ${failure} must fail before dispatch.`);assert.equal(vendorPosts,1);}
  callbackFailure='none';
  dispatch.recipients[0].identity.normalizedValue='recipient-swap@example.invalid';
  const swapped=await send();assert.equal(swapped.status,'FAILED');assert.equal(vendorPosts,1);
  dispatch.recipients[0].identity.normalizedValue=email;
  const token=await repo.issuePreferenceToken(actor,lead.id,'email');assert.equal((await f.call('/crm/preferences/revoke',{body:{token}})).response.status,200);
  const withdrawn=await send();assert.equal(withdrawn.status,'FAILED');assert.equal(withdrawn.errorCategory,'SUPPRESSED');assert.equal(vendorPosts,1,'Withdrawal must stop the actual provider adapter before its HTTP POST.');
  assert.equal(callbackCalls,7);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM crm_audit_events WHERE action='delivery_authorization'").get()?.n,4);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));f.close();await rm(directory,{recursive:true,force:true});}
});


test('notification orchestration rejects acquisition digest and frozen provenance stripping before sending while other sources retain digest behavior',async()=>{
 const provenance={id:'nfi_synthetic',sourceService:'techlyup-service',sourceSubjectId:'techlyup-service',sourceEventId:randomUUID(),sourceResourceType:'techlyup-acquisition',sourceResourceId:randomUUID(),typeKey:'techlyup.acquisition.email'};
 const metadata={intentId:provenance.id,...deliverySourceMetadata(provenance)};
 assertDeliverySourceMetadata(provenance,metadata);
 for(const key of Object.keys(metadata)){const stripped={...metadata};delete stripped[key as keyof typeof stripped];assert.throws(()=>assertDeliverySourceMetadata(provenance,stripped));}
 assert.throws(()=>assertAcquisitionDeliveryMode('techlyup-acquisition','MARKETING','DAILY'));
 assert.throws(()=>assertAcquisitionDeliveryMode('techlyup-acquisition','SYSTEM','IMMEDIATE'));
 assertAcquisitionDeliveryMode('techlyup-acquisition','MARKETING','IMMEDIATE');
 assertAcquisitionDeliveryMode('invoice','SYSTEM','DAILY');
 let sent=0;
 const bucket={id:'synthetic-digest',status:'QUEUED',windowEnd:'2000-01-01T00:00:00.000Z',messagingRequest:{metadataSafe:{digestBucketId:'synthetic-digest'}},requestHash:''};bucket.requestHash=hash(bucket.messagingRequest);
 const tx={assertLease:async()=>{},get:async()=>bucket};
 const service=new NotificationOrchestrator({transaction:async(_tenant:string,run:any)=>run(tx)} as any,{messaging:{send:async()=>{sent++;}}} as any,{} as any);
 service.scan=async function*(){yield {id:'synthetic-digest-item',attemptId:'synthetic-attempt'};} as any;
 service.deliveryContext=async()=>({intent:provenance}) as any;
 await assert.rejects(service.digest({tenantId:'appneural',entityId:bucket.id} as any),error=>error instanceof Error&&error.message==='NOTIFICATION_EXTERNAL_SOURCE_DIGEST_UNSUPPORTED');
 assert.equal(sent,0,'A previously frozen acquisition digest must never reach messaging without its lead authority.');
 service.source=async()=>({allowedTypes:['techlyup.acquisition.email'],allowedResolvers:['EXPLICIT_CONTACT']}) as any;
 service.type=async()=>({typeKey:'techlyup.acquisition.email',category:'MARKETING',digestMode:'DAILY'}) as any;
 await assert.rejects(service.createIntentTx({} as any,{subjectId:'techlyup-service'} as any,{typeKey:'techlyup.acquisition.email',sourceResourceType:'techlyup-acquisition',recipientSpec:{type:'EXPLICIT_CONTACT'}} as any,'synthetic-key'),error=>error instanceof Error&&error.message==='NOTIFICATION_EXTERNAL_SOURCE_MODE_UNSUPPORTED');
 assert.equal(sent,0);
});
