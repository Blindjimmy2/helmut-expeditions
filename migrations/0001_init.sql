-- HelmutReads initial schema (D1). Mirrors the localhost SQLite tables.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  provenance_tier TEXT DEFAULT 'unknown',
  provenance_text TEXT DEFAULT '',
  provenance_verdict TEXT DEFAULT 'quarantine',
  image_blob_key TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'transcribed',
  transcription TEXT NOT NULL,
  research TEXT,
  created_at INTEGER NOT NULL,
  researched_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trusted_submitter INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_auth_challenges_email ON auth_challenges(email, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_auth_challenges_ip ON auth_challenges(ip_hash, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  run_id INTEGER,
  action TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_events(run_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_billing (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  subscription_status TEXT NOT NULL DEFAULT 'none',
  paid_until INTEGER NOT NULL DEFAULT 0,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  beta_access INTEGER NOT NULL DEFAULT 0,
  runs_used INTEGER NOT NULL DEFAULT 0,
  checkout_session_id TEXT,
  checkout_attempt TEXT,
  checkout_plan TEXT,
  checkout_started INTEGER,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS provenance_allowlist (
  pattern TEXT PRIMARY KEY
);
