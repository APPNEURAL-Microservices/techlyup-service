-- Isolated local/test schema snapshot. No production data, grants or credentials.
-- Canonical provenance: website migrations 0026, 0027, 0031, 0041 (2026-10-16).
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS learner_accounts (
 id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,
 password_hash TEXT NOT NULL,email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN(0,1)),
 audience_ids TEXT NOT NULL DEFAULT '[]',goal_ids TEXT NOT NULL DEFAULT '[]',interest_ids TEXT NOT NULL DEFAULT '[]',
 consent_version TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 first_name TEXT,middle_name TEXT,last_name TEXT
);
CREATE TABLE IF NOT EXISTS learner_account_sessions (
 token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learner_bookmarks (
 account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN('course','webinar')),item_id TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,kind,item_id)
);
CREATE TABLE IF NOT EXISTS learner_anonymous_claims (
 anonymous_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webinar_erp_roles (
 org_id TEXT NOT NULL,actor_id TEXT NOT NULL,functional_role TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,actor_id,functional_role)
);
CREATE TABLE IF NOT EXISTS live_core_staff_links (
 learner_account_id TEXT NOT NULL REFERENCES learner_accounts(id),org_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 actor_role TEXT NOT NULL CHECK(actor_role IN('owner','admin','manager','member','viewer')),
 actor_email TEXT NOT NULL,actor_name TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,
 linked_by_actor_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(learner_account_id,org_id),UNIQUE(org_id,actor_id)
);
