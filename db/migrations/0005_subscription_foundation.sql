-- Additive migration. No existing monitor, run, account, history or preference is changed.
-- Drop the old globally enforced one-monitor index only after the API enforces quotas
-- atomically inside INSERT statements. Paid access is separately disabled by default.
CREATE TABLE IF NOT EXISTS subscription_plans (
 code TEXT PRIMARY KEY,
 display_name TEXT NOT NULL,
 currency TEXT NOT NULL DEFAULT 'INR' CHECK(length(currency)=3),
 price_minor_units INTEGER NOT NULL CHECK(price_minor_units >= 0),
 monitor_limit INTEGER NOT NULL CHECK(monitor_limit BETWEEN 1 AND 25),
 interval_seconds INTEGER NOT NULL CHECK(interval_seconds IN (900,3600,21600)),
 manual_runs_per_day INTEGER NOT NULL CHECK(manual_runs_per_day BETWEEN 1 AND 20),
 history_days INTEGER NOT NULL CHECK(history_days BETWEEN 1 AND 90),
 alert_level TEXT NOT NULL CHECK(alert_level IN ('existing','enhanced','advanced')),
 available_for_purchase INTEGER NOT NULL DEFAULT 0 CHECK(available_for_purchase IN (0,1))
);
-- Amounts are INR minor units (paise); commercial prices are provisional, not public offers.
INSERT OR IGNORE INTO subscription_plans
 (code,display_name,currency,price_minor_units,monitor_limit,interval_seconds,manual_runs_per_day,history_days,alert_level,available_for_purchase) VALUES
 ('free','Free','INR',0,1,21600,3,90,'existing',0),
 ('starter','Starter','INR',79900,5,3600,10,90,'existing',0),
 ('pro','Pro','INR',249900,25,900,20,90,'existing',0);
CREATE TABLE IF NOT EXISTS user_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plan_code TEXT NOT NULL REFERENCES subscription_plans(code),
 provider TEXT NOT NULL CHECK(provider IN ('razorpay')),
 provider_customer_id TEXT,
 provider_subscription_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','active','past_due','cancelled','expired')),
 current_period_start INTEGER,
 current_period_end INTEGER,
 cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
 last_event_at INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(provider,provider_subscription_id)
);
CREATE INDEX IF NOT EXISTS user_subscriptions_user ON user_subscriptions(user_id,status,current_period_end);
CREATE TABLE IF NOT EXISTS payment_events (
 provider TEXT NOT NULL,
 event_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 provider_subscription_id TEXT,
 body_sha256 TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 PRIMARY KEY(provider,event_id)
);
CREATE INDEX IF NOT EXISTS payment_events_received ON payment_events(received_at);
CREATE TABLE IF NOT EXISTS monthly_usage (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period_utc TEXT NOT NULL,
 scheduled_checks INTEGER NOT NULL DEFAULT 0,
 manual_checks INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,period_utc)
);
-- Legacy interval_seconds retains >=21600 so no table rebuild and no FK disruption.
-- The scheduling engine reads this new column instead.
ALTER TABLE monitors ADD COLUMN schedule_interval_seconds INTEGER NOT NULL DEFAULT 21600
 CHECK(schedule_interval_seconds IN (900,3600,21600));
CREATE INDEX IF NOT EXISTS monitors_user_order ON monitors(user_id,created_at,id);
DROP INDEX IF EXISTS monitors_free_one_per_user;
