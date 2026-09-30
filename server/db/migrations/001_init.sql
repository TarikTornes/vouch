-- Vouch schema v1. All seeded content is synthetic demonstration data.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('consultant', 'expert')),
  role_title TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  country TEXT,
  owns_topics TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  owner_name TEXT,
  country TEXT NOT NULL DEFAULT 'unknown',
  client TEXT NOT NULL DEFAULT 'unknown',
  link TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'processing', 'needs_review', 'active', 'superseded', 'failed', 'rejected')),
  failure_reason TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  source_updated TEXT,
  effective_from TEXT,
  effective_to TEXT,
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  processing_started_at TEXT,
  processing_finished_at TEXT,
  llm_model TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  currency_reviewed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (document_id, version)
);
CREATE INDEX idx_versions_hash ON document_versions(content_hash);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  topic TEXT NOT NULL,
  condition TEXT NOT NULL,
  country TEXT NOT NULL,
  client TEXT NOT NULL,
  scope_source TEXT,
  value TEXT NOT NULL,
  unit TEXT,
  effective_from TEXT,
  effective_to TEXT,
  excerpt TEXT NOT NULL,
  location TEXT,
  exception_label TEXT,
  exception_agreement_ref TEXT,
  exception_documented_by TEXT,
  duplicate_of TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('llm', 'seed', 'human')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'invalid')),
  invalid_reason TEXT,
  created_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  country TEXT NOT NULL,
  client TEXT NOT NULL,
  interpretation TEXT,
  answer TEXT,
  llm_model TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  question_id TEXT REFERENCES questions(id),
  requested_by TEXT REFERENCES users(id),
  assigned_to TEXT NOT NULL REFERENCES users(id),
  topic TEXT NOT NULL,
  condition TEXT NOT NULL,
  country TEXT NOT NULL,
  client TEXT NOT NULL,
  label TEXT NOT NULL,
  question TEXT NOT NULL,
  opened_reason TEXT NOT NULL CHECK (opened_reason IN ('consultant_request', 'rereview')),
  rereview_of TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'info_requested', 'resolved', 'unresolved')),
  answer_snapshot TEXT NOT NULL,
  evidence_versions TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one open case per claim key: repeated clicks cannot create duplicates.
CREATE UNIQUE INDEX idx_cases_one_open ON cases(topic, condition, country, client) WHERE status IN ('open', 'info_requested');

CREATE TABLE case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  actor_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE resolutions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  topic TEXT NOT NULL,
  condition TEXT NOT NULL,
  country TEXT NOT NULL,
  client TEXT NOT NULL,
  value TEXT NOT NULL,
  accepted_claim_ids TEXT NOT NULL,
  outdated_claim_ids TEXT NOT NULL,
  considered TEXT NOT NULL,
  reason TEXT NOT NULL,
  supporting_version_id TEXT REFERENCES document_versions(id),
  expert_statement TEXT,
  resolved_by TEXT NOT NULL REFERENCES users(id),
  resolved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_rereview', 'superseded')),
  rereview_reason TEXT,
  CHECK (supporting_version_id IS NOT NULL OR (expert_statement IS NOT NULL AND length(trim(expert_statement)) > 0))
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  case_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'accepted', 'failed')),
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (case_id, kind)
);

CREATE TABLE email_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  attempted_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'failed')),
  http_status INTEGER,
  provider_message_id TEXT,
  error TEXT
);
