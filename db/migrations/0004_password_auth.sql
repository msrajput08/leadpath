-- Email/password identities remain separate from existing OAuth and email-OTP identities.
CREATE TABLE IF NOT EXISTS password_accounts (
 email TEXT PRIMARY KEY COLLATE NOCASE,
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 password_hash TEXT NOT NULL,
 verified_at INTEGER,
 login_failures INTEGER NOT NULL DEFAULT 0,
 locked_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_tokens (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('verify','reset')),
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS password_token_user_kind ON password_tokens(user_id,kind);
CREATE INDEX IF NOT EXISTS password_tokens_expiry ON password_tokens(expires_at);
CREATE TABLE IF NOT EXISTS password_mail_limits (
 email_hash TEXT PRIMARY KEY,
 last_sent INTEGER NOT NULL,
 window_start INTEGER NOT NULL,
 send_count INTEGER NOT NULL
);
