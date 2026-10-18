import { config, database } from '../config';
import { CrmRepository } from './repository';
import { dispatchNotification, publicCrmOrigin } from './providers';
import {enqueueDueTaskRules,currentDueTask} from './task-due';
import type { Env } from '../types';

/** Background work is bounded. The D1 ledger owns claims; a scheduler wakeup never
 * supplies a recipient, content, grant, session or provider status. */
export async function runCrmAutomation(env:Env,fetcher:typeof fetch=fetch){
  const settings=config(env);if(!settings.enabled||!settings.crm)return {rules:0,attempted:0,accepted:0,uncertain:0};
  const db=database(env),repo=new CrmRepository(db),actor={orgId:env.TECHLYUP_ERP_ORG_ID!,accountId:null,requestId:crypto.randomUUID()};
  let rules=0,attempted=0,accepted=0,uncertain=0;
  await repo.purgeExpiredTransientRecords(actor);
  await enqueueDueTaskRules(env);
  await db.prepare("UPDATE crm_outbox SET state='queued',lease_id=NULL,updated_at=? WHERE org_id=? AND id IN (SELECT id FROM crm_outbox WHERE org_id=? AND state='processing' AND updated_at<? LIMIT 10)").bind(new Date().toISOString(),actor.orgId,actor.orgId,new Date(Date.now()-300000).toISOString()).run();
  const due=await db.prepare("SELECT id,lead_id,event_type FROM crm_outbox WHERE org_id=? AND state='queued' ORDER BY created_at,id LIMIT 10").bind(actor.orgId).all<{id:string;lead_id:string;event_type:string}>();
  for(const event of due.results){
    const lease=crypto.randomUUID(),now=new Date().toISOString();
    const claimed=await db.prepare("UPDATE crm_outbox SET state='processing',lease_id=?,attempts=attempts+1,updated_at=? WHERE org_id=? AND id=? AND state='queued'").bind(lease,now,actor.orgId,event.id).run();
    if(claimed.meta.changes!==1)continue;
    try{
      const trigger=event.event_type==='capture'?'capture':event.event_type==='stage_changed'?'stage_changed':event.event_type==='activity'?'activity':event.event_type==='task_due'?'task_due':null;
      if(!trigger)throw new Error('unsupported_outbox_event');
      const dueTask=trigger==='task_due'?await currentDueTask(env,event.id,event.lead_id):null;
      if(trigger==='task_due'&&!dueTask){await db.prepare("UPDATE crm_outbox SET state='blocked',updated_at=? WHERE org_id=? AND id=? AND lease_id=?").bind(new Date().toISOString(),actor.orgId,event.id,lease).run();continue;}
      await repo.runRules(actor,event.lead_id,trigger,event.id,dueTask?{dueTask}:undefined);
      await db.prepare("UPDATE crm_outbox SET state='completed',updated_at=? WHERE org_id=? AND id=? AND state='processing' AND lease_id=?").bind(new Date().toISOString(),actor.orgId,event.id,lease).run();rules++;
    }catch{
      await db.prepare("UPDATE crm_outbox SET state=CASE WHEN attempts>=5 THEN 'blocked' ELSE 'queued' END,updated_at=? WHERE org_id=? AND id=? AND state='processing' AND lease_id=?").bind(new Date().toISOString(),actor.orgId,event.id,lease).run();
    }
  }
  // A process may have died after POST. Expired sending leases become uncertain,
  // never queued. Only a bound native receipt can later reconcile them.
  const stale=await db.prepare("SELECT id,lease_id FROM crm_jobs WHERE org_id=? AND state='sending' AND claimed_at<? ORDER BY claimed_at LIMIT 10").bind(actor.orgId,new Date(Date.now()-300000).toISOString()).all<{id:string;lease_id:string}>();
  for(const job of stale.results){await repo.finishJob(actor,job.id,job.lease_id,{state:'uncertain',errorCode:'dispatch_interrupted'});uncertain++;}
  if(!settings.crmSending||env.CRM_NOTIFICATION_AUTHORITY_APPROVED!=='true')return {rules,attempted,accepted,uncertain};
  const pending=await db.prepare("SELECT id FROM crm_jobs WHERE org_id=? AND state='queued' AND scheduled_at<=? ORDER BY scheduled_at,id LIMIT 2").bind(actor.orgId,new Date().toISOString()).all<{id:string}>();
  for(const pendingJob of pending.results){
    const lease=crypto.randomUUID(),job=await repo.claimJob(actor,pendingJob.id,lease,new Date().toISOString());if(!job)continue;
    let outcome:Parameters<CrmRepository['finishJob']>[3]={state:'blocked',errorCode:'authority_unavailable'};
    try{
      const campaign=await repo.getCampaign(actor,job.campaignId),integration=await repo.getIntegration(actor,job.integrationId),detail=await repo.detail(actor,job.leadId);
      const type=job.channel==='email'?env.CRM_NOTIFICATION_EMAIL_TYPE:env.CRM_NOTIFICATION_WHATSAPP_TYPE;
      const current=async()=>{
        const c=await repo.getCampaign(actor,job.campaignId),i=await repo.getIntegration(actor,job.integrationId);
        if(!c.enabled||c.version!==job.campaignVersion||c.purpose!=='marketing'||c.channel!==job.channel||c.templateRef!==job.templateRef||c.integrationId!==job.integrationId||!i.enabled||i.provider!=='native_notification'||i.channel!==job.channel||i.sourceRef!==env.CRM_NOTIFICATION_SUBJECT_ID||job.templateRef!==type)return false;
        return (await repo.eligibility(actor,job.leadId,job.channel,job.purpose)).eligible;
      };
      if(!campaign.enabled||campaign.version!==job.campaignVersion||campaign.purpose!=='marketing'||!integration.enabled||integration.provider!=='native_notification'||job.templateRef!==type){outcome={state:'blocked',errorCode:'campaign_authority_changed'};}
      else{
        const eligible=await repo.eligibility(actor,job.leadId,job.channel,job.purpose);
        if(!eligible.eligible){outcome={state:'suppressed',errorCode:eligible.reason};}
        else{
          const token=await repo.issuePreferenceToken(actor,job.leadId,job.channel);
          const result=await dispatchNotification(env,{jobId:job.id,leadId:job.leadId,channel:job.channel,recipient:eligible.recipient!,name:detail.lead.name??'Learner',
            subject:'Your TechlyUp learning updates',body:'Explore the learning opportunities you asked to hear about at https://techlyup.com.',
            unsubscribeUrl:`${publicCrmOrigin(env)}/communication-preferences#token=${encodeURIComponent(token)}`},current,fetcher);
          attempted++;outcome=result.state==='accepted'?{state:'accepted',nativeIntentId:result.nativeIntentId}:{state:result.state,errorCode:result.errorCode};
        }
      }
    }catch{outcome={state:'blocked',errorCode:'authority_unavailable'};}
    await repo.finishJob(actor,job.id,lease,outcome);if(outcome.state==='accepted')accepted++;if(outcome.state==='uncertain')uncertain++;
  }
  return {rules,attempted,accepted,uncertain};
}
