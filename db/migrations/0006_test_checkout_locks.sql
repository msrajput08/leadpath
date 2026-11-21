-- Test-mode creation guard; no production payments or mandates are created by this migration.
CREATE TABLE IF NOT EXISTS billing_creation_locks (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 nonce TEXT NOT NULL,
 locked_until INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_creation_locks_due ON billing_creation_locks(locked_until);
