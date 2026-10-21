-- Additive. A permanent TechlyUp LIVE passcode, created in the app and shown once; only its scrypt hash is kept.
-- Creating a new passcode replaces the old one and keeps the same TechlyUp ID. login_id ("TL" + 8) never
-- overlaps LIVE's own attendee IDs ("TU" + 6) or app referral codes.
CREATE TABLE app_live_passcodes (
 account_id TEXT PRIMARY KEY REFERENCES learner_accounts(id) ON DELETE CASCADE,
 login_id TEXT NOT NULL UNIQUE CHECK(length(login_id)=10 AND substr(login_id,1,2)='TL' AND substr(login_id,3) NOT GLOB '*[^0-9A-Z]*'),
 passcode_hash TEXT NOT NULL CHECK(substr(passcode_hash,1,7)='scrypt$'),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_used_at TEXT
);
