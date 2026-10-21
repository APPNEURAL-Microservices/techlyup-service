-- Replace studio_workspace_runtime with the reviewed NOSUPERUSER NOBYPASSRLS
-- runtime role. Apply with the migration owner; this grants no schema ownership.
GRANT USAGE ON SCHEMA studio_workspace TO studio_workspace_runtime;
GRANT SELECT, INSERT ON studio_workspace.account_refs TO studio_workspace_runtime;
GRANT SELECT, INSERT, UPDATE ON studio_workspace.records TO studio_workspace_runtime;
GRANT SELECT, INSERT, UPDATE ON studio_workspace.idempotency_operations TO studio_workspace_runtime;
GRANT SELECT, INSERT ON studio_workspace.audit_events TO studio_workspace_runtime;
