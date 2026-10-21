BEGIN;
CREATE SCHEMA studio_workspace;

-- References canonical D1 identities. This schema stores no credentials, email
-- addresses, inferred roles, account signup, or copies of canonical learners.
CREATE TABLE studio_workspace.account_refs (
  org_id text NOT NULL CHECK (length(org_id) BETWEEN 1 AND 100),
  issuer text NOT NULL CHECK (issuer = 'techlyup-learner'),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, issuer, account_id)
);

CREATE TABLE studio_workspace.records (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  issuer text NOT NULL,
  account_id text NOT NULL,
  app_id text NOT NULL CHECK (app_id IN ('courses','mentorship','certificates','learners','earnings','promotion','insights','assistant')),
  resource text NOT NULL CHECK (resource ~ '^[a-z][a-z-]{0,39}$'),
  values jsonb NOT NULL CHECK (jsonb_typeof(values) = 'object' AND octet_length(values::text) <= 24000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id, issuer, account_id) REFERENCES studio_workspace.account_refs(org_id, issuer, account_id),
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
COMMENT ON TABLE studio_workspace.records IS 'Private preparation drafts only. Never creates canonical enrollment, appointment confirmation, credentials, financial transactions, delivery or AI generation.';
CREATE INDEX studio_records_owner_list ON studio_workspace.records(org_id,issuer,account_id,app_id,resource,status,updated_at DESC,id);

CREATE TABLE studio_workspace.idempotency_operations (
  org_id text NOT NULL,
  issuer text NOT NULL,
  account_id text NOT NULL,
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,issuer,account_id,idempotency_key),
  FOREIGN KEY (org_id,issuer,account_id) REFERENCES studio_workspace.account_refs(org_id,issuer,account_id)
);
CREATE TABLE studio_workspace.audit_events (
  id uuid PRIMARY KEY,
  org_id text NOT NULL,
  issuer text NOT NULL,
  account_id text NOT NULL,
  app_id text NOT NULL,
  resource text NOT NULL,
  record_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('draft.created','draft.updated','draft.archived')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id,issuer,account_id) REFERENCES studio_workspace.account_refs(org_id,issuer,account_id),
  FOREIGN KEY (record_id,org_id,issuer,account_id) REFERENCES studio_workspace.records(id,org_id,issuer,account_id)
);
CREATE INDEX studio_audit_owner_list ON studio_workspace.audit_events(org_id,issuer,account_id,created_at DESC,id);

DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['account_refs','records','idempotency_operations','audit_events'] LOOP
    EXECUTE format('ALTER TABLE studio_workspace.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE studio_workspace.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY own_workspace ON studio_workspace.%I USING (org_id = current_setting(''app.studio_org'',true) AND issuer = current_setting(''app.studio_issuer'',true) AND account_id = current_setting(''app.studio_account'',true)) WITH CHECK (org_id = current_setting(''app.studio_org'',true) AND issuer = current_setting(''app.studio_issuer'',true) AND account_id = current_setting(''app.studio_account'',true))', table_name);
  END LOOP;
END $policies$;
COMMIT;
