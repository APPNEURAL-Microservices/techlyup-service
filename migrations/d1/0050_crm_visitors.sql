-- First-party optional anonymous analytics. No account/contact linkage or PII.
CREATE TABLE crm_visitors (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
 policy_version TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 revoked_at TEXT, external_granted INTEGER NOT NULL DEFAULT 0 CHECK(external_granted IN (0,1))
);
CREATE INDEX crm_visitors_expiry ON crm_visitors(expires_at);
CREATE TABLE crm_visitor_events (
 id TEXT PRIMARY KEY, visitor_hash TEXT NOT NULL REFERENCES crm_visitors(token_hash) ON DELETE CASCADE,
 event TEXT NOT NULL CHECK(event IN ('page_view','cta_click','form_open','resource_open')),
 page TEXT NOT NULL CHECK(page IN ('home','learn','webinars','mentors','career','contact','resources','organization')),
 created_at TEXT NOT NULL
);
CREATE INDEX crm_visitor_event_expiry ON crm_visitor_events(created_at,id);
CREATE TABLE crm_visitor_exports (
 event_id TEXT NOT NULL REFERENCES crm_visitor_events(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('posthog','ga4')),
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','rejected','uncertain','suppressed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(event_id,provider)
);
CREATE INDEX crm_visitor_export_due ON crm_visitor_exports(status,created_at);
