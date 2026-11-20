-- Separates staging provider records from live recurring payments.
-- Existing Test Mode records remain tagged 'test'; production data is not rewritten.
ALTER TABLE user_subscriptions ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'test'
 CHECK(billing_mode IN ('test','live'));
CREATE INDEX IF NOT EXISTS user_subscriptions_mode_status
 ON user_subscriptions(billing_mode,status,current_period_end);
-- The plan catalog remains unpurchasable until explicit live environment gates are enabled.
