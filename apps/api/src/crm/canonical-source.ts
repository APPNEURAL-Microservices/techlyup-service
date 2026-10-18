import type { CrmCaptureInput } from '@techlyup/contracts';
import { hash } from '../auth/crypto';
import { database } from '../config';
import type { Env } from '../types';
import { CrmRepository } from './repository';

interface SourceEvent { id:number;event_key:string;source_kind:'submission'|'newsletter'|'registration'|'attendance'|'completion';source_id:string;attempts:number;fanout_cursor:string }
const object = (raw:string):Record<string,unknown> => { const value:unknown=JSON.parse(raw); return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; };
const text = (value:unknown) => typeof value==='string' ? value.trim() : '';
const allowedPolicy = (value:unknown):'2026-09'|'2026-10'|null => value==='2026-09'||value==='2026-10' ? value : null;

/** Sparse, transactionally captured canonical events. No historic sweep, email
 * account matching, profile copying, partial fields or registration authority. */
export async function syncCanonicalCrm(env:Env, maximum=30, now=new Date()) {
  if(env.APP_CRM_ENABLED!=='true')return {processed:0,skipped:0,failed:0};
  const db=database(env), repo=new CrmRepository(db), orgId=env.TECHLYUP_ERP_ORG_ID!;
  const instant=now.toISOString(), deadline=Date.now()+20000;
  const events=await db.prepare(`SELECT id,event_key,source_kind,source_id,attempts,fanout_cursor FROM crm_canonical_outbox
    WHERE (org_id IS NULL OR org_id=?) AND available_at<=? AND (state='pending' OR (state='processing' AND lease_until<?)) ORDER BY id LIMIT ?`).bind(orgId,instant,instant,Math.min(100,Math.max(1,maximum))).all<SourceEvent>();
  let processed=0,skipped=0,failed=0;
  for(const event of events.results){
    if(Date.now()>deadline)break;
    const lease=crypto.randomUUID();
    const claim=await db.prepare(`UPDATE crm_canonical_outbox SET state='processing',lease_id=?,lease_until=?,attempts=attempts+1
      WHERE id=? AND (state='pending' OR (state='processing' AND lease_until<?))`).bind(lease,new Date(now.getTime()+120000).toISOString(),event.id,instant).run();
    if(claim.meta.changes!==1)continue;
    const eventHash=await hash(event.event_key), actor={orgId,accountId:null,requestId:`canonical:${eventHash}`};
    try {
      if(event.source_kind==='completion'){
        const rows=(await db.prepare(`SELECT a.registration_id,a.attended,a.recorded_at FROM workshop_attendance a JOIN workshop_registrations r ON r.id=a.registration_id WHERE r.workshop_id=? AND a.registration_id>? AND EXISTS(SELECT 1 FROM crm_canonical_outbox captured WHERE captured.source_kind='attendance' AND captured.event_key='attendance:'||a.registration_id||':'||a.attended||':'||a.recorded_at) ORDER BY a.registration_id LIMIT 25`).bind(event.source_id,event.fanout_cursor).all<{registration_id:string;attended:number;recorded_at:string}>()).results;
        const statements=rows.map(row=>db.prepare(`INSERT INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at,org_id,available_at) VALUES(?,'attendance',?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET available_at=excluded.available_at,state='pending',attempts=0,result_code=NULL WHERE crm_canonical_outbox.state IN('pending','failed')`).bind(`attendance:${row.registration_id}:${row.attended}:${row.recorded_at}`,row.registration_id,instant,orgId,instant));
        statements.push(db.prepare(`UPDATE crm_canonical_outbox SET state=?,fanout_cursor=?,available_at=?,lease_id=NULL,lease_until=NULL,result_code=? WHERE id=? AND lease_id=?`).bind(rows.length===25?'pending':'done',rows.at(-1)?.registration_id??event.fanout_cursor,instant,rows.length===25?'completion_fanout_pending':'completion_fanout_done',event.id,lease));
        await db.batch(statements);continue;
      }
      let input:CrmCaptureInput|null=null;
      let accountId:string|undefined;
      let verifiedSource:{kind:'newsletter';reference:string;verifiedAt:string}|undefined;
      if(event.source_kind==='newsletter'){
        const row=await db.prepare('SELECT email,name,status,consent_at,verified_at FROM email_subscribers WHERE rowid=?').bind(Number(event.source_id)).first<{email:string;name:string;status:string;consent_at:string;verified_at:string|null}>();
        // Pending newsletter requests stay exclusively in the existing opt-in
        // system; only actual verified subscription becomes acquisition data.
        if(row?.status==='active'&&row.verified_at&&Number.isFinite(Date.parse(row.verified_at))&&row.consent_at){
          input={name:row.name,email:row.email,kind:'general',interest:'Newsletter',source:'website:newsletter',consent:{service:false,marketing:false,whatsapp:false,policyVersion:'legacy-newsletter-unversioned'}};
          verifiedSource={kind:'newsletter',reference:`newsletter:${await hash(row.email.toLowerCase())}`,verifiedAt:row.verified_at};
        }
        // Canonical unsubscribe is already a current per-send veto. We never
        // erase it or re-enable a prior withdrawn permission during projection.
      } else {
        const row=event.source_kind==='submission'
          ? await db.prepare('SELECT id,kind,payload,meta FROM submissions WHERE id=?').bind(event.source_id).first<{id:string;kind:string;payload:string;meta:string}>()
          : await db.prepare(`SELECT id,kind,payload,meta FROM submissions WHERE json_valid(meta) AND json_extract(meta,'$.registrationId')=?
              AND json_extract(meta,'$.purpose') IN ('webinar_registration','live_webinar_registration') ORDER BY created_at DESC LIMIT 1`).bind(event.source_id).first<{id:string;kind:string;payload:string;meta:string}>();
        if(row&&['website','enterprise_demo','mentor_session','topic_request'].includes(row.kind)){
          const payload=object(row.payload), meta=object(row.meta), policy=allowedPolicy(payload.consentVersion), path=text(payload.sourcePath).split(/[?#]/)[0];
          const excluded=/certificat|claim|feedback|support|dispute|success-stor/i.test(`${path} ${text(meta.purpose)} ${text(payload.source)}`);
          if(!excluded&&(payload.consent===true||payload.consent==='true')&&policy){
            const email=text(payload.email), phone=text(payload.phone);
            const registrationId=['webinar_registration','live_webinar_registration'].includes(text(meta.purpose))?text(meta.registrationId):'';
            let kind:CrmCaptureInput['kind']=row.kind==='enterprise_demo'?'general':row.kind==='mentor_session'?'mentorship':path.startsWith('/courses')?'course':'general';
            if(registrationId){
              const registration=await db.prepare('SELECT id,workshop_id,workshop_title,email,status FROM workshop_registrations WHERE id=?').bind(registrationId).first<{id:string;workshop_id:string;workshop_title:string;email:string;status:string}>();
              if(!registration||registration.email.toLowerCase()!==email.toLowerCase())throw new Error('canonical_proof_unavailable');
              kind='webinar';
              // The existing registration/account proof is the only owner link.
              const link=await db.prepare(`SELECT a.id FROM live_core_registration_links l JOIN learner_accounts a ON a.id=l.learner_account_id
                WHERE l.org_id=? AND l.registration_id=? AND lower(a.email)=?`).bind(orgId,registrationId,email.toLowerCase()).first<{id:string}>();
              accountId=link?.id;
              input={name:text(payload.name)||[text(payload.firstName),text(payload.lastName)].filter(Boolean).join(' ')||undefined,email:email||undefined,phone:phone||undefined,kind,interest:registration.workshop_title.slice(0,240),source:'website:webinar',consent:{service:true,marketing:false,whatsapp:false,policyVersion:policy}};
            } else input={name:text(payload.name)||[text(payload.firstName),text(payload.lastName)].filter(Boolean).join(' ')||undefined,email:email||undefined,phone:phone||undefined,kind,interest:(text(payload.courseTitle)||text(payload.topic)||text(payload.service)||text(payload.mentorArea)||'Enquiry').slice(0,240),source:`website:${row.kind}`,consent:{service:true,marketing:false,whatsapp:false,policyVersion:policy}};
          }
        }
      }
      if(input){
        const lead=await repo.capture(actor,input,`canonical:${eventHash}`,{accountId,verifiedSource,sourceEvent:{source:'canonical-website',externalId:eventHash}});
        if(event.source_kind==='attendance'){
          const evidence=await db.prepare(`SELECT a.attended,r.status,r.workshop_datetime,c.session_json,u.data FROM workshop_attendance a
            JOIN workshop_registrations r ON r.id=a.registration_id
            LEFT JOIN live_core_session_catalog c ON c.workshop_id=r.workshop_id AND c.org_id=?
            LEFT JOIN workshop_updates u ON u.workshop_id=r.workshop_id WHERE a.registration_id=?`).bind(orgId,event.source_id).first<{attended:number;status:string;workshop_datetime:string;session_json:string|null;data:string|null}>();
          if(evidence?.status==='confirmed'&&(evidence.attended===0||evidence.attended===1)){
            const session=evidence.session_json?object(evidence.session_json):{}, update=evidence.data?object(evidence.data):{};
            const coreEnded=['ENDED','REPLAY_READY'].includes(text(session.status))&&typeof session.durationMinutes==='number'&&session.durationMinutes>0&&session.durationMinutes<=480&&Number.isFinite(Date.parse(text(session.startsAt)))&&Date.parse(text(session.startsAt))===Date.parse(evidence.workshop_datetime)&&Date.parse(text(session.startsAt))+session.durationMinutes*60000<=now.getTime();
            const reviewedEnded=update.status==='completed'&&Number.isFinite(Date.parse(evidence.workshop_datetime))&&Date.parse(evidence.workshop_datetime)<=now.getTime();
            if(coreEnded||reviewedEnded)await repo.runRules(actor,lead.id,evidence.attended===1?'post_event':'no_show',`canonical:${eventHash}`);
            else {
              // Normal attendance arrives while the event is running. Keep its
              // sparse intention deferred; a completion dispatcher can wake it
              // immediately, including after bounded waiting attempts expire.
              const knownEnd=typeof session.durationMinutes==='number'&&session.durationMinutes>0&&session.durationMinutes<=480&&Number.isFinite(Date.parse(text(session.startsAt)))&&Date.parse(text(session.startsAt))===Date.parse(evidence.workshop_datetime)?Date.parse(text(session.startsAt))+session.durationMinutes*60000:now.getTime();
              const available=new Date(Math.max(now.getTime()+300000,knownEnd+60000)).toISOString();
              await db.prepare("UPDATE crm_canonical_outbox SET state=?,available_at=?,lease_id=NULL,lease_until=NULL,result_code='awaiting_completion_evidence' WHERE id=? AND lease_id=?").bind(event.attempts+1>=8?'failed':'pending',available,event.id,lease).run();continue;
            }
            // Missing rows, stale player activity and unknown attendance never
            // imply a no-show or confer an assessed-completion credential.
          }
        }
        processed++;
      } else skipped++;
      await db.prepare('UPDATE crm_canonical_outbox SET state=?,lease_id=NULL,lease_until=NULL,result_code=? WHERE id=? AND lease_id=?').bind(input?'done':'skipped',input?'projected':'outside_acquisition_scope',event.id,lease).run();
    } catch {
      failed++;
      // Sanitized, bounded retry is safe: repository idempotency covers the
      // uncertain boundary after its atomic commit but before cursor advance.
      await db.prepare('UPDATE crm_canonical_outbox SET state=?,lease_id=NULL,lease_until=NULL,result_code=? WHERE id=? AND lease_id=?').bind(event.attempts+1>=8?'failed':'pending','projection_unavailable',event.id,lease).run();
    }
  }
  return {processed,skipped,failed};
}
