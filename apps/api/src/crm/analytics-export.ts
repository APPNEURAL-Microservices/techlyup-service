import { database } from '../config';
import type { Env } from '../types';
import { VISITOR_POLICY } from './visitors';

interface ExportRow {id:string;visitor_hash:string;event:string;page:string;created_at:string;provider:'posthog'|'ga4'}
/** Only separately opted-in anonymous events, sent to fixed reviewed provider
 * hosts. HTTP acceptance is not processing, identity, delivery or attribution proof. */
export async function exportAnonymousEvents(env:Env,fetcher:typeof fetch=fetch,now=new Date()){
  if(env.APP_CRM_ENABLED!=='true'||env.CRM_ANALYTICS_EXPORT_ENABLED!=='true')return {attempted:0,accepted:0,uncertain:0};
  const db=database(env),instant=now.toISOString();let attempted=0,accepted=0,uncertain=0;
  const rows=await db.prepare(`SELECT e.id,e.visitor_hash,e.event,e.page,e.created_at,x.provider FROM crm_visitor_exports x
    JOIN crm_visitor_events e ON e.id=x.event_id WHERE x.status='pending' ORDER BY x.created_at,e.id LIMIT 10`).all<ExportRow>();
  for(const row of rows.results){
    const currentInstant=()=>new Date(Math.max(now.getTime(),Date.now())).toISOString();
    const claim=await db.prepare(`UPDATE crm_visitor_exports SET status='sending',updated_at=? WHERE event_id=? AND provider=? AND status='pending'
      AND EXISTS(SELECT 1 FROM crm_visitors v WHERE v.token_hash=? AND v.external_granted=1 AND v.revoked_at IS NULL AND v.expires_at>? AND v.policy_version=?)`).bind(currentInstant(),row.id,row.provider,row.visitor_hash,currentInstant(),VISITOR_POLICY).run();
    if(claim.meta.changes!==1){await db.prepare("UPDATE crm_visitor_exports SET status='suppressed',updated_at=? WHERE event_id=? AND provider=? AND status='pending'").bind(instant,row.id,row.provider).run();continue;}
    let state:'accepted'|'rejected'|'uncertain'|'suppressed'='uncertain';
    try{
      const current=await db.prepare('SELECT token_hash FROM crm_visitors WHERE token_hash=? AND external_granted=1 AND revoked_at IS NULL AND expires_at>? AND policy_version=?').bind(row.visitor_hash,currentInstant(),VISITOR_POLICY).first();
      if(!current)state='suppressed';
      else {
        let url:string,body:unknown;
        if(row.provider==='posthog'){
          if(!env.CRM_POSTHOG_PROJECT_KEY)throw new Error('provider_unconfigured');
          url=env.CRM_POSTHOG_REGION==='eu'?'https://eu.i.posthog.com/capture/':'https://us.i.posthog.com/capture/';
          body={api_key:env.CRM_POSTHOG_PROJECT_KEY,event:`techlyup_${row.event}`,uuid:row.id,timestamp:row.created_at,properties:{distinct_id:row.visitor_hash,$process_person_profile:false,$geoip_disable:true,page:row.page}};
        }else{
          if(!env.CRM_GA4_MEASUREMENT_ID||!env.CRM_GA4_API_SECRET)throw new Error('provider_unconfigured');
          const target=new URL('https://www.google-analytics.com/mp/collect');target.searchParams.set('measurement_id',env.CRM_GA4_MEASUREMENT_ID);target.searchParams.set('api_secret',env.CRM_GA4_API_SECRET);url=target.href;
          body={client_id:`${row.visitor_hash.slice(0,16)}.${row.visitor_hash.slice(16,32)}`,timestamp_micros:Date.parse(row.created_at)*1000,consent:{ad_user_data:'DENIED',ad_personalization:'DENIED'},events:[{name:`techlyup_${row.event}`,params:{page_category:row.page,event_id:row.id}}]};
        }
        attempted++;
        const response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        // A provider HTTP acknowledgement does not prove an event was ingested.
        state=response.ok?'accepted':response.status>=400&&response.status<500&&!['408','429'].includes(String(response.status))?'rejected':'uncertain';
        await response.body?.cancel();
      }
    }catch{/* No blind retry or fallback after a provider outcome is unknown. */}
    await db.prepare("UPDATE crm_visitor_exports SET status=?,updated_at=? WHERE event_id=? AND provider=? AND status='sending'").bind(state,new Date().toISOString(),row.id,row.provider).run();
    if(state==='accepted')accepted++;if(state==='uncertain')uncertain++;
  }
  return {attempted,accepted,uncertain};
}
