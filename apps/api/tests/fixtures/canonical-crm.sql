-- Canonical schema-only extension for isolated Phase1 tests. No real records.
CREATE TABLE IF NOT EXISTS submissions (
 id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',
 meta TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_subscribers (
 email TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,
 unsubscribe_token TEXT NOT NULL UNIQUE,consent_at TEXT NOT NULL,verified_at TEXT,
 code_hash TEXT,challenge_id TEXT,code_expires_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_requested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workshop_registrations (
 id TEXT PRIMARY KEY,workshop_id TEXT NOT NULL,workshop_title TEXT NOT NULL,workshop_datetime TEXT NOT NULL,
 workshop_venue TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL,
 phone TEXT NOT NULL,status TEXT NOT NULL,manage_token TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 cancelled_at TEXT,reminder_24h_sent_at TEXT,reminder_1h_sent_at TEXT,notification_revision INTEGER NOT NULL DEFAULT 0,
 UNIQUE(email,workshop_id)
);
CREATE TABLE IF NOT EXISTS workshop_attendance(registration_id TEXT PRIMARY KEY,attended INTEGER NOT NULL,recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workshop_updates(workshop_id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS live_core_session_catalog(session_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,workshop_id TEXT NOT NULL UNIQUE,session_version INTEGER NOT NULL,session_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS live_core_registration_links (
 registration_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,org_id TEXT NOT NULL,
 learner_account_id TEXT,source_json TEXT,consent_version TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(session_id,learner_account_id)
);
CREATE TABLE IF NOT EXISTS live_communication_suppressions (
 channel TEXT NOT NULL,contact_hash TEXT NOT NULL,purpose TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,revision TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(channel,contact_hash,purpose)
);
CREATE TABLE IF NOT EXISTS live_communication_account_suppressions (
 account_id TEXT NOT NULL,purpose TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,revision TEXT NOT NULL DEFAULT '',PRIMARY KEY(account_id,purpose)
);
