import type {D1Database} from '../types';
/** Minimum complete CRM/source/privacy storage, independently of public flags.
 * Readiness never substitutes for deployment/provider/recovery acceptance. */
export const crmRequiredTables=[
 'crm_contacts','crm_contact_accounts','crm_leads','crm_contact_conflicts','crm_consent_events','crm_contact_permissions','crm_suppressions',
 'crm_activities','crm_tasks','crm_pipeline_history','crm_source_events','crm_integrations','crm_campaigns','crm_rules','crm_rule_runs',
 'crm_jobs','crm_job_attempts','crm_outbox','crm_webhook_nonces','crm_preference_tokens','crm_commands','crm_command_guards','crm_audit_events',
 'crm_canonical_outbox','crm_visitors','crm_visitor_events','crm_visitor_exports','crm_staff_notifications',
 'submissions','email_subscribers','workshop_registrations','workshop_attendance','workshop_updates','live_core_session_catalog','live_core_registration_links',
 'live_communication_suppressions','live_communication_account_suppressions',
]as const;
export async function crmStorageReady(db:D1Database){
 const row=await db.prepare(`SELECT count(*) AS ready FROM sqlite_master WHERE type='table' AND name IN (${crmRequiredTables.map(()=>'?').join(',')})`).bind(...crmRequiredTables).first<{ready:number}>();
 return row?.ready===crmRequiredTables.length;
}
