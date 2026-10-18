import {z} from 'zod';
import {database,type config} from '../config';
import {ApiError,type Env,type D1Statement} from '../types';
import {jsonBody,success} from '../http';
import type {Identity} from '../auth/service';
import {crmCapabilities} from './http';

const staff=`s.revoked_at IS NULL AND s.expires_at>? AND lower(s.actor_email)=lower(a.email)`;
const managers=`(s.actor_role IN('owner','admin','manager') OR EXISTS(SELECT 1 FROM webinar_erp_roles r WHERE r.org_id=s.org_id AND r.actor_id=s.actor_id AND r.functional_role IN('operations','academic_admin','coordinator')))`;
const members=`(${managers} OR EXISTS(SELECT 1 FROM webinar_erp_roles r WHERE r.org_id=s.org_id AND r.actor_id=s.actor_id AND r.functional_role IN('sales','crm','assistant')))`;
/** In-app alerts contain no recipient contact data and are visible only to the
 * current canonical team member. Creation and audit are one transaction. */
export async function createCrmNotifications(env:Env,now=new Date()){
 if(env.APP_CRM_ENABLED!=='true')return {created:0};
 const db=database(env),org=env.TECHLYUP_ERP_ORG_ID!,at=now.toISOString();
 const captures=await db.prepare(`SELECT o.id sourceId,o.lead_id leadId,s.learner_account_id recipientId FROM crm_outbox o
   JOIN live_core_staff_links s ON s.org_id=o.org_id JOIN learner_accounts a ON a.id=s.learner_account_id
   WHERE o.org_id=? AND o.event_type='capture' AND o.created_at>=s.created_at AND ${staff} AND ${managers}
   AND NOT EXISTS(SELECT 1 FROM crm_staff_notifications n WHERE n.org_id=o.org_id AND n.recipient_account_id=s.learner_account_id AND n.kind='new_lead' AND n.source_event_id=o.id)
   ORDER BY o.created_at,o.id LIMIT 25`).bind(org,at).all<{sourceId:string;leadId:string;recipientId:string}>();
 const due=await db.prepare(`SELECT t.id||':'||t.version sourceId,t.lead_id leadId,t.assigned_account_id recipientId FROM crm_tasks t
   JOIN crm_leads l ON l.org_id=t.org_id AND l.id=t.lead_id
   JOIN live_core_staff_links s ON s.org_id=t.org_id AND s.learner_account_id=t.assigned_account_id JOIN learner_accounts a ON a.id=s.learner_account_id
   WHERE t.org_id=? AND t.status='open' AND t.due_at<=? AND ${staff} AND ${members} AND (${managers} OR l.owner_account_id=s.learner_account_id)
   AND NOT EXISTS(SELECT 1 FROM crm_staff_notifications n WHERE n.org_id=t.org_id AND n.recipient_account_id=t.assigned_account_id AND n.kind='task_due' AND n.source_event_id=t.id||':'||t.version)
   ORDER BY t.due_at,t.id LIMIT 25`).bind(org,at,at).all<{sourceId:string;leadId:string;recipientId:string}>();
 const statements:D1Statement[]=[];
 for(const [kind,rows]of [['new_lead',captures.results],['task_due',due.results]]as const)for(const row of rows){
  const id=crypto.randomUUID();
  statements.push(db.prepare(`INSERT OR IGNORE INTO crm_staff_notifications(org_id,id,recipient_account_id,lead_id,kind,source_event_id,title,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(org,id,row.recipientId,row.leadId,kind,row.sourceId,kind==='new_lead'?'A new lead record is ready for review.':'An assigned follow-up task is due.',at),
   db.prepare(`INSERT INTO crm_audit_events(org_id,id,actor_account_id,request_id,action,resource_id,metadata,created_at)
    SELECT ?,?,NULL,?,'staff_alert',?,'{}',? WHERE changes()=1`).bind(org,crypto.randomUUID(),`alert:${id}`,id,at));
 }
 if(!statements.length)return {created:0};
 const result=await db.batch(statements);return {created:result.filter((_value,index)=>index%2===0).reduce((total,row)=>total+row.meta.changes,0)};
}
export async function handleCrmNotifications(request:Request,env:Env,identity:Identity,requestId:string,settings:ReturnType<typeof config>):Promise<Response|null>{
 const path=new URL(request.url).pathname,match=/^\/api\/v1\/crm\/notifications(?:\/([^/]+)\/read)?$/.exec(path);if(!match)return null;
 if(!crmCapabilities(identity,env,settings).canRead)throw new ApiError('crm_forbidden','Current CRM permission is required.',403);
 const db=database(env),org=env.TECHLYUP_ERP_ORG_ID!,account=identity.user.id;
 if(!match[1]&&request.method==='GET'){
  const rows=await db.prepare(`SELECT n.id,n.kind,n.lead_id leadId,n.title,n.created_at createdAt,n.read_at readAt FROM crm_staff_notifications n JOIN crm_leads l ON l.org_id=n.org_id AND l.id=n.lead_id
    WHERE n.org_id=? AND n.recipient_account_id=? AND (?=1 OR l.owner_account_id=?) ORDER BY n.created_at DESC,n.id DESC LIMIT 100`).bind(org,account,crmCapabilities(identity,env,settings).canAssign?1:0,account).all();
  return success({notifications:rows.results},requestId);
 }
 if(match[1]&&request.method==='POST'){
  const id=z.uuid().parse(match[1]);z.object({}).strict().parse(await jsonBody(request));
  const found=await db.prepare('SELECT n.id FROM crm_staff_notifications n JOIN crm_leads l ON l.org_id=n.org_id AND l.id=n.lead_id WHERE n.org_id=? AND n.id=? AND n.recipient_account_id=? AND (?=1 OR l.owner_account_id=?)').bind(org,id,account,crmCapabilities(identity,env,settings).canAssign?1:0,account).first();
  if(!found)throw new ApiError('crm_not_found','CRM notification not found.',404);
  const at=new Date().toISOString();
  await db.batch([
   db.prepare('UPDATE crm_staff_notifications SET read_at=? WHERE org_id=? AND id=? AND recipient_account_id=? AND read_at IS NULL').bind(at,org,id,account),
   db.prepare(`INSERT INTO crm_audit_events(org_id,id,actor_account_id,request_id,action,resource_id,metadata,created_at) SELECT ?,?,?,?,'alert_read',?,'{}',? WHERE changes()=1`).bind(org,crypto.randomUUID(),account,requestId,id,at),
  ]);
  return success({read:true},requestId);
 }
 throw new ApiError('method_not_allowed','This notification method is unavailable.',405);
}
