-- Identity references and payment receipts only. Paid balances live solely in the shared asset ledger.
CREATE TABLE app_support_link_challenges (
 id TEXT PRIMARY KEY,client_id TEXT NOT NULL,live_subject TEXT NOT NULL,session_binding TEXT NOT NULL,
 pkce_challenge TEXT NOT NULL,expires_at TEXT NOT NULL,authorized_account_id TEXT REFERENCES learner_accounts(id),
 authorized_session_id TEXT REFERENCES app_sessions(id),code_hash TEXT,authorized_at TEXT,consumed_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL
);
CREATE INDEX app_support_challenge_expiry ON app_support_link_challenges(expires_at);
CREATE TABLE app_support_links (
 client_id TEXT NOT NULL,live_subject TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES learner_accounts(id),
 challenge_id TEXT NOT NULL UNIQUE REFERENCES app_support_link_challenges(id),linked_at TEXT NOT NULL,revoked_at TEXT,
 PRIMARY KEY(client_id,live_subject)
);
CREATE UNIQUE INDEX app_support_one_live_profile ON app_support_links(client_id,account_id) WHERE revoked_at IS NULL;
CREATE TABLE app_support_purchases (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES learner_accounts(id),request_key TEXT NOT NULL,
 pack_id TEXT NOT NULL,policy_version TEXT NOT NULL,credit_units INTEGER NOT NULL,price_paise INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode='test'),created_at TEXT NOT NULL,UNIQUE(account_id,request_key)
);
CREATE TABLE app_support_source_commands (
 client_id TEXT NOT NULL,live_subject TEXT NOT NULL,request_key TEXT NOT NULL,operation TEXT NOT NULL,
 request_hash TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES learner_accounts(id),created_at TEXT NOT NULL,
 PRIMARY KEY(client_id,live_subject,request_key)
);
CREATE TRIGGER app_support_source_command_immutable_update BEFORE UPDATE ON app_support_source_commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_SOURCE_COMMAND'); END;
CREATE TRIGGER app_support_source_command_immutable_delete BEFORE DELETE ON app_support_source_commands BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_SOURCE_COMMAND'); END;
CREATE TABLE app_support_payment_invoices (
 id TEXT PRIMARY KEY REFERENCES app_support_purchases(id),site TEXT NOT NULL,reference_hash TEXT NOT NULL UNIQUE,
 reference_label TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',customer_name TEXT NOT NULL,
 email TEXT NOT NULL,email_hash TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=100),
 currency TEXT NOT NULL DEFAULT 'INR' CHECK(currency='INR'),mode TEXT NOT NULL CHECK(mode='test'),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','creating','pending','paid','partially_refunded','refunded')),
 provider_order_id TEXT UNIQUE,payment_id TEXT UNIQUE,key_id TEXT,amount_refunded INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE app_support_payment_webhooks(event_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,processed_at INTEGER NOT NULL);
CREATE TABLE app_support_capture_receipts (
 id TEXT PRIMARY KEY,intent_id TEXT NOT NULL UNIQUE REFERENCES app_support_purchases(id),
 account_id TEXT NOT NULL REFERENCES learner_accounts(id),provider_order_id TEXT NOT NULL UNIQUE,
 provider_payment_id TEXT NOT NULL UNIQUE,captured_at TEXT NOT NULL
);
CREATE TRIGGER app_support_capture_immutable_update BEFORE UPDATE ON app_support_capture_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_CAPTURE'); END;
CREATE TRIGGER app_support_capture_immutable_delete BEFORE DELETE ON app_support_capture_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_CAPTURE'); END;
CREATE TRIGGER app_support_purchase_immutable_update BEFORE UPDATE ON app_support_purchases BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_PURCHASE'); END;
CREATE TRIGGER app_support_purchase_immutable_delete BEFORE DELETE ON app_support_purchases BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_PURCHASE'); END;
CREATE TABLE app_support_funding_outbox (
 receipt_id TEXT PRIMARY KEY REFERENCES app_support_capture_receipts(id),revision INTEGER NOT NULL DEFAULT 1,
 desired_refunded_paise INTEGER NOT NULL DEFAULT 0,delivered_refunded_paise INTEGER NOT NULL DEFAULT -1,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSING','COMPLETED','REVIEW_REQUIRED')),
 attempts INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL
);
CREATE TABLE app_support_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1));
CREATE TABLE app_support_audit_events(id TEXT PRIMARY KEY,account_id TEXT REFERENCES learner_accounts(id),action TEXT NOT NULL,source_ref TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER app_support_audit_immutable_update BEFORE UPDATE ON app_support_audit_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_AUDIT'); END;
CREATE TRIGGER app_support_audit_immutable_delete BEFORE DELETE ON app_support_audit_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUPPORT_AUDIT'); END;
