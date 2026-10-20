-- Bounded receipts only; canonical CRM remains the acquisition authority.
CREATE TABLE app_webinar_crm_intake (
 org_id TEXT NOT NULL,client_id TEXT NOT NULL,event_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES learner_accounts(id),live_subject TEXT NOT NULL,
 session_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('REGISTRATION_CONFIRMED','ATTENDANCE_REVIEWED','OFFER_INTEREST')),
 occurred_at TEXT NOT NULL,consent_receipt_id TEXT NOT NULL,marketing_declared INTEGER NOT NULL CHECK(marketing_declared IN (0,1)),
 payload_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSING','DONE','SUPPRESSED','REVIEW_REQUIRED')),
 attempts INTEGER NOT NULL DEFAULT 0,lease_id TEXT,lease_until TEXT,lead_id TEXT,
 result_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(org_id,client_id,event_id)
);
CREATE INDEX app_webinar_crm_pending ON app_webinar_crm_intake(state,created_at);
