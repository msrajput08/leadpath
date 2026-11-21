-- Separates staging provider records from live recurring payments.
-- Existing Test Mode records remain tagged 'test'; production data is not rewritten.
ALTER TABLE user_subscriptions ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'test'
 CHECK(billing_mode IN ('test','live'));
CREATE INDEX IF NOT EXISTS user_subscriptions_mode_status
 ON user_subscriptions(billing_mode,status,current_period_end);
-- The plan catalog remains unpurchasable until explicit live environment gates are enabled.

-- Atomic one-row-per-account capacity reservation BEFORE requesting a live mandate.
-- Slots are deliberately not auto-expired: uncertain provider creates require reconciliation.
CREATE TABLE IF NOT EXISTS live_billing_slots (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 plan_code TEXT NOT NULL REFERENCES subscription_plans(code),
 provider_subscription_id TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(provider_subscription_id)
);
