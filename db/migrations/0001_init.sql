PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, avatar_url TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_identities (
 provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(provider, provider_user_id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
 state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'google', verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS monitors (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, webhook_ciphertext TEXT NOT NULL, secret_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused')),
 health TEXT NOT NULL DEFAULT 'configuration_required' CHECK(health IN ('configuration_required','pending','healthy','degraded','failing','paused')),
 interval_seconds INTEGER NOT NULL DEFAULT 21600 CHECK(interval_seconds >= 21600),
 next_due INTEGER NOT NULL, lock_until INTEGER, last_run_id TEXT, failure_streak INTEGER NOT NULL DEFAULT 0,
 last_checked INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitors_due ON monitors(state,next_due);
CREATE INDEX IF NOT EXISTS monitors_user ON monitors(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS monitors_free_one_per_user ON monitors(user_id);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('pending','confirmed','unconfirmed','error')),
 source TEXT NOT NULL CHECK(source IN ('scheduled','manual')),
 trigger_sent_at INTEGER, trigger_accepted_at INTEGER, response_status INTEGER,
 error_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, confirmed_at INTEGER,
 duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS runs_monitor_created ON runs(monitor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS runs_pending_expiry ON runs(state,expires_at);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at);
CREATE TABLE IF NOT EXISTS acknowledgments (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('failure','recovery')),
 message TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
 UNIQUE(run_id,kind)
);
CREATE INDEX IF NOT EXISTS alerts_user_created ON alerts(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 telegram_chat_id TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action TEXT NOT NULL, target_id TEXT, occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_events(user_id,occurred_at DESC);
