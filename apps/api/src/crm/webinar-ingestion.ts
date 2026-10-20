import {z} from 'zod';
import {ApiError,type Env} from '../types';
import {database} from '../config';
import {hash} from '../auth/crypto';
import {CrmRepository} from './repository';

export type WebinarCrmEnv=Env&{APP_CRM_WEBINAR_ENABLED?:string;SUPPORT_EXPECTED_CLIENT_ID?:string};
export interface WebinarCrmIdentity {orgId:string;accountId:string;liveSubject:string}
const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/);
export const webinarCrmEventSchema=z.object({
 eventId:z.uuid(),sessionId:ref,
 kind:z.enum(['REGISTRATION_CONFIRMED','ATTENDANCE_REVIEWED','OFFER_INTEREST']),
 occurredAt:z.iso.datetime({offset:true}),consentReceiptId:ref,
 serviceConsent:z.literal(true),marketingDeclared:z.boolean(),
}).strict();
export type WebinarCrmEvent=z.infer<typeof webinarCrmEventSchema>;
interface Intake {org_id:string;client_id:string;event_id:string;account_id:string;live_subject:string;session_id:string;kind:WebinarCrmEvent['kind'];occurred_at:string;consent_receipt_id:string;marketing_declared:number;attempts:number;payload_hash:string;state:string;lease_id:string|null}
const enabled=(env:WebinarCrmEnv)=>env.APP_ENABLED==='true'&&env.APP_CRM_ENABLED==='true'&&env.APP_CRM_CAPTURE_ENABLED==='true'&&env.APP_CRM_WEBINAR_ENABLED==='true';
async function activeLink(env:WebinarCrmEnv,identity:WebinarCrmIdentity){
 return database(env).prepare('SELECT a.id,a.name,a.email,a.email_verified FROM app_support_links l JOIN learner_accounts a ON a.id=l.account_id WHERE l.client_id=? AND l.live_subject=? AND l.account_id=? AND l.revoked_at IS NULL').bind(env.SUPPORT_EXPECTED_CLIENT_ID!,identity.liveSubject,identity.accountId).first<{id:string;name:string;email:string;email_verified:number}>();
}
/** Named, deployment-authenticated RPC calls this only after resolving the current
 * canonical link. No browser identity, email, transcript or private question is accepted. */
export async function ingestWebinarCrmEvent(env:WebinarCrmEnv,identity:WebinarCrmIdentity,raw:unknown){
 if(!enabled(env)||!env.SUPPORT_EXPECTED_CLIENT_ID||identity.orgId!==env.TECHLYUP_ERP_ORG_ID)throw new ApiError('webinar_crm_disabled','Webinar CRM intake is unavailable.',503);
 const input=webinarCrmEventSchema.parse(raw),at=new Date().toISOString(),time=Date.parse(input.occurredAt);
 if(time>Date.now()+300000||time<Date.now()-30*86400000)throw new ApiError('webinar_event_time_invalid','Use a current source event receipt.',422);
 if(!await activeLink(env,identity))throw new ApiError('link_required','Link your canonical TechlyUp account first.',409);
 const digest=await hash(JSON.stringify({identity,input})),db=database(env),client=env.SUPPORT_EXPECTED_CLIENT_ID;
 await db.prepare(`INSERT OR IGNORE INTO app_webinar_crm_intake(org_id,client_id,event_id,account_id,live_subject,session_id,kind,occurred_at,consent_receipt_id,marketing_declared,payload_hash,created_at,updated_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM app_support_links l JOIN learner_accounts a ON a.id=l.account_id WHERE l.client_id=? AND l.live_subject=? AND l.account_id=? AND l.revoked_at IS NULL)`).bind(identity.orgId,client,input.eventId,identity.accountId,identity.liveSubject,input.sessionId,input.kind,input.occurredAt,input.consentReceiptId,input.marketingDeclared?1:0,digest,at,at,client,identity.liveSubject,identity.accountId).run();
 const row=await db.prepare('SELECT payload_hash,state FROM app_webinar_crm_intake WHERE org_id=? AND client_id=? AND event_id=?').bind(identity.orgId,client,input.eventId).first<{payload_hash:string;state:string}>();
 if(!row)throw new ApiError('link_changed','Account linking changed before intake completed.',409);
 if(row.payload_hash!==digest)throw new ApiError('webinar_event_conflict','This event ID was already used for another event.',409);
 return {accepted:true,eventId:input.eventId,state:row.state,marketingVerified:false as const};
}

/** Ten local projections per run. This queues existing CRM events; it neither
 * sends a message nor enables an external analytics/marketing integration. */
export async function processWebinarCrmIntake(env:WebinarCrmEnv){
 if(!enabled(env)||!env.SUPPORT_EXPECTED_CLIENT_ID)return {processed:0,suppressed:0,review:0};
 const db=database(env),orgId=env.TECHLYUP_ERP_ORG_ID!,at=new Date().toISOString(),client=env.SUPPORT_EXPECTED_CLIENT_ID;
 // Repository source-event/command receipts make a crashed projection safe to resume.
 await db.prepare("UPDATE app_webinar_crm_intake SET state='PENDING',lease_id=NULL,lease_until=NULL WHERE org_id=? AND client_id=? AND state='PROCESSING' AND lease_until<?").bind(orgId,client,at).run();
 const rows=await db.prepare("SELECT * FROM app_webinar_crm_intake WHERE org_id=? AND client_id=? AND state='PENDING' ORDER BY created_at,event_id LIMIT 10").bind(orgId,client).all<Intake>();
 const totals={processed:0,suppressed:0,review:0};
 for(const row of rows.results){
  const lease=crypto.randomUUID(),claim=await db.prepare("UPDATE app_webinar_crm_intake SET state='PROCESSING',attempts=attempts+1,lease_id=?,lease_until=?,updated_at=? WHERE org_id=? AND client_id=? AND event_id=? AND state='PENDING'").bind(lease,new Date(Date.now()+60000).toISOString(),at,orgId,client,row.event_id).run();
  if(claim.meta.changes!==1)continue;
  try{
   const account=await activeLink(env,{orgId,accountId:row.account_id,liveSubject:row.live_subject});
   if(!account){await db.prepare("UPDATE app_webinar_crm_intake SET state='SUPPRESSED',result_code='link_unavailable',lease_id=NULL,lease_until=NULL,updated_at=? WHERE org_id=? AND client_id=? AND event_id=? AND lease_id=?").bind(at,orgId,client,row.event_id,lease).run();totals.suppressed++;continue;}
   const repo=new CrmRepository(db),actor={orgId,accountId:null,requestId:row.event_id};
   const lead=await repo.capture(actor,{
    name:account.name,email:account.email.toLowerCase(),kind:'webinar',interest:`Webinar ${row.session_id}`,source:'app:webinar',
    // Declared standalone marketing interest is retained only in the sparse intake
    // receipt. It never becomes a verified canonical marketing permission.
    consent:{service:true,marketing:false,whatsapp:false,policyVersion:'2026-10'},
   },`webinar:${row.event_id}`,{accountId:account.id,sourceEvent:{source:'standalone-webinar',externalId:row.event_id},processingProof:{sourceRef:'techlyup-live',externalId:row.event_id,policyVersion:'2026-10',occurredAt:row.occurred_at}});
   await repo.addActivity(actor,lead.id,{kind:row.kind==='OFFER_INTEREST'?'follow_up':'meeting',note:row.kind==='OFFER_INTEREST'?'Requested webinar offer details.':row.kind==='ATTENDANCE_REVIEWED'?'Host reviewed webinar participation.':'Confirmed webinar registration.'},`webinar-activity:${row.event_id}`);
   await db.prepare("UPDATE app_webinar_crm_intake SET state='DONE',lead_id=?,result_code='projected',lease_id=NULL,lease_until=NULL,updated_at=? WHERE org_id=? AND client_id=? AND event_id=? AND lease_id=?").bind(lead.id,new Date().toISOString(),orgId,client,row.event_id,lease).run();totals.processed++;
  }catch{
   const review=row.attempts+1>=5;
   await db.prepare("UPDATE app_webinar_crm_intake SET state=?,result_code='projection_unavailable',lease_id=NULL,lease_until=NULL,updated_at=? WHERE org_id=? AND client_id=? AND event_id=? AND lease_id=?").bind(review?'REVIEW_REQUIRED':'PENDING',new Date().toISOString(),orgId,client,row.event_id,lease).run();
   if(review)totals.review++;
  }
 }
 return totals;
}
