-- Additive account/billing data. Existing monitoring rows and history are untouched.
-- Apply with old code stopped only after a backup + rehearsal; see docs/subscriptions.md.
CREATE TABLE plans (
 id TEXT PRIMARY KEY CHECK(id IN ('free','starter','pro')),
 name TEXT NOT NULL,
 monthly_price_cents INTEGER NOT NULL CHECK(monthly_price_cents>=0),
 currency TEXT NOT NULL DEFAULT 'USD',
 monitor_limit INTEGER NOT NULL CHECK(monitor_limit BETWEEN 1 AND 25),
 interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 900 AND 21600),
 history_days INTEGER NOT NULL CHECK(history_days = 90),
 history_page_size INTEGER NOT NULL CHECK(history_page_size BETWEEN 1 AND 500),
 manual_daily_limit INTEGER NOT NULL CHECK(manual_daily_limit BETWEEN 1 AND 30),
 manual_cooldown_seconds INTEGER NOT NULL CHECK(manual_cooldown_seconds>=900),
 alert_level TEXT NOT NULL DEFAULT 'existing' CHECK(alert_level='existing'),
 proposed_alert_level TEXT NOT NULL,
 release_ready INTEGER NOT NULL DEFAULT 0 CHECK(release_ready IN (0,1))
);
INSERT INTO plans VALUES
 ('free','Free',0,'USD',1,21600,90,50,3,900,'existing','Existing',1),
 ('starter','Starter',900,'USD',5,3600,90,500,3,900,'existing','Enhanced — not available',0),
 ('pro','Pro',2900,'USD',25,900,90,500,3,900,'existing','Advanced — not available',0);
CREATE TABLE subscriptions (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 plan_id TEXT NOT NULL DEFAULT 'free' REFERENCES plans(id),
 status TEXT NOT NULL DEFAULT 'free' CHECK(status IN ('free','pending','trialing','active','past_due','paused','canceled','expired')),
 provider TEXT,
 provider_environment TEXT CHECK(provider_environment IN ('sandbox','live')),
 provider_customer_id TEXT,
 provider_subscription_id TEXT,
 provider_price_id TEXT,
 period_start INTEGER,
 period_end INTEGER,
 paid_through INTEGER,
 cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
 canceled_at INTEGER,
 provider_updated_at INTEGER NOT NULL DEFAULT 0,
 last_event_at INTEGER NOT NULL DEFAULT 0,
 last_verified_at INTEGER,
 grandfathered_monitor_limit INTEGER NOT NULL DEFAULT 1 CHECK(grandfathered_monitor_limit>=1),
 updated_at INTEGER NOT NULL,
 UNIQUE(provider,provider_environment,provider_subscription_id),
 UNIQUE(provider,provider_environment,provider_customer_id),
 CHECK(period_end IS NULL OR period_start IS NULL OR period_end>period_start)
);
INSERT INTO subscriptions(user_id,grandfathered_monitor_limit,updated_at)
 SELECT u.id,MAX(1,(SELECT COUNT(*) FROM monitors m WHERE m.user_id=u.id)),u.updated_at FROM users u;
CREATE TRIGGER subscription_on_signup AFTER INSERT ON users BEGIN
 INSERT INTO subscriptions(user_id,updated_at) VALUES(NEW.id,NEW.created_at);
END;
-- Replace the one-monitor UNIQUE index; the API performs INSERT ... SELECT with
-- the server-resolved allowance in the same statement as the count.
DROP INDEX IF EXISTS monitors_free_one_per_user;
CREATE INDEX monitors_user_order ON monitors(user_id,created_at,id);
CREATE INDEX monitors_schedulable ON monitors(next_due) WHERE state='active' AND verified_at IS NOT NULL;
CREATE TABLE billing_prices (
 provider TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('sandbox','live')),
 price_id TEXT NOT NULL,
 plan_id TEXT NOT NULL REFERENCES plans(id) CHECK(plan_id<>'free'),
 PRIMARY KEY(provider,environment,price_id)
);
-- No price IDs or merchant credentials are invented/seeded.
CREATE TABLE payment_events (
 provider TEXT NOT NULL,
 environment TEXT NOT NULL,
 event_id TEXT NOT NULL,
 event_hash TEXT NOT NULL,
 event_type TEXT NOT NULL,
 subscription_id TEXT,
 occurred_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('processing','processed','ignored','failed')),
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 1,
 received_at INTEGER NOT NULL,
 processed_at INTEGER,
 error_code TEXT,
 PRIMARY KEY(provider,environment,event_id)
);
CREATE INDEX payment_events_retry ON payment_events(status,lease_until);
CREATE TABLE usage_daily (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 day TEXT NOT NULL,
 scheduled_runs INTEGER NOT NULL DEFAULT 0,
 manual_runs INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,day)
);
-- Persist quota accounting after a monitor is deleted (prevent delete/recreate bypass).
CREATE TABLE run_usage (
 run_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 source TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX run_usage_user_time ON run_usage(user_id,source,created_at);
INSERT INTO run_usage SELECT r.id,m.user_id,r.source,r.created_at FROM runs r JOIN monitors m ON m.id=r.monitor_id WHERE r.created_at>=unixepoch()*1000-86400000;
CREATE TABLE resource_usage (
 day TEXT PRIMARY KEY,
 scheduled_runs INTEGER NOT NULL DEFAULT 0,
 manual_runs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE job_ticks (
 job TEXT PRIMARY KEY,
 tick INTEGER NOT NULL
);
CREATE INDEX audit_expiry ON audit_events(occurred_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX password_mail_expiry ON password_mail_limits(window_start);
INSERT INTO usage_daily SELECT user_id,strftime('%Y-%m-%d',created_at/1000,'unixepoch'),
 SUM(source='scheduled'),SUM(source='manual') FROM run_usage GROUP BY user_id,2;
INSERT INTO resource_usage SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch'),
 SUM(source='scheduled'),SUM(source='manual') FROM run_usage GROUP BY 1;
-- Counts and ledger commit atomically with a run, including failures and interrupted dispatches.
CREATE TRIGGER account_for_run AFTER INSERT ON runs BEGIN
 INSERT INTO run_usage SELECT NEW.id,user_id,NEW.source,NEW.created_at FROM monitors WHERE id=NEW.monitor_id;
 INSERT INTO usage_daily(user_id,day,scheduled_runs,manual_runs)
 SELECT user_id,strftime('%Y-%m-%d',NEW.created_at/1000,'unixepoch'),NEW.source='scheduled',NEW.source='manual'
 FROM monitors WHERE id=NEW.monitor_id
 ON CONFLICT(user_id,day) DO UPDATE SET scheduled_runs=scheduled_runs+excluded.scheduled_runs,manual_runs=manual_runs+excluded.manual_runs;
 INSERT INTO resource_usage(day,scheduled_runs,manual_runs)
 VALUES(strftime('%Y-%m-%d',NEW.created_at/1000,'unixepoch'),NEW.source='scheduled',NEW.source='manual')
 ON CONFLICT(day) DO UPDATE SET scheduled_runs=scheduled_runs+excluded.scheduled_runs,manual_runs=manual_runs+excluded.manual_runs;
END;

CREATE INDEX run_usage_expiry ON run_usage(created_at);
CREATE INDEX usage_daily_expiry ON usage_daily(day);
