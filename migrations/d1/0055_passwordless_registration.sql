-- Additive. Email codes replace app passwords; onboarding details and consent history for app-created accounts.
-- Emails and codes are kept only as SHA-256 hashes. A challenge without code_hash never accepts a code:
-- it records a "no account"/"already registered" notice, so responses never reveal which emails exist.
CREATE TABLE app_email_otp_challenges (
 id TEXT PRIMARY KEY,
 purpose TEXT NOT NULL CHECK(purpose IN ('signup','login')),
 email_hash TEXT NOT NULL CHECK(length(email_hash)=64),
 code_hash TEXT CHECK(code_hash IS NULL OR length(code_hash)=64),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at TEXT NOT NULL,consumed_at TEXT,created_at TEXT NOT NULL
);
CREATE INDEX app_email_otp_challenges_expiry ON app_email_otp_challenges(expires_at);
-- Self-declared. teacher_role describes experience and never grants mentor, instructor or any other role.
-- Guardian agreement is the learner's own statement; it is not verified guardian consent.
CREATE TABLE app_account_onboarding (
 account_id TEXT PRIMARY KEY REFERENCES learner_accounts(id) ON DELETE CASCADE,
 teacher_role TEXT CHECK(teacher_role IS NULL OR teacher_role IN ('mentor','instructor','academic')),
 preferred_language TEXT NOT NULL CHECK(preferred_language IN ('en','hi','hi-en')),
 institution TEXT CHECK(institution IS NULL OR length(institution) BETWEEN 2 AND 120),
 age_group TEXT NOT NULL CHECK(age_group IN ('adult','minor')),
 guardian_name TEXT CHECK(guardian_name IS NULL OR length(guardian_name) BETWEEN 2 AND 100),
 guardian_email TEXT CHECK(guardian_email IS NULL OR length(guardian_email) BETWEEN 3 AND 254),
 guardian_consent_at TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK((age_group='adult' AND guardian_name IS NULL AND guardian_email IS NULL AND guardian_consent_at IS NULL)
  OR (age_group='minor' AND teacher_role IS NULL AND guardian_name IS NOT NULL AND guardian_email IS NOT NULL AND guardian_consent_at IS NOT NULL))
);
-- Append-only. The newest row per account and purpose is the current choice.
CREATE TABLE app_consent_records (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('account_terms','webinar_updates','guardian')),
 version TEXT NOT NULL,granted INTEGER NOT NULL CHECK(granted IN (0,1)),
 request_id TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX app_consent_records_account ON app_consent_records(account_id,purpose,created_at);
