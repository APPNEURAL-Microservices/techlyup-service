-- Additive app adapter in the EXISTING canonical registrations D1 database.
-- Requires website 0001–0046 first. Never copy credentials into a new database.
CREATE TABLE app_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
  client TEXT NOT NULL CHECK(client IN ('web','ios','android')),
  password_fingerprint TEXT NOT NULL CHECK(length(password_fingerprint)=64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(expires_at > created_at)
);
CREATE INDEX app_sessions_account ON app_sessions(account_id,expires_at);
CREATE TABLE app_access_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX app_access_session ON app_access_tokens(session_id,expires_at);
CREATE TABLE app_refresh_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  rotation_id TEXT,
  CHECK((consumed_at IS NULL) = (rotation_id IS NULL))
);
CREATE INDEX app_refresh_session ON app_refresh_tokens(session_id,expires_at);
CREATE TABLE app_audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES learner_accounts(id) ON DELETE SET NULL,
  session_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('auth.signup','auth.login','auth.refresh','auth.replay_revoked','auth.logout','profile.update')),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX app_audit_account ON app_audit_events(account_id,created_at,id);
CREATE TABLE app_analytics_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK(event IN ('screen_view','catalog_filter','learning_open','auth_complete','profile_saved')),
  screen TEXT NOT NULL CHECK(screen IN ('home','learn','webinars','mentors','career','profile','admin','sign-in','sign-up')),
  item_kind TEXT CHECK(item_kind IN ('course','webinar','mentorship','career')),
  created_at TEXT NOT NULL
);
CREATE INDEX app_analytics_created ON app_analytics_events(created_at,id);
CREATE TABLE app_rate_limits (
  id TEXT PRIMARY KEY CHECK(length(id)=64),
  expires_at TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0)
);
CREATE INDEX app_rate_limits_expiry ON app_rate_limits(expires_at);
