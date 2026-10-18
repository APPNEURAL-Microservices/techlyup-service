-- Atomic sparse outbox in the EXISTING canonical database. No backfill or PII.
-- Requires canonical website0001-0046 and app0047/0048. Historical forms are
-- not swept into CRM; a later reviewed import must independently prove scope.
CREATE TABLE crm_canonical_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('submission','newsletter','registration','attendance','completion')),
 source_id TEXT NOT NULL, created_at TEXT NOT NULL,org_id TEXT,available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',fanout_cursor TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','done','skipped','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_id TEXT, lease_until TEXT, result_code TEXT
);
CREATE INDEX crm_canonical_due ON crm_canonical_outbox(state,available_at,id);
CREATE TRIGGER crm_submission_insert AFTER INSERT ON submissions BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('submission:'||NEW.id,'submission',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER crm_attendance_insert AFTER INSERT ON workshop_attendance BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('attendance:'||NEW.registration_id||':'||NEW.attended||':'||NEW.recorded_at,'attendance',NEW.registration_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER crm_attendance_change AFTER UPDATE OF attended,recorded_at ON workshop_attendance
WHEN NEW.attended<>OLD.attended OR NEW.recorded_at<>OLD.recorded_at BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('attendance:'||NEW.registration_id||':'||NEW.attended||':'||NEW.recorded_at,'attendance',NEW.registration_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER crm_newsletter_insert AFTER INSERT ON email_subscribers BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('newsletter:'||NEW.rowid||':'||NEW.status||':'||NEW.last_requested_at,'newsletter',CAST(NEW.rowid AS TEXT),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER crm_newsletter_change AFTER UPDATE OF status,verified_at ON email_subscribers
WHEN NEW.status<>OLD.status OR COALESCE(NEW.verified_at,'')<>COALESCE(OLD.verified_at,'') BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('newsletter:'||NEW.rowid||':'||NEW.status||':'||COALESCE(NEW.verified_at,NEW.last_requested_at),'newsletter',CAST(NEW.rowid AS TEXT),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER crm_registration_change AFTER UPDATE OF status,workshop_datetime ON workshop_registrations
WHEN NEW.status<>OLD.status OR NEW.workshop_datetime<>OLD.workshop_datetime BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('registration:'||NEW.id||':'||NEW.status||':'||NEW.workshop_datetime,'registration',NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Completion creates one sparse dispatcher event, never an unbounded trigger
-- fan-out or an attendance inference. The worker pages explicit existing rows.
CREATE TRIGGER crm_core_completion_insert AFTER INSERT ON live_core_session_catalog
WHEN json_valid(NEW.session_json) AND json_extract(CASE WHEN json_valid(NEW.session_json) THEN NEW.session_json ELSE '{}' END,'$.status') IN('ENDED','REPLAY_READY') BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at,org_id)
 VALUES('core-completion:'||NEW.session_id||':'||NEW.session_version||':'||NEW.updated_at,'completion',NEW.workshop_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.org_id);
END;
CREATE TRIGGER crm_core_completion_change AFTER UPDATE OF session_json,session_version ON live_core_session_catalog
WHEN NEW.session_json<>OLD.session_json AND json_valid(NEW.session_json) AND json_extract(CASE WHEN json_valid(NEW.session_json) THEN NEW.session_json ELSE '{}' END,'$.status') IN('ENDED','REPLAY_READY') BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at,org_id)
 VALUES('core-completion:'||NEW.session_id||':'||NEW.session_version||':'||NEW.updated_at,'completion',NEW.workshop_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.org_id);
END;
CREATE TRIGGER crm_reviewed_completion_insert AFTER INSERT ON workshop_updates
WHEN json_valid(NEW.data) AND json_extract(CASE WHEN json_valid(NEW.data) THEN NEW.data ELSE '{}' END,'$.status')='completed' BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('reviewed-completion:'||NEW.workshop_id||':'||NEW.updated_at,'completion',NEW.workshop_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER crm_reviewed_completion_change AFTER UPDATE OF data ON workshop_updates
WHEN NEW.data<>OLD.data AND json_valid(NEW.data) AND json_extract(CASE WHEN json_valid(NEW.data) THEN NEW.data ELSE '{}' END,'$.status')='completed' BEGIN
 INSERT OR IGNORE INTO crm_canonical_outbox(event_key,source_kind,source_id,created_at)
 VALUES('reviewed-completion:'||NEW.workshop_id||':'||NEW.updated_at,'completion',NEW.workshop_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
