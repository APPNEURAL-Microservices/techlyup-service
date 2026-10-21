-- Additive product sign-in only. Canonical accounts, passwords and grants remain unchanged.
CREATE TABLE app_product_login_challenges (
 id TEXT PRIMARY KEY,
 app_id TEXT NOT NULL CHECK(app_id IN ('courses','mentorship','certificates','learners','earnings','promotion','insights','assistant')),
 client_id TEXT NOT NULL,
 pkce_challenge TEXT NOT NULL CHECK(length(pkce_challenge)=43),
 return_path TEXT NOT NULL DEFAULT '/' CHECK(length(return_path) BETWEEN 1 AND 300),
 authorized_account_id TEXT REFERENCES learner_accounts(id) ON DELETE CASCADE,
 authorized_session_id TEXT REFERENCES app_sessions(id) ON DELETE CASCADE,
 code_hash TEXT,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 product_session_id TEXT,
 expires_at TEXT NOT NULL,authorized_at TEXT,consumed_at TEXT,created_at TEXT NOT NULL
);
CREATE INDEX app_product_login_challenges_client ON app_product_login_challenges(client_id,created_at);
CREATE INDEX app_product_login_challenges_expiry ON app_product_login_challenges(expires_at,id);
CREATE TABLE app_product_sessions (
 id TEXT PRIMARY KEY,
 app_id TEXT NOT NULL CHECK(app_id IN ('courses','mentorship','certificates','learners','earnings','promotion','insights','assistant')),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
 account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
 canonical_session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT
);
CREATE INDEX app_product_sessions_owner ON app_product_sessions(account_id,app_id,expires_at);
CREATE INDEX app_product_sessions_expiry ON app_product_sessions(expires_at,id);
