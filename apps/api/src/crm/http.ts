import { z } from 'zod';
import { crmActivitySchema, crmCampaignSchema, crmCaptureSchema, crmIntegrationSchema, crmLeadFilterSchema, crmLeadPatchSchema, crmPublicCaptureSchema, crmRuleSchema, crmTaskSchema, type CrmCapabilities } from '@techlyup/contracts';
import { ApiError, type Env } from '../types';
import { database, type config } from '../config';
import { jsonBody, success } from '../http';
import { authenticate, rateLimit, type Identity } from '../auth/service';
import { CrmRepository } from './repository';
import { inspectNotification, notificationConfigured } from './providers';
import { relayProviderApproved, verifyCrmRelay } from './integrations';
import { hash } from '../auth/crypto';

type Settings=ReturnType<typeof config>;
const empty=z.object({}).strict();
const uuid=z.uuid();
export function crmCapabilities(identity:Identity,env:Env,settings:Settings):CrmCapabilities {
  const roles=identity.user.roles,manager=roles.some(role=>['owner','admin','manager','operations','academic_admin','coordinator'].includes(role));
  const read=manager||roles.some(role=>['sales','crm','assistant'].includes(role));
  const admin=identity.user.permissions.includes('admin');
  return {enabled:settings.crm,canRead:settings.crm&&read,canWrite:settings.crm&&read,canAssign:settings.crm&&manager,
    canExport:settings.crm&&manager&&identity.user.permissions.includes('export'),canSend:settings.crm&&admin,
    dispatchEnabled:settings.crm&&settings.crmSending,source:'d1-acquisition',manageAutomation:settings.crm&&admin,manageIntegrations:settings.crm&&admin,
    providers:{email:notificationConfigured(env,'email'),whatsapp:notificationConfigured(env,'whatsapp'),meta:relayProviderApproved(env,'meta'),linkedin:relayProviderApproved(env,'linkedin'),external:relayProviderApproved(env,'external')}};
}
function requireCapability(allowed:boolean){if(!allowed)throw new ApiError('crm_forbidden','Current CRM permission is required.',403);}
function mutationKey(request:Request){const key=request.headers.get('idempotency-key')??'';if(!/^[A-Za-z0-9._:-]{8,180}$/.test(key))throw new ApiError('idempotency_required','Use a stable request key for this change.',422);return key;}
function query(request:Request){const entries=[...new URL(request.url).searchParams];if(entries.some(([key])=>key==='q'))throw new ApiError('private_search_required','Use the private search request for names and contact details.',422);if(new Set(entries.map(([key])=>key)).size!==entries.length)throw new ApiError('invalid_filter','Use each CRM filter once.',422);return crmLeadFilterSchema.parse(Object.fromEntries(entries));}
export async function handleCrm(request:Request,env:Env,identity:Identity,requestId:string,settings:Settings):Promise<Response>{
  const path=new URL(request.url).pathname.replace(/\/$/,''),suffix=path.slice('/api/v1/crm'.length),caps=crmCapabilities(identity,env,settings);
  if(suffix==='/capabilities'&&request.method==='GET')return success(caps,requestId);
  if(!settings.crm)throw new ApiError('crm_disabled','Acquisition CRM is not enabled in this environment.',503);
  requireCapability(caps.canRead);
  const db=database(env),repo=new CrmRepository(db),actor={orgId:env.TECHLYUP_ERP_ORG_ID!,accountId:identity.user.id,requestId,ownerOnly:!caps.canAssign};
  await rateLimit(db,'crm-staff',identity.user.id,120,60);
  const manager=caps.canAssign;
  const own=async(id:string)=>{const detail=await repo.detail(actor,uuid.parse(id));if(!manager&&detail.lead.ownerAccountId!==identity.user.id)throw new ApiError('crm_forbidden','This lead is assigned to another CRM team member.',403);return detail;};
  const key=()=>mutationKey(request);
  if(suffix==='/leads'&&request.method==='GET')return success(await repo.listLeads(actor,{...query(request),...(!manager?{ownerAccountId:identity.user.id}:{})}),requestId);
  if(suffix==='/leads/search'&&request.method==='POST')return success(await repo.listLeads(actor,{...crmLeadFilterSchema.parse(await jsonBody(request)),...(!manager?{ownerAccountId:identity.user.id}:{})}),requestId);
  if(suffix==='/leads'&&request.method==='POST'){
    requireCapability(caps.canWrite);const input=crmCaptureSchema.parse(await jsonBody(request));
    if(input.consent.service||input.consent.marketing||input.consent.whatsapp)throw new ApiError('crm_manual_consent_forbidden','Manual entry cannot grant a contact permission.',422);
    const lead=await repo.capture(actor,{...input,source:'staff_manual'},key());return success(lead,requestId,201);
  }
  const lead=/^\/leads\/([^/]+)(?:\/(activities|tasks))?$/.exec(suffix);
  if(lead){const detail=await own(lead[1]);
    if(!lead[2]&&request.method==='GET')return success(detail,requestId);
    requireCapability(caps.canWrite);
    if(!lead[2]&&request.method==='PATCH'){const input=crmLeadPatchSchema.parse(await jsonBody(request));if(input.ownerAccountId!==undefined)requireCapability(caps.canAssign);return success(await repo.updateLead(actor,detail.lead.id,input,key()),requestId);}
    if(lead[2]==='activities'&&request.method==='POST')return success(await repo.addActivity(actor,detail.lead.id,crmActivitySchema.parse(await jsonBody(request)),key()),requestId,201);
    if(lead[2]==='tasks'&&request.method==='POST'){const input=crmTaskSchema.parse(await jsonBody(request));if(input.assignedAccountId!==identity.user.id)requireCapability(caps.canAssign);return success(await repo.saveTask(actor,detail.lead.id,input,key()),requestId,201);}
  }
  const task=/^\/tasks\/([^/]+)$/.exec(suffix);
  if(task&&request.method==='PATCH'){
    requireCapability(caps.canWrite);const current=await repo.getTask(actor,uuid.parse(task[1]));await own(current.leadId);
    const raw=z.record(z.string(),z.unknown()).parse(await jsonBody(request));if(raw.taskId!==undefined&&raw.taskId!==current.id)throw new ApiError('crm_identity_mismatch','The task identity does not match this route.',422);
    const input=crmTaskSchema.parse({...raw,taskId:current.id});if(input.assignedAccountId!==identity.user.id)requireCapability(caps.canAssign);
    return success(await repo.saveTask(actor,current.leadId,input,key()),requestId);
  }
  if(suffix==='/staff'&&request.method==='GET'){requireCapability(caps.canAssign);return success({staff:await repo.listStaff(actor)},requestId);}
  if(suffix==='/tasks'&&request.method==='GET'){
    const filter=z.object({status:z.enum(['open','done','cancelled']).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    return success({tasks:await repo.listTasks(actor,filter)},requestId);
  }
  if(suffix==='/pipeline'&&(request.method==='GET'||request.method==='POST')){if(request.method==='POST')empty.parse(await jsonBody(request));return success(await repo.summary(actor),requestId);}
  if(suffix==='/export'&&request.method==='POST'){
    requireCapability(caps.canExport);const filter=crmLeadFilterSchema.parse(await jsonBody(request));key();const result=await repo.exportLeads(actor,filter);
    const cell=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+\-@\t\r]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;};
    const columns=['id','name','email','phone','kind','interest','source','stage','score','ownerAccountId','updatedAt'] as const;
    const content=[columns.map(cell).join(','),...result.leads.map(record=>columns.map(column=>cell(record[column])).join(','))].join('\r\n');
    return success({format:'csv',filename:'techlyup-acquisition-leads.csv',content,rowCount:result.leads.length,truncated:false},requestId);
  }
  if(suffix==='/campaigns'&&request.method==='GET'){requireCapability(caps.manageAutomation);return success({campaigns:await repo.listCampaigns(actor)},requestId);}
  if(suffix==='/campaigns'&&request.method==='POST'){requireCapability(caps.manageAutomation);return success(await repo.saveCampaign(actor,crmCampaignSchema.parse(await jsonBody(request)),key()),requestId,201);}
  const campaign=/^\/campaigns\/([^/]+)\/(preview|queue)$/.exec(suffix);
  if(campaign&&request.method==='POST'){
    requireCapability(caps.manageAutomation);await jsonBody(request).then(value=>empty.parse(value));
    if(campaign[2]==='preview')return success(await repo.enqueueCampaignPreview(actor,uuid.parse(campaign[1])),requestId);
    requireCapability(caps.canSend);return success(await repo.enqueueCampaign(actor,uuid.parse(campaign[1]),key()),requestId,202);
  }
  if(suffix==='/automations'&&request.method==='GET'){requireCapability(caps.manageAutomation);return success({rules:await repo.listRules(actor)},requestId);}
  const rule=/^\/automations(?:\/([^/]+))?$/.exec(suffix);
  if(rule&&(request.method==='POST'&&!rule[1]||request.method==='PATCH'&&rule[1])){
    requireCapability(caps.manageAutomation);const raw=z.record(z.string(),z.unknown()).parse(await jsonBody(request));if(rule[1]&&raw.id!==undefined&&raw.id!==rule[1])throw new ApiError('crm_identity_mismatch','The rule identity does not match this route.',422);
    return success(await repo.saveRule(actor,crmRuleSchema.parse({...raw,...(rule[1]?{id:uuid.parse(rule[1])}:{})}),key()),requestId,201);
  }
  if(suffix==='/integrations'&&request.method==='GET'){requireCapability(caps.manageIntegrations);return success({integrations:await repo.listIntegrations(actor)},requestId);}
  const integration=/^\/integrations(?:\/([^/]+))?$/.exec(suffix);
  if(integration&&(request.method==='POST'&&!integration[1]||request.method==='PATCH'&&integration[1])){
    requireCapability(caps.manageIntegrations);const raw=z.record(z.string(),z.unknown()).parse(await jsonBody(request));if(integration[1]&&raw.id!==undefined&&raw.id!==integration[1])throw new ApiError('crm_identity_mismatch','The integration identity does not match this route.',422);
    return success(await repo.saveIntegration(actor,crmIntegrationSchema.parse({...raw,...(integration[1]?{id:uuid.parse(integration[1])}:{})}),key()),requestId,201);
  }
  if(suffix==='/jobs'&&request.method==='GET'){requireCapability(caps.manageAutomation);return success({jobs:await repo.listJobs(actor)},requestId);}
  const job=/^\/jobs\/([^/]+)\/reconcile$/.exec(suffix);
  if(job&&request.method==='POST'){
    requireCapability(caps.canSend);empty.parse(await jsonBody(request));key();const current=await repo.getJob(actor,uuid.parse(job[1]));
    if(!current.nativeIntentId)throw new ApiError('crm_provider_proof_required','This job has no bound native intent. Manual delivery claims are not accepted.',409);
    const proof=await inspectNotification(env,{jobId:current.id,leadId:current.leadId,nativeIntentId:current.nativeIntentId});
    return success({job:current,proof},requestId);
  }
  throw new ApiError('not_found','CRM route not found.',404);
}

const relaySchema=z.object({provider:z.enum(['meta','linkedin','external']),integrationId:z.uuid(),sourceRef:z.string().trim().min(1).max(180),externalId:z.string().regex(/^[A-Za-z0-9._:-]{1,180}$/),
  processing:z.object({policyVersion:z.literal('2026-10'),occurredAt:z.iso.datetime({offset:true}),serviceRequested:z.literal(true)}).strict(),capture:crmCaptureSchema}).strict();
const decisionSchema=z.object({tenantId:z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),jobId:z.uuid(),leadId:z.uuid(),channel:z.enum(['email','whatsapp']),purpose:z.enum(['service','marketing']),recipientHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
async function rawRelay(request:Request){
  if(request.headers.get('content-type')?.toLowerCase().split(';')[0].trim()!=='application/json')throw new ApiError('invalid_content_type','Send a JSON request.',415);
  const reader=request.body?.getReader();if(!reader)throw new ApiError('invalid_json','Send valid JSON.',400);let total=0;const chunks:Uint8Array[]=[];
  try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>16000){await reader.cancel();throw new ApiError('body_too_large','Request is too large.',413);}chunks.push(part.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ApiError('invalid_json','Send valid JSON.',400);}
}
export async function handleCrmPublic(request:Request,env:Env,requestId:string,settings:Settings):Promise<Response|null>{
  const path=new URL(request.url).pathname.replace(/\/$/,'');
  if(!['/api/v1/crm/capture','/api/v1/crm/webhooks/relay','/api/v1/crm/preferences/revoke','/api/v1/crm/delivery/authorize'].includes(path))return null;
  if(request.method!=='POST')throw new ApiError('method_not_allowed','This CRM method is not supported.',405);
  const db=database(env),repo=new CrmRepository(db),actor={orgId:env.TECHLYUP_ERP_ORG_ID!,accountId:null as string|null,requestId};
  if(path.endsWith('/preferences/revoke')){
    const input=z.object({token:z.string().min(40).max(160).regex(/^[A-Za-z0-9_-]+$/)}).strict().parse(await jsonBody(request));
    await rateLimit(db,'crm-preference-ip',request.headers.get('cf-connecting-ip')??'local',30,60);
    const receipt=await repo.withdrawPreferenceToken(actor,input.token);
    if(!receipt.withdrawn)throw new ApiError('preference_link_invalid','This preference link has expired or is invalid.',422);
    return success({confirmed:true,marketingDisabled:true},requestId);
  }
  if(!settings.crm)throw new ApiError('crm_disabled','Acquisition CRM is not enabled.',503);
  if(path.endsWith('/delivery/authorize')){
    const raw=await rawRelay(request),nonce=await verifyCrmRelay({...env,CRM_WEBHOOK_SECRET:env.CRM_DELIVERY_AUTH_SECRET},request,raw);
    let value:unknown;try{value=JSON.parse(raw);}catch{throw new ApiError('invalid_json','Send valid JSON.',400);}
    const input=decisionSchema.parse(value);
    if(!await repo.consumeWebhookNonce(actor,nonce,await hash(raw)))throw new ApiError('crm_webhook_replay','This authorization was already used.',409);
    let allowed=false,reason='current_authority_required';
    try{
      const job=await repo.getJob(actor,input.jobId),campaign=await repo.getCampaign(actor,job.campaignId),integration=await repo.getIntegration(actor,job.integrationId);
      const eligible=await repo.eligibility(actor,job.leadId,job.channel,job.purpose);
      allowed=settings.crmSending&&env.CRM_NOTIFICATION_AUTHORITY_APPROVED==='true'&&input.tenantId===env.CRM_NOTIFICATION_TENANT_ID&&job.leadId===input.leadId&&job.channel===input.channel&&job.purpose===input.purpose&&['sending','accepted'].includes(job.state)&&campaign.enabled&&campaign.version===job.campaignVersion&&campaign.purpose==='marketing'&&campaign.templateRef===job.templateRef&&campaign.integrationId===job.integrationId&&integration.enabled&&integration.provider==='native_notification'&&integration.channel===job.channel&&integration.sourceRef===env.CRM_NOTIFICATION_SUBJECT_ID&&eligible.eligible&&eligible.contactHash===input.recipientHash;
      reason=allowed?'current_permission_verified':eligible.eligible?'binding_or_controls_changed':eligible.reason;
    }catch{allowed=false;reason='current_authority_unavailable';}
    const decisionId=crypto.randomUUID();
    await db.prepare('INSERT INTO crm_audit_events(org_id,id,actor_account_id,request_id,action,resource_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(actor.orgId,decisionId,null,requestId,'delivery_authorization',input.jobId,JSON.stringify({allowed,reason,channel:input.channel,purpose:input.purpose}),new Date().toISOString()).run();
    return success({allowed,reason,decisionId,expiresAt:new Date(Date.now()+5000).toISOString()},requestId);
  }
  if(path.endsWith('/capture')){
    if(!settings.crmCapture)throw new ApiError('crm_capture_disabled','Contact capture is not enabled.',503);
    await rateLimit(db,'crm-capture-ip',request.headers.get('cf-connecting-ip')??'local',10,60);
    const input=crmPublicCaptureSchema.parse(await jsonBody(request));
    if(!input.consent.service)throw new ApiError('processing_permission_required','Accept the current contact notice before sending your details.',422);
    if(request.headers.has('authorization'))actor.accountId=(await authenticate(db,actor.orgId,request.headers.get('authorization'))).user.id;
    // A declared first-party form label is useful attribution, never trusted
    // provider provenance. Arbitrary public strings cannot impersonate a relay.
    const forms=['contact','course','webinar','mentorship','resource','organization','newsletter','career'];
    const source=forms.some(form=>input.source===`app:${form}`)?input.source!:'app_capture';
    const lead=await repo.capture(actor,{...input,source,attribution:{...input.attribution,source}},request.headers.has('idempotency-key')?mutationKey(request):crypto.randomUUID(),actor.accountId?{accountId:actor.accountId}:undefined);
    return success({accepted:true,reference:lead.id},requestId,202);
  }
  if(!settings.crmIntegrations)throw new ApiError('crm_integrations_disabled','Approved lead integrations are not enabled.',503);
  const raw=await rawRelay(request),nonce=await verifyCrmRelay(env,request,raw);
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new ApiError('invalid_json','Send valid JSON.',400);}
  const input=relaySchema.parse(value);
  const occurredAt=Date.parse(input.processing.occurredAt);
  if(occurredAt>Date.now()||occurredAt<Date.now()-30*86400000)throw new ApiError('crm_processing_proof_expired','The approved submission processing proof is not current.',422);
  if(!relayProviderApproved(env,input.provider))throw new ApiError('crm_integration_unapproved','This lead source requires operator approval.',503);
  const integration=await repo.getIntegration(actor,input.integrationId);
  if(!integration.enabled||integration.provider!==input.provider||integration.sourceRef!==input.sourceRef)throw new ApiError('crm_integration_unapproved','This lead source is not active.',403);
  if(!await repo.consumeWebhookNonce(actor,nonce,await hash(raw)))throw new ApiError('crm_webhook_replay','This authorization was already used.',409);
  // Explicit source processing proof permits intake. A vendor-provided address
  // or checkbox never grants verified contact or marketing permission.
  const eventKey=await hash(JSON.stringify([input.provider,integration.sourceRef,input.externalId]));
  const lead=await repo.capture(actor,{...input.capture,source:input.provider,consent:{service:true,marketing:false,whatsapp:false,policyVersion:input.processing.policyVersion}},`relay:${eventKey}`,{sourceEvent:{source:`${input.provider}:${integration.sourceRef}`,externalId:input.externalId},processingProof:{sourceRef:integration.sourceRef,externalId:input.externalId,policyVersion:input.processing.policyVersion,occurredAt:input.processing.occurredAt}});
  return success({accepted:true,reference:lead.id},requestId,202);
}
