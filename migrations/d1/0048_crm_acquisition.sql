-- Additive TechlyUp acquisition domain. Existing learner identities,
-- registrations, customer master and LIVE CRM tables remain authoritative.
CREATE TABLE crm_contacts (
 org_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT,email TEXT,phone TEXT,
 email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN(0,1)),
 phone_verified INTEGER NOT NULL DEFAULT 0 CHECK(phone_verified IN(0,1)),
 created_at TEXT NOT NULL,PRIMARY KEY(org_id,id),
 CHECK(email IS NULL OR (email=lower(trim(email)) AND length(email)<=254)),
 CHECK(email IS NOT NULL OR phone IS NOT NULL),CHECK(name IS NULL OR length(name)<=160),CHECK(phone IS NULL OR length(phone)<=32)
);
CREATE UNIQUE INDEX crm_contacts_email ON crm_contacts(org_id,email) WHERE email IS NOT NULL;
CREATE INDEX crm_contacts_phone_candidates ON crm_contacts(org_id,phone) WHERE phone IS NOT NULL;
CREATE TABLE crm_contact_accounts (
 org_id TEXT NOT NULL,contact_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES learner_accounts(id),
 linked_by TEXT NOT NULL,linked_at TEXT NOT NULL,PRIMARY KEY(org_id,account_id),UNIQUE(org_id,contact_id,account_id),
 FOREIGN KEY(org_id,contact_id) REFERENCES crm_contacts(org_id,id)
);
CREATE TABLE crm_leads (
 org_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,account_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN('course','webinar','mentorship','career','general')),
 interest TEXT NOT NULL DEFAULT '' CHECK(length(interest)<=240),source TEXT NOT NULL CHECK(length(source)<=120),
 stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN('new','contacted','qualified','won','lost')),
 score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),score_reasons TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(score_reasons) AND json_type(score_reasons)='array'),
 owner_account_id TEXT REFERENCES learner_accounts(id),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 first_attribution TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(first_attribution)),last_attribution TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(last_attribution)),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),
 UNIQUE(org_id,contact_id,kind,interest),UNIQUE(org_id,id,contact_id),
 FOREIGN KEY(org_id,contact_id) REFERENCES crm_contacts(org_id,id),
 FOREIGN KEY(org_id,contact_id,account_id) REFERENCES crm_contact_accounts(org_id,contact_id,account_id)
);
CREATE INDEX crm_leads_recent ON crm_leads(org_id,updated_at DESC,id DESC);
CREATE INDEX crm_leads_pipeline ON crm_leads(org_id,stage,owner_account_id,updated_at DESC,id DESC);
CREATE TABLE crm_contact_conflicts (
 org_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('phone_conflict','shared_phone')),
 hint_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,id),
 UNIQUE(org_id,contact_id,kind,hint_sha256),FOREIGN KEY(org_id,contact_id) REFERENCES crm_contacts(org_id,id)
);
CREATE TABLE crm_consent_events (
 org_id TEXT NOT NULL,id TEXT NOT NULL,contact_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),
 purpose TEXT NOT NULL CHECK(purpose IN('service','marketing')),decision TEXT NOT NULL CHECK(decision IN('declared','verified','withdrawn')),
 requested INTEGER NOT NULL CHECK(requested IN(0,1)),policy_version TEXT NOT NULL CHECK(policy_version IN('2026-09','2026-10','legacy-newsletter-unversioned')),
 proof_kind TEXT NOT NULL,proof_reference TEXT NOT NULL,contact_hash TEXT NOT NULL,verified_at TEXT,occurred_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,contact_id) REFERENCES crm_contacts(org_id,id),CHECK(decision<>'verified' OR verified_at IS NOT NULL)
);
CREATE TABLE crm_contact_permissions (
 org_id TEXT NOT NULL,contact_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),
 purpose TEXT NOT NULL CHECK(purpose IN('service','marketing')),state TEXT NOT NULL CHECK(state IN('pending','granted','withdrawn')),
 policy_version TEXT NOT NULL,proof_kind TEXT NOT NULL,proof_reference TEXT NOT NULL,contact_hash TEXT NOT NULL,
 verified_at TEXT,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,contact_id,channel,purpose),FOREIGN KEY(org_id,contact_id) REFERENCES crm_contacts(org_id,id),
 CHECK(state<>'granted' OR (verified_at IS NOT NULL AND proof_kind<>'declared'))
);
CREATE TABLE crm_suppressions (
 org_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),contact_hash TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN('service','marketing')),reason TEXT NOT NULL,revision TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,channel,contact_hash,purpose)
);
CREATE TABLE crm_activities (
 org_id TEXT NOT NULL,id TEXT NOT NULL,lead_id TEXT NOT NULL,kind TEXT NOT NULL,note TEXT,actor_account_id TEXT,
 source_key TEXT NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,lead_id,source_key),
 FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id),CHECK(note IS NULL OR length(note)<=1000)
);
CREATE INDEX crm_activities_recent ON crm_activities(org_id,lead_id,occurred_at DESC,id DESC);
CREATE TABLE crm_tasks (
 org_id TEXT NOT NULL,id TEXT NOT NULL,lead_id TEXT NOT NULL,title TEXT NOT NULL CHECK(length(title) BETWEEN 2 AND 200),
 assigned_account_id TEXT NOT NULL REFERENCES learner_accounts(id),due_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('open','done','cancelled')),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,origin TEXT NOT NULL DEFAULT 'staff' CHECK(origin IN('staff','automation')),PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id)
);
CREATE INDEX crm_tasks_due ON crm_tasks(org_id,assigned_account_id,status,due_at);
CREATE TABLE crm_pipeline_history (
 org_id TEXT NOT NULL,id TEXT NOT NULL,lead_id TEXT NOT NULL,from_stage TEXT NOT NULL,to_stage TEXT NOT NULL,
 from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,actor_account_id TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id),UNIQUE(org_id,lead_id,to_version),FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id)
);
CREATE TABLE crm_source_events (
 org_id TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT NOT NULL,lead_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL,PRIMARY KEY(org_id,source,external_id),FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id)
);
CREATE TABLE crm_integrations (
 org_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN('native_notification','meta','linkedin','external')),
 channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),source_ref TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,provider,source_ref)
);
CREATE TABLE crm_campaigns (
 org_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),
 purpose TEXT NOT NULL CHECK(purpose IN('service','marketing')),template_ref TEXT NOT NULL,integration_id TEXT,
 kinds TEXT NOT NULL CHECK(json_valid(kinds)),stages TEXT NOT NULL CHECK(json_valid(stages)),min_score INTEGER NOT NULL CHECK(min_score BETWEEN 0 AND 100),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,integration_id) REFERENCES crm_integrations(org_id,id)
);
CREATE TABLE crm_rules (
 org_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN('score','automation')),
 trigger TEXT NOT NULL CHECK(trigger IN('capture','stage_changed','activity','no_show','post_event','task_due')),kind TEXT,stage TEXT,points INTEGER NOT NULL CHECK(points BETWEEN -100 AND 100),
 campaign_id TEXT,task_title TEXT,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,campaign_id) REFERENCES crm_campaigns(org_id,id)
);
CREATE TABLE crm_rule_runs (
 org_id TEXT NOT NULL,rule_id TEXT NOT NULL,rule_version INTEGER NOT NULL,event_key TEXT NOT NULL,lead_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('matched','skipped','queued','blocked')),created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,rule_id,rule_version,event_key,lead_id),FOREIGN KEY(org_id,rule_id) REFERENCES crm_rules(org_id,id),FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id)
);
CREATE TABLE crm_jobs (
 org_id TEXT NOT NULL,id TEXT NOT NULL,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,campaign_id TEXT NOT NULL,campaign_version INTEGER NOT NULL,
 integration_id TEXT NOT NULL,template_ref TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),
 purpose TEXT NOT NULL CHECK(purpose IN('service','marketing')),state TEXT NOT NULL CHECK(state IN('queued','sending','accepted','delivered','failed','blocked','suppressed','uncertain')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),lease_id TEXT,provider_message_id TEXT,native_intent_id TEXT,error_code TEXT,
 scheduled_at TEXT NOT NULL,claimed_at TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,id),UNIQUE(org_id,campaign_id,campaign_version,contact_id,channel,purpose),
 FOREIGN KEY(org_id,lead_id,contact_id) REFERENCES crm_leads(org_id,id,contact_id),FOREIGN KEY(org_id,campaign_id) REFERENCES crm_campaigns(org_id,id),FOREIGN KEY(org_id,integration_id) REFERENCES crm_integrations(org_id,id)
);
CREATE INDEX crm_jobs_due ON crm_jobs(org_id,state,scheduled_at,id);
CREATE TABLE crm_job_attempts (
 org_id TEXT NOT NULL,id TEXT NOT NULL,job_id TEXT NOT NULL,attempt INTEGER NOT NULL,lease_id TEXT NOT NULL,
 state TEXT NOT NULL,error_code TEXT,provider_message_id TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id),UNIQUE(org_id,job_id,attempt),FOREIGN KEY(org_id,job_id) REFERENCES crm_jobs(org_id,id)
);
CREATE TABLE crm_outbox (
 org_id TEXT NOT NULL,id TEXT NOT NULL,lead_id TEXT NOT NULL,event_type TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','processing','completed','blocked')),
 attempts INTEGER NOT NULL DEFAULT 0,lease_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,id),FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id)
);
CREATE INDEX crm_outbox_due ON crm_outbox(org_id,state,created_at,id);
CREATE TABLE crm_webhook_nonces (
 org_id TEXT NOT NULL,nonce_sha256 TEXT NOT NULL,body_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 PRIMARY KEY(org_id,nonce_sha256)
);
CREATE TABLE crm_preference_tokens (
 org_id TEXT NOT NULL,token_sha256 TEXT NOT NULL,contact_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN('email','whatsapp')),
 expires_at TEXT NOT NULL,consumed_at TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,token_sha256),FOREIGN KEY(org_id,contact_id) REFERENCES crm_contacts(org_id,id)
);
CREATE TABLE crm_commands (
 org_id TEXT NOT NULL,actor_key TEXT NOT NULL,command_key TEXT NOT NULL,operation TEXT NOT NULL,request_sha256 TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 PRIMARY KEY(org_id,actor_key,command_key)
);
CREATE TABLE crm_command_guards (id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1));
CREATE TABLE crm_audit_events (
 org_id TEXT NOT NULL,id TEXT NOT NULL,actor_account_id TEXT,request_id TEXT NOT NULL,action TEXT NOT NULL,
 resource_id TEXT,metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata)),created_at TEXT NOT NULL,PRIMARY KEY(org_id,id)
);
CREATE INDEX crm_audit_recent ON crm_audit_events(org_id,created_at DESC,id DESC);
CREATE TRIGGER crm_audit_no_update BEFORE UPDATE ON crm_audit_events BEGIN SELECT RAISE(ABORT,'CRM_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER crm_audit_no_delete BEFORE DELETE ON crm_audit_events BEGIN SELECT RAISE(ABORT,'CRM_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER crm_consent_no_update BEFORE UPDATE ON crm_consent_events BEGIN SELECT RAISE(ABORT,'CRM_CONSENT_IMMUTABLE'); END;
CREATE TRIGGER crm_pipeline_no_update BEFORE UPDATE ON crm_pipeline_history BEGIN SELECT RAISE(ABORT,'CRM_PIPELINE_IMMUTABLE'); END;

CREATE TRIGGER crm_consent_no_delete BEFORE DELETE ON crm_consent_events BEGIN SELECT RAISE(ABORT,'CRM_CONSENT_IMMUTABLE'); END;
CREATE TRIGGER crm_pipeline_no_delete BEFORE DELETE ON crm_pipeline_history BEGIN SELECT RAISE(ABORT,'CRM_PIPELINE_IMMUTABLE'); END;

CREATE INDEX crm_leads_audience ON crm_leads(org_id,kind,stage,score,updated_at DESC,id DESC);
-- Once queued, the intended contact/approved template/version cannot be edited
-- during a state transition or provider reconciliation.
CREATE TRIGGER crm_job_intention_immutable BEFORE UPDATE OF lead_id,contact_id,campaign_id,campaign_version,integration_id,template_ref,channel,purpose ON crm_jobs
WHEN OLD.lead_id<>NEW.lead_id OR OLD.contact_id<>NEW.contact_id OR OLD.campaign_id<>NEW.campaign_id OR OLD.campaign_version<>NEW.campaign_version OR OLD.integration_id<>NEW.integration_id OR OLD.template_ref<>NEW.template_ref OR OLD.channel<>NEW.channel OR OLD.purpose<>NEW.purpose
BEGIN SELECT RAISE(ABORT,'CRM_JOB_INTENTION_IMMUTABLE'); END;
