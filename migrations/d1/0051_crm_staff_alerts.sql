CREATE TABLE crm_staff_notifications (
 org_id TEXT NOT NULL,id TEXT NOT NULL,recipient_account_id TEXT NOT NULL REFERENCES learner_accounts(id),
 lead_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('new_lead','task_due')),
 source_event_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,
 PRIMARY KEY(org_id,id),UNIQUE(org_id,recipient_account_id,kind,source_event_id),
 FOREIGN KEY(org_id,lead_id) REFERENCES crm_leads(org_id,id)
);
CREATE INDEX crm_staff_notifications_owner ON crm_staff_notifications(org_id,recipient_account_id,created_at,id);
