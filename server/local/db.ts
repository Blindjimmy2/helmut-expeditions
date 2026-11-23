// Local database: node:sqlite file (app.db by default, APP_DB_PATH for tests).
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";

export const APP_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DB_PATH = (process.env["APP_DB_PATH"] ?? "").trim() || path.join(APP_ROOT, "app.db");

export const sqlite = new DatabaseSync(DB_PATH);

sqlite.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL DEFAULT '',
  image_blob_key TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'transcribed',
  transcription TEXT NOT NULL,
  research TEXT,
  created_at INTEGER NOT NULL,
  researched_at INTEGER
)`);

sqlite.exec(`
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  content_type TEXT NOT NULL
)`);

sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);

sqlite.exec(`
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
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_auth_challenges_email ON auth_challenges(email, created_at)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_auth_challenges_ip ON auth_challenges(ip_hash, created_at)`);

sqlite.exec(`
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at)`);

sqlite.exec(`
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
)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_events(run_id)`);

sqlite.exec(`
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
)`);

sqlite.exec(`
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
)`);

{
  const runCols = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  if (!runCols.some((col) => col.name === "user_id")) {
    sqlite.exec("ALTER TABLE runs ADD COLUMN user_id TEXT");
  }
}
{
  const cols = sqlite.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  const need: [string, string][] = [
    ['provenance_tier', "ALTER TABLE runs ADD COLUMN provenance_tier TEXT DEFAULT 'unknown'"],
    ['provenance_text', "ALTER TABLE runs ADD COLUMN provenance_text TEXT DEFAULT ''"],
    ['provenance_verdict', "ALTER TABLE runs ADD COLUMN provenance_verdict TEXT DEFAULT 'quarantine'"],
    ['checklist_state', "ALTER TABLE runs ADD COLUMN checklist_state TEXT NOT NULL DEFAULT 'none'"],
    ['checklist_reason', "ALTER TABLE runs ADD COLUMN checklist_reason TEXT NOT NULL DEFAULT ''"],
    ['checklist_at', "ALTER TABLE runs ADD COLUMN checklist_at INTEGER"],
    ['checklist_by', "ALTER TABLE runs ADD COLUMN checklist_by TEXT"],
  ];
  for (const [name, sql] of need) {
    if (!cols.some((col) => col.name === name)) sqlite.exec(sql);
  }
}
{
  const ucols = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!ucols.some((col) => col.name === "trusted_submitter")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN trusted_submitter INTEGER NOT NULL DEFAULT 0");
  }
}
