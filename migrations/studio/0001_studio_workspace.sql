-- Private preparation drafts for the eight separate TechlyUp Studio apps.
-- Dedicated D1 database (binding STUDIO_DB), never the canonical registrations store.
-- Rows reference canonical account IDs only: no credentials, email addresses,
-- inferred roles, account signup or copies of canonical learners.
-- D1 has no row-level security. Every repository statement carries the
-- server-resolved owner key (org_id, issuer, account_id); tests enforce that.

CREATE TABLE studio_account_refs (
  org_id TEXT NOT NULL CHECK (length(org_id) BETWEEN 1 AND 100),
  issuer TEXT NOT NULL CHECK (issuer = 'techlyup-learner'),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, issuer, account_id)
) WITHOUT ROWID;

-- Drafts only. Never creates canonical enrollment, appointment confirmation,
-- credentials, financial transactions, delivery or AI generation.
CREATE TABLE studio_records (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  org_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  account_id TEXT NOT NULL,
  app_id TEXT NOT NULL CHECK (app_id IN ('courses','mentorship','certificates','learners','earnings','promotion','insights','assistant')),
  resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 40 AND resource NOT GLOB '*[^a-z-]*' AND substr(resource, 1, 1) BETWEEN 'a' AND 'z'),
  field_values TEXT NOT NULL CHECK (json_valid(field_values) AND json_type(field_values) = 'object' AND length(CAST(field_values AS BLOB)) <= 24000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- The latest mutation, shared with its audit event; guards writes in the same batch.
  write_id TEXT NOT NULL CHECK (length(write_id) = 36),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id, issuer, account_id) REFERENCES studio_account_refs(org_id, issuer, account_id),
  UNIQUE (id, org_id, issuer, account_id),
  CHECK (
    (app_id='courses' AND resource IN ('courses','curriculum','batches','submissions')) OR
    (app_id='mentorship' AND resource IN ('bookings','services','availability','questions')) OR
    (app_id='certificates' AND resource IN ('templates','eligibility')) OR
    (app_id='learners' AND resource IN ('directory','groups','details','communication')) OR
    (app_id='earnings' AND resource='pricing') OR
    (app_id='promotion' AND resource IN ('public-profile','links','referrals','campaigns')) OR
    (app_id='assistant' AND resource IN ('workspace','drafts','summaries'))
  )
);
CREATE INDEX studio_records_owner_list ON studio_records(org_id, issuer, account_id, app_id, resource, status, updated_at DESC, id);

CREATE TABLE studio_idempotency_operations (
  org_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  response TEXT NOT NULL CHECK (json_valid(response)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, issuer, account_id, idempotency_key),
  FOREIGN KEY (org_id, issuer, account_id) REFERENCES studio_account_refs(org_id, issuer, account_id)
) WITHOUT ROWID;

CREATE TABLE studio_audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  org_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  account_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('draft.created','draft.updated','draft.archived')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (org_id, issuer, account_id) REFERENCES studio_account_refs(org_id, issuer, account_id),
  FOREIGN KEY (record_id, org_id, issuer, account_id) REFERENCES studio_records(id, org_id, issuer, account_id)
);
CREATE INDEX studio_audit_owner_list ON studio_audit_events(org_id, issuer, account_id, created_at DESC, id);

-- A draft never moves to another owner, app or resource.
CREATE TRIGGER studio_records_owner_fixed BEFORE UPDATE OF id, org_id, issuer, account_id, app_id, resource, created_at ON studio_records
BEGIN SELECT RAISE(ABORT, 'studio record ownership is fixed'); END;
-- Recorded history and stored change responses are never rewritten.
CREATE TRIGGER studio_audit_events_fixed BEFORE UPDATE ON studio_audit_events
BEGIN SELECT RAISE(ABORT, 'studio audit events are append-only'); END;
CREATE TRIGGER studio_idempotency_fixed BEFORE UPDATE ON studio_idempotency_operations
BEGIN SELECT RAISE(ABORT, 'studio change responses are fixed'); END;
