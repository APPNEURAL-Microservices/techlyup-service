import {database} from '../config';
import type {Env} from '../types';
const manager=`(s.actor_role IN('owner','admin','manager') OR EXISTS(SELECT 1 FROM webinar_erp_roles r WHERE r.org_id=s.org_id AND r.actor_id=s.actor_id AND r.functional_role IN('operations','academic_admin','coordinator')))`;
const current=`s.revoked_at IS NULL AND s.expires_at>? AND lower(s.actor_email)=lower(a.email) AND (${manager} OR (l.owner_account_id=s.learner_account_id AND EXISTS(SELECT 1 FROM webinar_erp_roles r WHERE r.org_id=s.org_id AND r.actor_id=s.actor_id AND r.functional_role IN('sales','crm','assistant'))))`;
/** Only explicit staff-created task versions enter due workflows. Tasks created
 * by automation may alert staff but cannot recursively spawn due workflows. */
export async function enqueueDueTaskRules(env:Env,now=new Date()){
 if(env.APP_CRM_ENABLED!=='true')return {queued:0};const db=database(env),org=env.TECHLYUP_ERP_ORG_ID!,at=now.toISOString();
 const result=await db.prepare(`INSERT OR IGNORE INTO crm_outbox(org_id,id,lead_id,event_type,created_at,updated_at)
 SELECT t.org_id,'task_due:'||t.id||':'||t.version,t.lead_id,'task_due',?,? FROM crm_tasks t JOIN crm_leads l ON l.org_id=t.org_id AND l.id=t.lead_id
 JOIN live_core_staff_links s ON s.org_id=t.org_id AND s.learner_account_id=t.assigned_account_id JOIN learner_accounts a ON a.id=s.learner_account_id
 WHERE t.org_id=? AND t.status='open' AND t.origin='staff' AND t.due_at<=? AND ${current}
 AND NOT EXISTS(SELECT 1 FROM crm_outbox o WHERE o.org_id=t.org_id AND o.id='task_due:'||t.id||':'||t.version) ORDER BY t.due_at,t.id LIMIT 25`).bind(at,at,org,at,at).run();return {queued:result.meta.changes};
}
export async function currentDueTask(env:Env,eventId:string,leadId:string,now=new Date()){
 const parts=/^task_due:([a-f0-9-]{36}):([1-9][0-9]*)$/.exec(eventId);if(!parts)return null;const org=env.TECHLYUP_ERP_ORG_ID!,at=now.toISOString();
 const row=await database(env).prepare(`SELECT t.id,t.version FROM crm_tasks t JOIN crm_leads l ON l.org_id=t.org_id AND l.id=t.lead_id JOIN live_core_staff_links s ON s.org_id=t.org_id AND s.learner_account_id=t.assigned_account_id JOIN learner_accounts a ON a.id=s.learner_account_id WHERE t.org_id=? AND t.id=? AND t.version=? AND t.lead_id=? AND t.status='open' AND t.origin='staff' AND t.due_at<=? AND ${current}`).bind(org,parts[1],Number(parts[2]),leadId,at,at).first<{id:string;version:number}>();return row;
}
