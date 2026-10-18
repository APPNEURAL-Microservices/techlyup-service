-- Schema ONLY derived from website migrations0001-0046 at253c77f. No rows or production data.
PRAGMA foreign_keys=ON;
CREATE TABLE automation_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE automation_rate_limits (id TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL);
CREATE TABLE certificate_email_access (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  registration_key TEXT NOT NULL,
  certificate_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE certificates (
  id TEXT PRIMARY KEY, -- credential id, e.g. TU-2026-C-9F3A2B (see certificates.ts for format)
  type TEXT NOT NULL CHECK (type IN ('completion', 'reviewed')),
  holder_name TEXT NOT NULL,
  holder_email TEXT NOT NULL,
  -- 'completion': course title/slug. 'reviewed': program/track title; slug optional.
  subject_title TEXT NOT NULL,
  subject_slug TEXT,
  learner_id TEXT, -- set for 'completion' (ties back to the progress rows that earned it)
  issued_by TEXT, -- set for 'reviewed' (identifies who approved it, e.g. an admin email)
  issued_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE course_products (
 slug TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
 price_minor INTEGER NOT NULL CHECK(price_minor>0), access_days INTEGER NOT NULL CHECK(access_days BETWEEN 1 AND 3650),
 lessons_json TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0 CHECK(published IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE email_subscribers (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','unsubscribed')),
  unsubscribe_token TEXT NOT NULL UNIQUE,
  consent_at TEXT NOT NULL,
  verified_at TEXT,
  code_hash TEXT,
  challenge_id TEXT,
  code_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_requested_at TEXT NOT NULL
);
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  offer_slug TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  -- NULL = no expiry (this offer's access doesn't time out).
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')) DEFAULT 'active',
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE TABLE historical_claim_approvals (
  person_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approved_by TEXT NOT NULL DEFAULT 'admin',
  PRIMARY KEY(person_id, source_event_key),
  FOREIGN KEY(person_id, source_event_key)
    REFERENCES historical_claim_events(person_id, source_event_key)
);
CREATE TABLE historical_claim_attempts (
  person_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  PRIMARY KEY(person_id, source_event_key, attempted_at)
);
CREATE TABLE historical_claim_events (
  person_id TEXT NOT NULL REFERENCES imported_webinar_people(id),
  source_event_key TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_mode TEXT NOT NULL CHECK (event_mode IN ('online','offline','unknown')),
  source_site TEXT NOT NULL DEFAULT 'innovatewithajay.com',
  PRIMARY KEY(person_id, source_event_key)
);
CREATE TABLE historical_claim_feedback (
  person_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  feedback TEXT NOT NULL,
  attended_asserted_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY(person_id, source_event_key),
  FOREIGN KEY(person_id, source_event_key)
    REFERENCES historical_claim_events(person_id, source_event_key)
);
CREATE TABLE historical_claim_invitations (
  person_id TEXT PRIMARY KEY REFERENCES imported_webinar_people(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE historical_claim_question_sets (
  source_event_key TEXT PRIMARY KEY,
  questions_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE historical_claim_quiz_passes (
  person_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  passed_at TEXT NOT NULL,
  PRIMARY KEY(person_id, source_event_key),
  FOREIGN KEY(person_id, source_event_key)
    REFERENCES historical_claim_events(person_id, source_event_key)
);
CREATE TABLE "historical_event_certificates" (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES imported_webinar_people(id),
  source_event_key TEXT NOT NULL,
  source_site TEXT NOT NULL DEFAULT 'innovatewithajay.com',
  type TEXT NOT NULL DEFAULT 'attendance' CHECK (type = 'attendance'),
  holder_name TEXT NOT NULL,
  holder_email TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  subject_slug TEXT NOT NULL,
  event_date TEXT NOT NULL,
  event_mode TEXT NOT NULL CHECK (event_mode IN ('online','offline','unknown')),
  attendance_basis TEXT NOT NULL CHECK (attendance_basis IN ('quiz_pass','admin_approval','invitation_claim')),
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  claim_token_hash TEXT UNIQUE,
  claimed_at TEXT,
  revoked_at TEXT,
  UNIQUE(person_id, source_event_key)
);
CREATE TABLE imported_webinar_attendance (
  person_id TEXT PRIMARY KEY REFERENCES imported_webinar_people(id),
  workshop_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis = 'owner_confirmation'),
  confirmed_at TEXT NOT NULL
);
CREATE TABLE imported_webinar_certificates (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE REFERENCES imported_webinar_people(id),
  type TEXT NOT NULL DEFAULT 'attendance' CHECK (type = 'attendance'),
  holder_name TEXT NOT NULL,
  holder_email TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  subject_slug TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  claim_token_hash TEXT NOT NULL UNIQUE,
  claimed_at TEXT,
  revoked_at TEXT
);
CREATE TABLE imported_webinar_people (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  associated_workshop_id TEXT NOT NULL,
  source_site TEXT NOT NULL DEFAULT 'innovatewithajay.com',
  registration_kind TEXT NOT NULL DEFAULT 'historical_import'
    CHECK (registration_kind = 'historical_import'),
  communication_consent TEXT NOT NULL DEFAULT 'not_recorded'
    CHECK (communication_consent = 'not_recorded'),
  first_seen_at TEXT,
  imported_at TEXT NOT NULL
);
CREATE TABLE imported_webinar_source_records (
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('webinar_registration', 'user_profile', 'workshop_candidate')),
  source_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES imported_webinar_people(id),
  source_event_id TEXT,
  source_event_title TEXT,
  source_event_datetime TEXT,
  source_status TEXT,
  attended INTEGER CHECK (attended IN (0, 1)),
  source_created_at TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
CREATE TABLE learner_account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE learner_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
  audience_ids TEXT NOT NULL DEFAULT '[]',
  goal_ids TEXT NOT NULL DEFAULT '[]',
  interest_ids TEXT NOT NULL DEFAULT '[]',
  consent_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, first_name TEXT, middle_name TEXT, last_name TEXT);
CREATE TABLE learner_anonymous_claims (
  anonymous_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
  claimed_at TEXT NOT NULL
);
CREATE TABLE learner_bookmarks (
  account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('course','webinar')),
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id,kind,item_id)
);
CREATE TABLE learner_email_verifications (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES learner_accounts(id) ON DELETE CASCADE,
 email_sha256 TEXT NOT NULL CHECK(length(email_sha256)=64),
 token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
 status TEXT NOT NULL CHECK(status IN ('pending','consumed','superseded')),
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 consumed_at TEXT,
 CHECK((status='consumed')=(consumed_at IS NOT NULL))
);
CREATE TABLE learner_progress (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  course_slug TEXT NOT NULL,
  lesson_slug TEXT NOT NULL,
  content_version INTEGER NOT NULL,
  resume_status TEXT NOT NULL CHECK (resume_status IN ('not_started', 'viewed')),
  practice_status TEXT NOT NULL CHECK (practice_status IN ('not_started', 'self_marked_complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (learner_id, course_slug, lesson_slug)
);
CREATE TABLE learning_catalog_audit (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('save-draft','publish','archive')),
  created_at TEXT NOT NULL,
  UNIQUE (kind,record_id,version)
);
CREATE TABLE learning_catalog_records (
  kind TEXT NOT NULL CHECK (kind IN ('course','mentor','board','class','subject','chapter','degree','category','path','homepage')),
  id TEXT NOT NULL,
  slug TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  published_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  published_version INTEGER,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (kind,id),
  UNIQUE (kind,slug)
);
CREATE TABLE live_attendance_decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  registration_id TEXT NOT NULL REFERENCES workshop_registrations(id),
  participant_id TEXT REFERENCES live_participants(id),
  eligibility_state TEXT NOT NULL CHECK(eligibility_state IN ('eligible','ineligible','insufficient_evidence','not_computable','operator_override')),
  attendance_percent INTEGER,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
  applied_at TEXT,
  applied_by TEXT,
  force_applied INTEGER NOT NULL DEFAULT 0 CHECK(force_applied IN (0,1)),
  superseded_by_manual_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, registration_id)
);
CREATE TABLE live_attendance_intervals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  participant_id TEXT REFERENCES live_participants(id),
  viewing_session_id TEXT REFERENCES live_viewing_sessions(id),
  source TEXT NOT NULL CHECK(source IN ('heartbeat','provider_webhook','operator')),
  correlation TEXT NOT NULL DEFAULT 'exact' CHECK(correlation IN ('exact','provider_session_only','unverified')),
  provider TEXT CHECK(provider IS NULL OR provider IN ('realtimekit','stream')),
  provider_participant_id TEXT,
  provider_session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','uncertain')),
  closed_reason TEXT,
  clipped_to_session INTEGER NOT NULL DEFAULT 0 CHECK(clipped_to_session IN (0,1)),
  dedupe_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE live_attendance_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default' CHECK(scope IN ('default','delivery','session')),
  delivery TEXT CHECK(delivery IS NULL OR delivery IN ('interactive','broadcast')),
  session_id TEXT REFERENCES live_sessions(id),
  threshold_percent INTEGER NOT NULL DEFAULT 70 CHECK(threshold_percent >= 0 AND threshold_percent <= 100),
  min_seconds INTEGER NOT NULL DEFAULT 60 CHECK(min_seconds >= 0),
  heartbeat_seconds INTEGER NOT NULL DEFAULT 30 CHECK(heartbeat_seconds >= 5),
  max_gap_seconds INTEGER NOT NULL DEFAULT 90 CHECK(max_gap_seconds >= 10),
  credit_hidden_tab INTEGER NOT NULL DEFAULT 0 CHECK(credit_hidden_tab IN (0,1)),
  accept_unverified_correlation INTEGER NOT NULL DEFAULT 0 CHECK(accept_unverified_correlation IN (0,1)),
  provider_attendance_trusted INTEGER NOT NULL DEFAULT 0 CHECK(provider_attendance_trusted IN (0,1)),
  reconcile_after_seconds INTEGER NOT NULL DEFAULT 300 CHECK(reconcile_after_seconds >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE live_attendance_totals (
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  participant_id TEXT NOT NULL REFERENCES live_participants(id),
  covered_seconds REAL NOT NULL DEFAULT 0 CHECK(covered_seconds >= 0),
  session_seconds REAL,
  attendance_percent INTEGER CHECK(attendance_percent IS NULL OR (attendance_percent >= 0 AND attendance_percent <= 100)),
  reconnection_count INTEGER NOT NULL DEFAULT 0 CHECK(reconnection_count >= 0),
  first_seen_at TEXT,
  last_seen_at TEXT,
  evidence TEXT NOT NULL DEFAULT 'none' CHECK(evidence IN ('validated_heartbeat','provider_event','mixed','none')),
  correlation TEXT NOT NULL DEFAULT 'none' CHECK(correlation IN ('exact','provider_session_only','unverified','none')),
  eligibility_state TEXT NOT NULL DEFAULT 'not_computable' CHECK(eligibility_state IN ('eligible','ineligible','insufficient_evidence','not_computable','operator_override')),
  reason TEXT NOT NULL DEFAULT '',
  policy_snapshot_json TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY(session_id, participant_id)
);
CREATE TABLE live_chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  participant_id TEXT NOT NULL REFERENCES live_participants(id),
  author_role TEXT NOT NULL DEFAULT 'attendee' CHECK(author_role IN ('administrator','host','co_host','moderator','presenter','attendee')),
  kind TEXT NOT NULL DEFAULT 'message' CHECK(kind IN ('message','announcement')),
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'visible' CHECK(state IN ('visible','removed','held')),
  moderation_reason TEXT,
  moderated_by TEXT,
  report_count INTEGER NOT NULL DEFAULT 0 CHECK(report_count >= 0),
  client_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE live_communication_account_suppressions (
 account_id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('service','marketing')),
 reason TEXT NOT NULL,created_at TEXT NOT NULL,revision TEXT NOT NULL DEFAULT '',PRIMARY KEY(account_id,purpose)
);
CREATE TABLE live_communication_suppressions (
 channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp')),contact_hash TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('service','marketing')),reason TEXT NOT NULL,
 created_at TEXT NOT NULL,revision TEXT NOT NULL DEFAULT '',PRIMARY KEY(channel,contact_hash,purpose)
);
CREATE TABLE live_core_registration_links (
  registration_id TEXT PRIMARY KEY REFERENCES workshop_registrations(id),
  session_id TEXT NOT NULL REFERENCES live_core_session_catalog(session_id),
  org_id TEXT NOT NULL,
  learner_account_id TEXT REFERENCES learner_accounts(id),
  source_json TEXT,
  consent_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id,learner_account_id)
);
CREATE TABLE live_core_session_catalog (
  session_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  workshop_id TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL CHECK(session_version>0),
  session_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE live_core_staff_links (
  learner_account_id TEXT NOT NULL REFERENCES learner_accounts(id),
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','manager','member','viewer')),
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  linked_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(learner_account_id,org_id),
  UNIQUE(org_id,actor_id)
);
CREATE TABLE live_crm_source_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,
 org_id TEXT NOT NULL,session_id TEXT NOT NULL,registration_id TEXT NOT NULL,
 account_id TEXT NOT NULL,kind TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
);
CREATE TABLE live_email_privacy_receipts (
 org_id TEXT NOT NULL,
 event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
 body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
 created_at TEXT NOT NULL,
 PRIMARY KEY(org_id,event_sha256)
);
CREATE TABLE live_participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  registration_id TEXT REFERENCES workshop_registrations(id),
  org_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'attendee' CHECK(role IN ('administrator','host','co_host','moderator','presenter','attendee')),
  role_source TEXT NOT NULL DEFAULT 'registration' CHECK(role_source IN ('registration','operator_assigned','erp_assignment')),
  display_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'admitted' CHECK(status IN ('admitted','invited','ejected','withdrawn')),
  ticket_hash TEXT,
  ticket_expires_at TEXT,
  learner_account_id TEXT REFERENCES learner_accounts(id),
  learner_account_link_source TEXT CHECK(learner_account_link_source IS NULL OR learner_account_link_source IN ('self_declared_at_admission','operator_assigned')),
  provider_participant_id TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  ejection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, registration_id),
  UNIQUE(session_id, email)
);
CREATE TABLE live_poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES live_polls(id),
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(poll_id, label)
);
CREATE TABLE live_poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES live_polls(id),
  option_id TEXT NOT NULL REFERENCES live_poll_options(id),
  participant_id TEXT NOT NULL REFERENCES live_participants(id),
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  created_at TEXT NOT NULL,
  UNIQUE(poll_id, participant_id, option_id)
);
CREATE TABLE live_polls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'single' CHECK(mode IN ('single','multiple')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')),
  one_vote_per_participant INTEGER NOT NULL DEFAULT 1 CHECK(one_vote_per_participant IN (0,1)),
  results_visible TEXT NOT NULL DEFAULT 'after_close' CHECK(results_visible IN ('never','after_close','live')),
  opened_at TEXT,
  closed_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE live_provider_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('realtimekit','stream')),
  dedupe_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT REFERENCES live_sessions(id),
  provider_session_id TEXT,
  provider_participant_id TEXT,
  correlation TEXT NOT NULL DEFAULT 'unverified' CHECK(correlation IN ('exact','provider_session_only','unverified')),
  occurred_at TEXT,
  payload_json TEXT NOT NULL,
  payload_truncated INTEGER NOT NULL DEFAULT 0 CHECK(payload_truncated IN (0,1)),
  signature_valid INTEGER NOT NULL DEFAULT 0 CHECK(signature_valid IN (0,1)),
  process_status TEXT NOT NULL DEFAULT 'pending' CHECK(process_status IN ('pending','processed','ignored','failed')),
  process_error_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, dedupe_key)
);
CREATE TABLE live_questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  participant_id TEXT NOT NULL REFERENCES live_participants(id),
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','answered','rejected','removed')),
  upvotes INTEGER NOT NULL DEFAULT 0 CHECK(upvotes >= 0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  answer_note TEXT NOT NULL DEFAULT '',
  answered_by TEXT,
  answered_at TEXT,
  moderated_by TEXT,
  client_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE live_sessions (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinar_erp_operations(webinar_id),
  org_id TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK(delivery IN ('interactive','broadcast')),
  provider TEXT NOT NULL CHECK(provider IN ('realtimekit','stream')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','lobby_open','live','ending','ended','replay_ready','cancelled','failed')),
  title TEXT NOT NULL,
  scheduled_starts_at TEXT,
  scheduled_ends_at TEXT,
  lobby_lead_seconds INTEGER NOT NULL DEFAULT 900 CHECK(lobby_lead_seconds >= 0),
  grace_seconds INTEGER NOT NULL DEFAULT 300 CHECK(grace_seconds >= 0),
  started_at TEXT,
  confirmed_live_at TEXT,
  ended_at TEXT,
  cancel_reason TEXT,
  capacity INTEGER,
  recording_state TEXT NOT NULL DEFAULT 'none' CHECK(recording_state IN ('none','pending','processing','available','failed','expired')),
  recording_object_key TEXT,
  replay_published INTEGER NOT NULL DEFAULT 0 CHECK(replay_published IN (0,1)),
  reconcile_token TEXT,
  reconciled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((delivery='interactive' AND provider='realtimekit') OR (delivery='broadcast' AND provider='stream')),
  CHECK(scheduled_starts_at IS NULL OR scheduled_ends_at IS NULL OR scheduled_ends_at > scheduled_starts_at),
  CHECK(started_at IS NULL OR ended_at IS NULL OR ended_at > started_at)
);
CREATE TABLE live_viewing_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions(id),
  participant_id TEXT NOT NULL REFERENCES live_participants(id),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed','uncertain')),
  opened_at TEXT NOT NULL,
  ended_at TEXT,
  closed_reason TEXT CHECK(closed_reason IS NULL OR closed_reason IN ('gap_timeout','stop','session_ended','worker_evicted','superseded_connection')),
  credited_seconds REAL NOT NULL DEFAULT 0 CHECK(credited_seconds >= 0),
  flushed_seconds REAL NOT NULL DEFAULT 0 CHECK(flushed_seconds >= 0),
  heartbeat_count INTEGER NOT NULL DEFAULT 0 CHECK(heartbeat_count >= 0),
  reconnection_count INTEGER NOT NULL DEFAULT 0 CHECK(reconnection_count >= 0),
  last_heartbeat_at TEXT,
  evidence TEXT NOT NULL DEFAULT 'validated_heartbeat' CHECK(evidence IN ('validated_heartbeat','provider_event','mixed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(credited_seconds >= flushed_seconds)
);
CREATE TABLE notification_jobs (
  id TEXT PRIMARY KEY,
  flow_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','completed','uncertain','failed','suppressed')),
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_at TEXT,
  completed_at TEXT,
  subscriber_email TEXT,
  guard_json TEXT
, provider TEXT, provider_message_id TEXT);
CREATE TABLE order_access_tokens (order_id TEXT PRIMARY KEY REFERENCES orders(id), token TEXT NOT NULL UNIQUE);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  razorpay_payment_id TEXT,
  offer_slug TEXT NOT NULL,       -- e.g. a program slug — what was being bought
  offer_title TEXT NOT NULL,      -- snapshotted at order time, so a later catalog edit can't rewrite history
  amount_minor INTEGER NOT NULL,  -- integer paise, never a float
  currency TEXT NOT NULL DEFAULT 'INR',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  -- 'created': order exists at Razorpay, no payment yet.
  -- 'paid': signature-verified (client callback) and/or webhook-confirmed captured payment.
  -- 'failed': Razorpay reported a failed attempt.
  -- 'refunded': a refund was recorded against this order.
  status TEXT NOT NULL CHECK (status IN ('created', 'paid', 'failed', 'refunded')) DEFAULT 'created',
  verified_via TEXT, -- 'client_signature' | 'webhook' | both, comma-joined — which mechanism(s) confirmed this order
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  failure_reason TEXT
, course_slug TEXT REFERENCES course_products(slug), access_days INTEGER);
CREATE TABLE payment_refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  payment_id TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL, processed_at TEXT NOT NULL
);
CREATE TABLE payment_webhook_events (
  id TEXT PRIMARY KEY, -- Razorpay's x-razorpay-event-id
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE seat_offers (
 id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, registration_id TEXT NOT NULL REFERENCES workshop_registrations(id),
 workshop_id TEXT NOT NULL, workshop_datetime TEXT NOT NULL, revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','expired','declined','cancelled')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(registration_id,revision)
);
CREATE TABLE "submissions" (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'website', 'enterprise_demo', 'mentor_session', 'mentor_application', 'topic_request',
    'historical_claim_feedback', 'historical_claim_skip'
  )),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','reviewing','more_information_needed','approved','declined','closed')),
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE webinar_attendance_certificates (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL UNIQUE REFERENCES workshop_registrations(id),
  type TEXT NOT NULL DEFAULT 'attendance' CHECK(type = 'attendance'),
  holder_name TEXT NOT NULL,
  holder_email TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  subject_slug TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT
, claim_token_hash TEXT, claimed_at TEXT);
CREATE TABLE webinar_catalog (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE webinar_checkouts (
  id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL,
  email TEXT NOT NULL,
  profile TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL,
  order_id TEXT UNIQUE,
  registration_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','review','refunded')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_assessment_attempts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL REFERENCES webinar_erp_assessments(id),
  assessment_version INTEGER NOT NULL, registration_id TEXT NOT NULL REFERENCES workshop_registrations(id),
  learner_account_id TEXT NOT NULL REFERENCES learner_accounts(id),
  attempt_number INTEGER NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  answers_json TEXT NOT NULL, submission_text TEXT NOT NULL, submission_url TEXT,
  auto_score INTEGER, score INTEGER, pass_mark INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_review','passed','failed')),
  graded_by TEXT, last_grade_token TEXT, feedback TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  submitted_at TEXT NOT NULL, graded_at TEXT,
  UNIQUE(assessment_id,learner_account_id,attempt_number),
  UNIQUE(assessment_id,learner_account_id,idempotency_key)
);
CREATE TABLE webinar_erp_assessments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, webinar_id TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('quiz','assignment')),
  instructions TEXT NOT NULL, questions_json TEXT NOT NULL,
  pass_mark INTEGER NOT NULL CHECK(pass_mark BETWEEN 0 AND 100),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
  opens_at TEXT NOT NULL, due_at TEXT NOT NULL,
  require_attendance INTEGER NOT NULL CHECK(require_attendance IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_assignments (
  webinar_id TEXT NOT NULL, trainer_id TEXT NOT NULL REFERENCES webinar_erp_trainers(id),
  org_id TEXT NOT NULL, assignment_role TEXT NOT NULL CHECK(assignment_role IN ('speaker','cohost','moderator')),
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
  created_at TEXT NOT NULL, PRIMARY KEY(webinar_id,trainer_id,assignment_role)
);
CREATE TABLE webinar_erp_audit (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, record_id TEXT, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_case_messages (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES webinar_erp_cases(id), org_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('learner','operator')), author_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','internal')), body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(case_id,author_kind,author_id,idempotency_key)
);
CREATE TABLE webinar_erp_cases (
  id TEXT PRIMARY KEY REFERENCES submissions(id), org_id TEXT NOT NULL,
  webinar_id TEXT, registration_id TEXT REFERENCES workshop_registrations(id),
  learner_account_id TEXT REFERENCES learner_accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('support','dispute')),
  category TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
  assignee_actor_id TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','resolved','closed')),
  resolution_summary TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_contracts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, webinar_id TEXT NOT NULL,
  trainer_id TEXT NOT NULL REFERENCES webinar_erp_trainers(id), model TEXT NOT NULL CHECK(model IN ('fixed','revenue_share')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>=0), basis_points INTEGER NOT NULL CHECK(basis_points BETWEEN 0 AND 10000),
  currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL CHECK(status IN ('draft','active','cancelled')),
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_credential_evidence (
  id TEXT PRIMARY KEY, certificate_id TEXT NOT NULL UNIQUE REFERENCES certificates(id),
  org_id TEXT NOT NULL, assessment_id TEXT NOT NULL REFERENCES webinar_erp_assessments(id),
  attempt_id TEXT NOT NULL REFERENCES webinar_erp_assessment_attempts(id),
  learner_account_id TEXT NOT NULL REFERENCES learner_accounts(id),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('webinar_assessment','webinar_assignment')),
  score INTEGER NOT NULL, pass_mark INTEGER NOT NULL, review_note TEXT NOT NULL,
  issued_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE webinar_erp_learner_registrations (
  registration_id TEXT PRIMARY KEY REFERENCES workshop_registrations(id),
  learner_account_id TEXT NOT NULL REFERENCES learner_accounts(id), org_id TEXT NOT NULL,
  bound_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_mentorship (
  id TEXT PRIMARY KEY REFERENCES submissions(id), org_id TEXT NOT NULL,
  learner_account_id TEXT REFERENCES learner_accounts(id), trainer_id TEXT REFERENCES webinar_erp_trainers(id),
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','reviewed','declined','reschedule_requested','pending_payment','confirmed','in_progress','completed','cancelled')),
  goals TEXT NOT NULL, preferred_start TEXT, review_note TEXT NOT NULL DEFAULT '',
  starts_at TEXT, ends_at TEXT, join_url TEXT, amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(amount_minor>=0),
  currency TEXT NOT NULL DEFAULT 'INR', payment_status TEXT NOT NULL DEFAULT 'not_quoted' CHECK(payment_status IN ('not_quoted','free','integration_required')),
  started_at TEXT, completed_at TEXT, completion_summary TEXT NOT NULL DEFAULT '', action_items_json TEXT NOT NULL DEFAULT '[]',
  cancellation_reason TEXT NOT NULL DEFAULT '', last_mutation_token TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((starts_at IS NULL AND ends_at IS NULL) OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND julianday(ends_at)>julianday(starts_at))),
  CHECK(status NOT IN ('confirmed','in_progress','completed') OR (trainer_id IS NOT NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND join_url IS NOT NULL AND amount_minor=0 AND payment_status='free'))
);
CREATE TABLE webinar_erp_operations (
  webinar_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'draft' CHECK(approval_status IN ('draft','submitted','approved','changes_requested')),
  review_note TEXT NOT NULL DEFAULT '', meeting_provider TEXT NOT NULL DEFAULT 'unconfigured',
  meeting_url TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, meeting_mutation_token TEXT);
CREATE TABLE webinar_erp_provider_links (
  provider TEXT NOT NULL CHECK(provider IN ('realtimekit','stream')),
  webinar_id TEXT NOT NULL REFERENCES webinar_erp_operations(webinar_id),
  org_id TEXT NOT NULL,
  remote_id TEXT,
  created_remote_id TEXT,
  url TEXT,
  remote_status TEXT,
  provisioning_status TEXT NOT NULL CHECK(provisioning_status IN ('creating','uncertain','local_failed','linked','detached','rejected')),
  operation_id TEXT NOT NULL,
  synced_at TEXT,
  metrics_json TEXT,
  metrics_state TEXT NOT NULL DEFAULT 'pending' CHECK(metrics_state IN ('pending','available','unavailable')),
  ingest_key_fingerprint TEXT,
  playback_policy TEXT NOT NULL DEFAULT 'signed' CHECK(playback_policy IN ('public','signed','off')),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, webinar_id),
  UNIQUE(provider, org_id, remote_id)
);
CREATE TABLE webinar_erp_requests (
  org_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  response_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(org_id,actor_id,idempotency_key)
);
CREATE TABLE webinar_erp_roles (
  org_id TEXT NOT NULL, actor_id TEXT NOT NULL, functional_role TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(org_id,actor_id,functional_role)
);
CREATE TABLE webinar_erp_series (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly')),
  interval_count INTEGER NOT NULL CHECK(interval_count BETWEEN 1 AND 52),
  starts_at TEXT NOT NULL, occurrence_count INTEGER NOT NULL CHECK(occurrence_count BETWEEN 1 AND 24),
  excluded_dates_json TEXT NOT NULL, template_json TEXT NOT NULL,
  trainer_id TEXT NOT NULL REFERENCES webinar_erp_trainers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generated','archived')),
  version INTEGER NOT NULL DEFAULT 1, generation_token TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_series_sessions (
  org_id TEXT NOT NULL, series_id TEXT NOT NULL REFERENCES webinar_erp_series(id),
  webinar_id TEXT NOT NULL UNIQUE, sequence_number INTEGER NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(series_id,sequence_number)
);
CREATE TABLE webinar_erp_settlements (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, contract_id TEXT NOT NULL UNIQUE REFERENCES webinar_erp_contracts(id),
  webinar_id TEXT NOT NULL, trainer_id TEXT NOT NULL, gross_minor INTEGER NOT NULL,
  refunds_minor INTEGER NOT NULL, net_minor INTEGER NOT NULL, payable_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL CHECK(status IN ('calculated','approved','paid')),
  evidence TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE webinar_erp_trainers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT, submission_id TEXT UNIQUE,
  name TEXT NOT NULL, email TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('trainer','teacher','mentor')),
  bio TEXT NOT NULL, headline TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', expertise_json TEXT NOT NULL, languages_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','approved','declined','more_information_needed','suspended')),
  review_note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,email,kind)
);
CREATE TABLE webinar_erp_webinargg (
  webinar_id TEXT PRIMARY KEY REFERENCES webinar_erp_operations(webinar_id),
  org_id TEXT NOT NULL,
  remote_id TEXT,
  created_remote_id TEXT,
  url TEXT,
  remote_status TEXT,
  provisioning_status TEXT NOT NULL CHECK(provisioning_status IN ('creating','uncertain','local_failed','linked','detached','rejected')),
  operation_id TEXT NOT NULL,
  synced_at TEXT,
  metrics_json TEXT,
  metrics_state TEXT NOT NULL DEFAULT 'pending' CHECK(metrics_state IN ('pending','available','unavailable')),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id,remote_id)
);
CREATE TABLE "webinar_feedback_submissions" (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL,
  webinar_title TEXT NOT NULL,
  webinar_track TEXT,
  webinar_datetime TEXT,
  learner_name TEXT NOT NULL,
  learner_role TEXT NOT NULL CHECK(learner_role IN ('student_fresher','developer','other_professional','other','prefer_not_say')),
  overall_rating INTEGER NOT NULL CHECK(overall_rating BETWEEN 0 AND 5),
  clarity_rating INTEGER NOT NULL CHECK(clarity_rating BETWEEN 0 AND 5),
  demo_rating INTEGER NOT NULL CHECK(demo_rating BETWEEN 0 AND 5),
  session_pace TEXT NOT NULL CHECK(session_pace IN ('too_slow','slightly_slow','about_right','slightly_fast','too_fast')),
  confidence_before INTEGER NOT NULL CHECK(confidence_before BETWEEN 0 AND 5),
  confidence_after INTEGER NOT NULL CHECK(confidence_after BETWEEN 0 AND 5),
  useful_themes TEXT NOT NULL,
  biggest_takeaway TEXT NOT NULL,
  improvement TEXT NOT NULL,
  next_topic_themes TEXT NOT NULL,
  next_topic_other TEXT NOT NULL,
  preferred_next_step TEXT NOT NULL CHECK(preferred_next_step IN ('free_workshop','paid_program','mentorship','not_now')),
  contact_email TEXT NOT NULL,
  contact_whatsapp TEXT NOT NULL,
  consent_email_updates INTEGER NOT NULL CHECK(consent_email_updates IN (0,1)),
  consent_whatsapp_updates INTEGER NOT NULL CHECK(consent_whatsapp_updates IN (0,1)),
  source_path TEXT,
  submitted_at TEXT NOT NULL,
  UNIQUE(webinar_id, contact_email)
);
CREATE TABLE webinar_resources (
  id TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 20971520),
  object_key TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE webinar_topic_votes (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  voter_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(topic_id, voter_key)
);
CREATE TABLE workshop_attendance (
  registration_id TEXT PRIMARY KEY REFERENCES workshop_registrations(id),
  attended INTEGER NOT NULL CHECK(attended IN (0,1)), recorded_at TEXT NOT NULL
);
CREATE TABLE workshop_feedback (
  registration_id TEXT PRIMARY KEY REFERENCES workshop_registrations(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT NOT NULL, submitted_at TEXT NOT NULL
);
CREATE TABLE workshop_registrations (
  id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL,
  workshop_title TEXT NOT NULL,
  workshop_datetime TEXT NOT NULL, -- ISO 8601 with offset, e.g. 2026-09-19T11:00:00+05:30
  workshop_venue TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'waitlisted', 'cancelled')),
  manage_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  reminder_24h_sent_at TEXT,
  reminder_1h_sent_at TEXT, workshop_join_url TEXT, notification_revision INTEGER NOT NULL DEFAULT 0, city TEXT, qualification TEXT, current_status TEXT, interested_domain TEXT, middle_name TEXT NOT NULL DEFAULT '',
  UNIQUE (email, workshop_id)
);
CREATE TABLE workshop_updates (workshop_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_certificate_email_access_expiry ON certificate_email_access(expires_at);
CREATE INDEX idx_certificates_learner_course
  ON certificates (learner_id, subject_slug);
CREATE INDEX idx_entitlements_customer_offer ON entitlements (customer_email, offer_slug);
CREATE INDEX idx_historical_event_certificates_email ON historical_event_certificates (holder_email);
CREATE INDEX idx_imported_webinar_certificates_email
  ON imported_webinar_certificates (holder_email);
CREATE INDEX idx_imported_webinar_people_workshop
  ON imported_webinar_people (associated_workshop_id);
CREATE INDEX idx_imported_webinar_source_person
  ON imported_webinar_source_records (person_id);
CREATE INDEX idx_learner_progress_course
  ON learner_progress (learner_id, course_slug);
CREATE INDEX idx_learner_sessions_expiry ON learner_account_sessions(expires_at);
CREATE INDEX idx_learner_sessions_owner ON learner_account_sessions(account_id);
CREATE INDEX idx_learning_catalog_published ON learning_catalog_records(status,kind);
CREATE INDEX idx_live_core_registration_learner ON live_core_registration_links(learner_account_id,created_at);
CREATE INDEX idx_live_core_registration_session ON live_core_registration_links(session_id,created_at,registration_id);
CREATE INDEX idx_notification_due ON notification_jobs(status, available_at);
CREATE INDEX idx_orders_customer_email ON orders (customer_email);
CREATE INDEX idx_orders_razorpay_payment ON orders (razorpay_payment_id);
CREATE INDEX idx_submissions_kind_created ON submissions (kind, created_at);
CREATE INDEX idx_submissions_status ON submissions (kind, status);
CREATE UNIQUE INDEX idx_webinar_attendance_certificates_claim_token_hash
  ON webinar_attendance_certificates (claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;
CREATE INDEX idx_webinar_attendance_certificates_email
  ON webinar_attendance_certificates (holder_email);
CREATE INDEX idx_webinar_feedback_webinar ON webinar_feedback_submissions (webinar_id);
CREATE INDEX idx_webinar_topic_votes_topic
  ON webinar_topic_votes (topic_id);
CREATE INDEX idx_workshop_registrations_claim_email ON workshop_registrations(lower(email));
CREATE INDEX idx_workshop_registrations_manage_token
  ON workshop_registrations (manage_token);
CREATE INDEX idx_workshop_registrations_reminder_lookup
  ON workshop_registrations (status, workshop_datetime, reminder_24h_sent_at, reminder_1h_sent_at);
CREATE INDEX idx_workshop_registrations_workshop
  ON workshop_registrations (workshop_id);
CREATE INDEX learner_email_verifications_expiry ON learner_email_verifications(expires_at);
CREATE UNIQUE INDEX learner_email_verifications_one_pending ON learner_email_verifications(account_id) WHERE status='pending';
CREATE INDEX live_attendance_decisions_session ON live_attendance_decisions(session_id, applied);
CREATE UNIQUE INDEX live_attendance_intervals_dedupe ON live_attendance_intervals(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX live_attendance_intervals_provider ON live_attendance_intervals(provider, provider_participant_id);
CREATE INDEX live_attendance_intervals_session ON live_attendance_intervals(session_id, participant_id);
CREATE UNIQUE INDEX live_attendance_policies_one_default ON live_attendance_policies(org_id) WHERE scope='default' AND active=1;
CREATE INDEX live_attendance_policies_session ON live_attendance_policies(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX live_attendance_totals_session ON live_attendance_totals(session_id, eligibility_state);
CREATE UNIQUE INDEX live_chat_messages_client ON live_chat_messages(session_id, participant_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX live_chat_messages_session ON live_chat_messages(session_id, created_at);
CREATE INDEX live_chat_messages_state ON live_chat_messages(session_id, state);
CREATE INDEX live_participants_provider ON live_participants(session_id, provider_participant_id);
CREATE INDEX live_participants_registration ON live_participants(registration_id);
CREATE INDEX live_participants_session ON live_participants(session_id, status);
CREATE UNIQUE INDEX live_participants_ticket ON live_participants(ticket_hash) WHERE ticket_hash IS NOT NULL;
CREATE INDEX live_poll_options_poll ON live_poll_options(poll_id, position);
CREATE INDEX live_poll_votes_participant ON live_poll_votes(poll_id, participant_id);
CREATE INDEX live_poll_votes_tally ON live_poll_votes(poll_id, option_id);
CREATE UNIQUE INDEX live_polls_one_open ON live_polls(session_id) WHERE status='open';
CREATE INDEX live_polls_session ON live_polls(session_id, status);
CREATE UNIQUE INDEX live_questions_client ON live_questions(session_id, participant_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX live_questions_participant ON live_questions(session_id, participant_id);
CREATE INDEX live_questions_session ON live_questions(session_id, state, upvotes);
CREATE UNIQUE INDEX live_sessions_one_active ON live_sessions(webinar_id) WHERE status IN ('draft','scheduled','lobby_open','live','ending');
CREATE INDEX live_sessions_org ON live_sessions(org_id, status);
CREATE INDEX live_sessions_status ON live_sessions(status, scheduled_starts_at);
CREATE UNIQUE INDEX live_viewing_sessions_open ON live_viewing_sessions(participant_id) WHERE state='open';
CREATE INDEX live_viewing_sessions_participant ON live_viewing_sessions(participant_id, opened_at);
CREATE INDEX live_viewing_sessions_session ON live_viewing_sessions(session_id, state);
CREATE INDEX live_webhook_participant ON live_provider_webhook_events(provider, provider_participant_id);
CREATE INDEX live_webhook_session ON live_provider_webhook_events(session_id, provider, received_at);
CREATE INDEX live_webhook_status ON live_provider_webhook_events(process_status, received_at);
CREATE INDEX seat_offers_capacity ON seat_offers(workshop_id,status,expires_at);
CREATE INDEX webinar_checkout_capacity ON webinar_checkouts(workshop_id,status,expires_at);
CREATE UNIQUE INDEX webinar_erp_active_contract_unique
ON webinar_erp_contracts(org_id,webinar_id,trainer_id) WHERE status='active';
CREATE UNIQUE INDEX webinar_erp_active_evidence ON webinar_erp_credential_evidence(assessment_id,learner_account_id) WHERE revoked_at IS NULL;
CREATE INDEX webinar_erp_assessments_org ON webinar_erp_assessments(org_id,webinar_id,status);
CREATE INDEX webinar_erp_audit_org ON webinar_erp_audit(org_id,created_at);
CREATE INDEX webinar_erp_cases_assignee ON webinar_erp_cases(org_id,assignee_actor_id,status);
CREATE INDEX webinar_erp_mentorship_learner ON webinar_erp_mentorship(org_id,learner_account_id,updated_at);
CREATE INDEX webinar_erp_mentorship_mentor ON webinar_erp_mentorship(org_id,trainer_id,status);
CREATE INDEX webinar_erp_provider_links_org ON webinar_erp_provider_links(org_id, provider, provisioning_status);
CREATE INDEX webinar_erp_series_org ON webinar_erp_series(org_id,status);
CREATE UNIQUE INDEX webinar_erp_trainer_account_kind ON webinar_erp_trainers(org_id,actor_id,kind) WHERE actor_id IS NOT NULL;
CREATE INDEX webinar_erp_trainers_org ON webinar_erp_trainers(org_id,status);
CREATE INDEX webinar_erp_webinargg_org ON webinar_erp_webinargg(org_id,provisioning_status);
CREATE INDEX webinar_resources_webinar ON webinar_resources(webinar_id,published,created_at);
CREATE TRIGGER live_core_registration_capacity_insert
BEFORE INSERT ON workshop_registrations
WHEN NEW.status='confirmed' AND EXISTS(
  SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id AND
    (SELECT COUNT(*) FROM workshop_registrations r WHERE r.workshop_id=NEW.workshop_id AND r.status='confirmed')+
    (SELECT COUNT(*) FROM seat_offers s WHERE s.workshop_id=NEW.workshop_id AND s.status='pending' AND julianday(s.expires_at)>julianday('now'))>=json_extract(c.session_json,'$.capacity')
)
BEGIN
  SELECT RAISE(ABORT,'live_registration_capacity_changed');
END;
CREATE TRIGGER live_core_registration_capacity_update
BEFORE UPDATE OF status ON workshop_registrations
WHEN NEW.status='confirmed' AND OLD.status!='confirmed' AND EXISTS(
  SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id AND
    (SELECT COUNT(*) FROM workshop_registrations r WHERE r.workshop_id=NEW.workshop_id AND r.id!=NEW.id AND r.status='confirmed')+
    (SELECT COUNT(*) FROM seat_offers s WHERE s.workshop_id=NEW.workshop_id AND s.registration_id!=NEW.id AND s.status='pending' AND julianday(s.expires_at)>julianday('now'))>=json_extract(c.session_json,'$.capacity')
)
BEGIN
  SELECT RAISE(ABORT,'live_registration_capacity_changed');
END;
CREATE TRIGGER live_core_registration_limit
BEFORE INSERT ON workshop_registrations
WHEN EXISTS(SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id)
  AND NOT EXISTS(SELECT 1 FROM workshop_registrations r WHERE r.workshop_id=NEW.workshop_id AND lower(r.email)=lower(NEW.email))
  AND (SELECT COUNT(*) FROM workshop_registrations r WHERE r.workshop_id=NEW.workshop_id)>=
    (SELECT CASE WHEN json_extract(c.session_json,'$.mode')='BROADCAST' THEN 20000 ELSE 500 END
     FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id)
BEGIN
  SELECT RAISE(ABORT,'live_registration_limit_reached');
END;
CREATE TRIGGER live_core_registration_policy_insert
BEFORE INSERT ON workshop_registrations
WHEN NEW.status IN ('confirmed','waitlisted') AND EXISTS(
  SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id AND (
    json_extract(c.session_json,'$.status') NOT IN ('SCHEDULED','LOBBY_OPEN','LIVE')
    OR json_extract(c.session_json,'$.registrationEnabled')!=1
    OR julianday('now')>=julianday(json_extract(c.session_json,'$.startsAt'))+json_extract(c.session_json,'$.durationMinutes')/1440.0
    OR (json_extract(c.session_json,'$.registrationOpensAt') IS NOT NULL AND julianday('now')<julianday(json_extract(c.session_json,'$.registrationOpensAt')))
    OR (json_extract(c.session_json,'$.registrationClosesAt') IS NOT NULL AND julianday('now')>=julianday(json_extract(c.session_json,'$.registrationClosesAt')))
    OR (json_array_length(c.session_json,'$.allowedEmailDomains')>0 AND NOT EXISTS(SELECT 1 FROM json_each(c.session_json,'$.allowedEmailDomains') d WHERE lower(d.value)=lower(substr(NEW.email,instr(NEW.email,'@')+1))))
  )
)
BEGIN
  SELECT RAISE(ABORT,'live_registration_policy_changed');
END;
CREATE TRIGGER live_core_registration_policy_update
BEFORE UPDATE OF status ON workshop_registrations
WHEN NEW.status IN ('confirmed','waitlisted') AND OLD.status!=NEW.status AND EXISTS(
  SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id AND (
    json_extract(c.session_json,'$.status') NOT IN ('SCHEDULED','LOBBY_OPEN','LIVE')
    OR json_extract(c.session_json,'$.registrationEnabled')!=1
    OR julianday('now')>=julianday(json_extract(c.session_json,'$.startsAt'))+json_extract(c.session_json,'$.durationMinutes')/1440.0
    OR (json_extract(c.session_json,'$.registrationOpensAt') IS NOT NULL AND julianday('now')<julianday(json_extract(c.session_json,'$.registrationOpensAt')))
    OR (json_extract(c.session_json,'$.registrationClosesAt') IS NOT NULL AND julianday('now')>=julianday(json_extract(c.session_json,'$.registrationClosesAt')))
    OR (json_array_length(c.session_json,'$.allowedEmailDomains')>0 AND NOT EXISTS(SELECT 1 FROM json_each(c.session_json,'$.allowedEmailDomains') d WHERE lower(d.value)=lower(substr(NEW.email,instr(NEW.email,'@')+1))))
  )
)
BEGIN
  SELECT RAISE(ABORT,'live_registration_policy_changed');
END;
CREATE TRIGGER live_core_waitlist_insert
BEFORE INSERT ON workshop_registrations
WHEN NEW.status='waitlisted' AND EXISTS(
  SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id
  AND json_extract(c.session_json,'$.waitlistEnabled')=0
)
BEGIN
  SELECT RAISE(ABORT,'live_waitlist_disabled');
END;
CREATE TRIGGER live_core_waitlist_update
BEFORE UPDATE OF status ON workshop_registrations
WHEN NEW.status='waitlisted' AND OLD.status!='waitlisted' AND EXISTS(
  SELECT 1 FROM live_core_session_catalog c WHERE c.workshop_id=NEW.workshop_id
  AND json_extract(c.session_json,'$.waitlistEnabled')=0
)
BEGIN
  SELECT RAISE(ABORT,'live_waitlist_disabled');
END;
CREATE TRIGGER live_crm_registration_changed AFTER UPDATE OF status,notification_revision,workshop_datetime ON workshop_registrations
WHEN OLD.status<>NEW.status OR OLD.notification_revision<>NEW.notification_revision OR OLD.workshop_datetime<>NEW.workshop_datetime
BEGIN
 INSERT OR IGNORE INTO live_crm_source_events(event_key,org_id,session_id,registration_id,account_id,kind,metadata,created_at)
 SELECT 'revision:'||NEW.id||':'||NEW.notification_revision||':'||NEW.status||':'||NEW.workshop_datetime,l.org_id,l.session_id,NEW.id,l.learner_account_id,'registration',json_object('previousStartsAt',OLD.workshop_datetime),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM live_core_registration_links l WHERE l.registration_id=NEW.id AND l.learner_account_id IS NOT NULL;
END;
CREATE TRIGGER live_crm_registration_linked AFTER INSERT ON live_core_registration_links
WHEN NEW.learner_account_id IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO live_crm_source_events(event_key,org_id,session_id,registration_id,account_id,kind,created_at)
 VALUES('linked:'||NEW.registration_id,NEW.org_id,NEW.session_id,NEW.registration_id,NEW.learner_account_id,'registration',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER live_crm_registration_owner AFTER UPDATE OF learner_account_id ON live_core_registration_links
WHEN NEW.learner_account_id IS NOT NULL AND OLD.learner_account_id IS NULL
BEGIN
 INSERT OR IGNORE INTO live_crm_source_events(event_key,org_id,session_id,registration_id,account_id,kind,created_at)
 VALUES('linked:'||NEW.registration_id,NEW.org_id,NEW.session_id,NEW.registration_id,NEW.learner_account_id,'registration',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER webinar_erp_assignment_no_overlap BEFORE INSERT ON webinar_erp_assignments
WHEN EXISTS(SELECT 1 FROM webinar_erp_assignments a WHERE a.org_id=NEW.org_id AND a.trainer_id=NEW.trainer_id AND a.webinar_id!=NEW.webinar_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'webinar_erp_schedule_conflict'); END;
CREATE TRIGGER webinar_erp_assignment_update_no_overlap BEFORE UPDATE OF starts_at,ends_at ON webinar_erp_assignments
WHEN EXISTS(SELECT 1 FROM webinar_erp_assignments a WHERE a.org_id=NEW.org_id AND a.trainer_id=NEW.trainer_id AND a.webinar_id!=NEW.webinar_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'webinar_erp_schedule_conflict'); END;