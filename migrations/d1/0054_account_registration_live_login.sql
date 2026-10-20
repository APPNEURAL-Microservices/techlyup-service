-- Additive. Self-declared registration details for app-created accounts; account_type is descriptive, never a grant.
CREATE TABLE app_account_registrations (
 account_id TEXT PRIMARY KEY REFERENCES learner_accounts(id) ON DELETE CASCADE,
 -- D1 caps GLOB patterns at 50 bytes, so formats are checked by length plus a short character-class pattern.
 phone TEXT NOT NULL CHECK(length(phone)=13 AND substr(phone,1,4) GLOB '+91[6-9]' AND substr(phone,5) NOT GLOB '*[^0-9]*'),
 account_type TEXT NOT NULL CHECK(account_type IN ('student','teacher')),
 city TEXT NOT NULL CHECK(length(city) BETWEEN 2 AND 80),
 referral_code TEXT NOT NULL UNIQUE CHECK(length(referral_code)=8 AND substr(referral_code,1,2)='TU' AND substr(referral_code,3) NOT GLOB '*[^0-9A-Z]*'),
 referred_by_account_id TEXT REFERENCES learner_accounts(id) ON DELETE SET NULL CHECK(referred_by_account_id IS NULL OR referred_by_account_id<>account_id),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX app_account_registrations_referrer ON app_account_registrations(referred_by_account_id);
-- One-use PKCE authorization for signing in to TechlyUp LIVE with an app account.
CREATE TABLE app_live_login_challenges (
 id TEXT PRIMARY KEY,client_id TEXT NOT NULL,pkce_challenge TEXT NOT NULL,
 authorized_account_id TEXT REFERENCES learner_accounts(id) ON DELETE CASCADE,authorized_session_id TEXT,
 code_hash TEXT,attempts INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL,authorized_at TEXT,consumed_at TEXT,created_at TEXT NOT NULL
);
CREATE INDEX app_live_login_challenges_client ON app_live_login_challenges(client_id,created_at);
