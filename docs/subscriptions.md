# Subscription foundation and release runbook

This branch is safe to review with **billing off**. It is not approval to merge, apply a remote migration, deploy, collect payments, enable premium features or purchase infrastructure. Start with [audit](subscription-audit.md), [provider comparison](billing-providers.md), [cost model](subscription-costs.md) and [validation](subscription-validation.md).

## Plan model

Internal proposals, not approved public offers:

| Plan | Proposed monthly USD price | Monitor limit | Proposed interval | Delivered history / alerts |
| --- | ---: | ---: | --- | --- |
| Free | 0 | 1 | ~6h | Existing 90-day retention, latest 50 runs; in-app + optional Telegram |
| Starter | 9 | 5 | ~1h | Proposed 500-row view, same 90-day retention; enhanced alerts unavailable |
| Pro | 29 | 25 | ~15m | Proposed 500-row view, same 90-day retention; advanced alerts unavailable |

`plans` is the central trusted catalogue, with bounded typed columns. Paid `release_ready=0`. No public write API edits plans or subscriptions. Manual tests remain three/account/rolling 24h, with fifteen-minute cooldown, on every tier until separately reviewed. Premium frequencies are a target, not an SLA; a pending destination confirmation blocks another check until completion/expiry (30-minute window).

`worker/entitlements.ts` resolves access on every privileged request/run. Paid access requires ALL of: global entitlement flag, approved environment, release-ready plan, trusted provider/customer/subscription/price IDs, an API-verified record, active provider state, a started and unexpired billing period and unexpired verified paid-through timestamp. No trial or unpaid grace grants premium. Scheduled cancellation remains active until the paid period ends; immediate cancellation, pause and past-due revert to Free. Expiry is evaluated at request time without waiting for a webhook/cron. Provider state remains stored for reconciliation; UI derives expired status when applicable.

The global minimum interval defaults to 21,600 seconds, even when a paid plan is enabled in a test environment. This is the safe alternative; faster paid scheduling requires changing the floor after capacity validation. Existing `monitors.interval_seconds` retains its original >=21600 CHECK for backward compatibility. It is **legacy data**, not authority: API responses and dispatch calculate the effective interval from entitlements. Do not lower that legacy column directly.

## Migration 0005

Adds `plans`, `subscriptions`, `billing_prices`, `payment_events`, `usage_daily`, `run_usage`, `resource_usage`, `job_ticks` and maintenance indexes. Existing users receive Free records; a user-insert trigger covers future OAuth/password/OTP users. Existing monitor count is grandfathered (normally one). No monitors, history, secrets or preferences are deleted or rewritten.

The old one-monitor UNIQUE index is removed. Monitor creation enforces `COUNT < server allowance` in the same SQL statement as the insert. A run's monitor claim and insertion are one D1 batch transaction. An AFTER INSERT trigger records the run ledger, daily user totals and global totals atomically. The recent 24 hours of existing runs are backfilled to preserve manual quotas; no fictional historical usage is reported. `run_usage` has no monitor FK, so deleting/recreating a monitor cannot reset its manual quota. Account deletion cascades that ledger; global resource counters survive it.

Apply **only locally** for review:

```sh
npm ci --no-audit --no-fund
npm run db:local
npm test
npm run test:vitest
npm run build
npx wrangler dev --port 8787
# in another terminal
npm run test:e2e
```

Production migration/deployment requires explicit approval. Before approval: export a backup securely, restore into a separate test D1, apply 0005, compare user/monitor/run/settings row contents, run `PRAGMA foreign_key_check`, measure migration read/write cost and verify migration bookkeeping. Pause cron/deployment overlap during the approved maintenance window. Deploy application only after migration succeeds; do not run new code against old schema. Never upload a production backup to GitHub.

Rollback before paid activation: switch back to the previously deployed Worker version and leave additive tables/indexes/triggers in place. Old code still enforces one monitor in its API, but its removed database UNIQUE guard is no longer present. Keep writes paused while restoring that index after first verifying there are no duplicates. **Do not recreate the index or delete extra monitors after paid multi-monitor use.** A later paid rollback needs a forward fix or reviewed maintenance migration; restoring old code is not a universal rollback plan. No down migration drops customer data.

## Execution controls

| Variable | Default | Allowed ceiling / behavior |
| --- | --- | --- |
| `BILLING_MODE` | `disabled` | `sandbox`, or `live` with separate approval gate |
| `BILLING_WEBHOOKS_ENABLED` | `false` | Enables ingestion only, not checkout |
| `BILLING_LIVE_APPROVED` | `false` | Required to read live provider API and grant live paid access |
| `PAID_ENTITLEMENTS_ENABLED` | `false` | Also requires per-plan `release_ready=1` |
| `MONITOR_MIN_INTERVAL_SECONDS` | `21600` | Clamped 900–21600; invalid value falls back safely |
| `SCHEDULER_BATCH_SIZE` | `3` | 1–3; larger values do not bypass ceiling |
| `SCHEDULED_CHECKS_PER_DAY` | `288` | 0–288, UTC; counts persistent attempts, not successful callbacks |
| `MANUAL_CHECKS_PER_DAY` | `1000` | 0–1000 across entire app, UTC |

A persistent cron-slot claim prevents duplicate invocations from multiplying a batch. Run guards check state, ownership verification, due time, effective interval, pending confirmations, lock, monitor allowance, rolling manual usage and daily global budget. Atomic D1 transactions serialize races. Downtime causes one new attempt when serviced, never a catch-up burst. An ambiguous/failed POST is not automatically retried because Make may already have accepted it. Transport retries could duplicate synthetic rows/consume credits. A process crash after insertion leaves a pending run to time out; next valid schedule sends a new run ID. No external exactly-once delivery is claimed.

Timeout sweep processes two oldest expired runs per tick; maintenance deletes at most 100 parent rows from one rotating table. Cascade/index work can exceed 100 physical writes. Run/usage/audit cleanup limits need tuning before large scale. Saturation delays checks without creating chargeable services. Inspect backlog (`next_due` lag), pending expiry lag, `resource_usage`, D1 `meta.rows_read/rows_written`, Cloudflare CPU errors and account-wide quotas. Authentication/callback/public abuse can still consume quotas; per-IP/user edge rate limiting is not a complete account-wide spending cap.

## Billing boundary

`BillingProvider` returns only normalized verified state. Paddle uses Workers Web Crypto HMAC-SHA256 over the exact timestamp + raw UTF-8 body. Ingestion caps bodies at 64 KiB, verifies a 5-minute timestamp tolerance (deliberately wider than Paddle SDK's default 5 seconds), limits signature rotation candidates and rejects invalid signatures before D1 writes. Replayed valid IDs are deduplicated by provider + environment + event ID; reused IDs with changed normalized event identity return 409 (notification IDs may change during legitimate provider replay).

Each event has a 30-second processing lease, unique lease token and max eight attempts. Worker reads current subscription and completed transactions directly from a fixed HTTPS provider host using a secret API key; it verifies customer/subscription identity, a mapped monthly price, single item quantity one, current period and positive completed payment. Current-payment refunds/credits/chargebacks/warnings suspend paid-through access pending policy review, including partial refunds. This conservative policy is NOT approved customer terms. It does not implement automatic refund requests, proration, chargeback-reversal restoration, multi-item invoices or trials.

Receipt completion and subscription changes commit together. Provider `updated_at` plus event occurrence order prevent old events overwriting new snapshots. Failures return non-2xx for provider retries; interrupted leases can be reclaimed. Synchronous processing may exceed Paddle's five-second response target under adverse latency, so sandbox timing and a durable ingestion/reconciliation worker are **launch blockers** if that occurs. No early 2xx hides unfinished work. After eight attempts, inspect/reconcile and replay using provider tools; no payloads or customer PII are stored for ad-hoc local replay.

Existing bindings are required. Unknown subscriptions fail and retry; neither email nor webhook custom data can create or change ownership. `billing_prices` is empty until a reviewed merchant sandbox setup. Checkout, portal and cancellation endpoints deliberately return 503 even if flags are enabled; there is no JS checkout integration and no API that creates a charge. The adapter is a read/verification implementation, with webhook lifecycle handling, not an unfinished live purchase path exposed to customers.

`PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET` belong in Cloudflare secrets (separate sandbox and live keys). Never use `VITE_*`, committed vars or source code for them. Test local copies belong in ignored `.dev.vars`. Grant only subscription/transaction/adjustment read permissions for this foundation. No card details are requested, stored, returned or logged. Payment receipts retain only IDs, hashes, timestamps, states and safe error codes; define financial retention/deletion policy before launch. They are deliberately not periodically purged yet to preserve deduplication.

## Exact remaining steps before accepting money

1. Approve final commercial scope/prices and define meaningful enhanced/advanced alerts. Implement and validate those before `release_ready=1`, or revise the proposed tiers. Do not promise unsupported frequencies/history.
2. Complete merchant onboarding, domain/product review, identity/business verification, payout setup and explicit confirmation of India eligibility. Obtain sandbox credentials and price IDs; no live keys needed for development.
3. Implement authenticated server-created checkout intents/customer-subscription binding, provider checkout idempotency and recovery for a successful provider creation with a failed local write. Create/persist the customer binding before sending the browser to checkout. Never grant access on a checkout return page.
4. Implement and test authenticated provider portal and cancellation calls (end-of-period and immediate), reauthentication if appropriate, renewal notifications, invoices, refunds and disputes. Reconcile missed webhooks periodically within a separate measured budget. Current UI controls stay disabled until this is complete.
5. Exercise real sandbox signup/payment, SCA, failed payment, renewal, delayed/duplicate/reordered events, refunds, cancellation, secret rotation and timeout/lease recovery. Check webhook signature byte handling and response latency on Cloudflare. Validate normalization against real provider fixtures.
6. Load-test actual D1/Worker CPU, row amplification, callbacks, maintenance and backlog. Establish admission limits/headroom. Faster cron/fan-out, sharding and/or paid Workers require a separate engineering change and explicit spending approval; the current hard ceilings intentionally prevent full proposed paid capacity.
7. Verify real Make → Sheets → callback, timeout/failure/recovery and optional Telegram on isolated staging. Confirm customer Make credit implications. Verify Supabase/Brevo limits and sender delivery.
8. Finalize operator details, tax/export/invoice treatment with an India-qualified adviser, privacy updates, refund/cancellation terms, support and provider-data deletion handling. Merchant of record does not eliminate founder income-tax/export-record obligations.
9. Review green CI and security findings; backup/restore and rollout/rollback drill. Obtain explicit merge and production deployment approval, apply migration, deploy with all gates still off, then verify Free regression in production.
10. Obtain separate explicit payment-launch approval. Set correct live secrets/price mappings and approved entitlements/capacity; enable customer checkout only in a reviewed release after steps 1–9. Observe first live transactions and reconciliations under strict admission limits.
