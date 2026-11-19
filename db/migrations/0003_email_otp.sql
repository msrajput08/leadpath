-- Authentication by passwordless email one-time code (never stores the raw code).
-- Do not roll out this feature before this additive migration is applied remotely.
CREATE TABLE IF NOT EXISTS email_login_codes (
 email TEXT PRIMARY KEY,
 code_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 sent_at INTEGER NOT NULL,
 daily_window INTEGER NOT NULL,
 daily_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS email_login_expired ON email_login_codes(expires_at);
