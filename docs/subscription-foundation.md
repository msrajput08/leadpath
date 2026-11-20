# Subscription foundation: architecture audit, rollout gates and cost model

**Reviewed:** 20 November 2026. **Status:** engineering foundation only; no active checkout or production migration.

## Audited baseline (before this branch)

- **Frontend:** React 19 + Vite single-page app with prerendered marketing routes; authenticated /dashboard and /account.
- **Backend:** Cloudflare Worker routes in `worker/index.ts`, authenticated API in `worker/api.ts`, monitoring/callback in `worker/engine.ts`.
- **Storage:** Cloudflare D1. Migrations `0001`–`0004` hold users, OAuth identities, sessions, monitors, runs, acknowledgments, alerts, preferences, audit records, password/email flows.
- **Auth:** Google, GitHub, optional Facebook/X OAuth and optional password/OTP; passwords managed by existing Supabase integration. Session cookies + CSRF and account-scoped monitor queries are already present. Authenticated APIs are per-user rate-limited; callback requests have a per-monitor limiter. These were inspected, not replaced.
- **Monitoring:** validated authorized Make webhook, ciphertext at rest, callback HMAC ownership proof, correlated run ID, confirmation window, conditional D1 run claim, telegram delivery, failure/recovery events. Cron: every 15 minutes, sweep up to 8 expired runs, dispatch **at most 3 due monitors per tick**. Baseline Free: 1 monitor, minimum 21,600-second DB constraint, 3 manual checks in rolling 24h, 15-minute manual cooldown, approximately 6-hour automatic interval. Stored run history is pruned at ~90 days.
- **UI:** baseline public pricing offers Free only; account settings include Telegram and data export/delete. Existing dashboard originally displayed a single monitor.
- **Quality:** Node/SQLite integration tests, worker TypeScript check, Vitest, Vite build, GitHub Actions CI with Wrangler local D1 migration and Chromium/Playwright smoke test. No evidence of live payment or billing tests in baseline.

### Material limitations and audit findings

1. `monitors_free_one_per_user` unique index prevented any 5/25-monitor plan. It is removed in migration `0005` **only with atomic server-side insert quota enforcement**. This avoids destructive table rebuilding.
2. Legacy `monitors.interval_seconds CHECK(interval_seconds>=21600)` cannot support a shorter persisted interval. We preserve the legacy column and use the additive `schedule_interval_seconds` column for new frequencies, avoiding dangerous foreign-key table surgery.
3. At 96 cron ticks/day × 3 checks/tick, the existing Worker can dispatch **at most 288 scheduled checks/day across all customers**. That only covers about **72 Free users** at four checks/day, before any failures, retries, background work or bursts. Even 100 Free accounts exceed theoretical baseline capacity.
4. One Starter account at 5 × 24 checks/day needs 120 scheduled executions/day; one Pro account at 25 × 96 needs 2,400/day—**more than the entire current system's 288/day ceiling**. Therefore the draft plans **must not be sold**.
5. A successful HTTP response from Make is not the same as a destination confirmation. Do not display a paid reliability promise until real Make → Google Sheets integration and callback delivery are tested under load.
6. Current retention is 90 days for everybody; enhanced/advanced alerting is **not** implemented. The plan table keeps a level field for future implementation, but paid rows are marked operationally unavailable and inherit existing alert delivery.
7. Current `/api/billing` is read-only and secured by the existing session/CSRF boundary. There is intentionally **no** public endpoint to set a plan or create a trusted payment-provider mapping.
8. Monitoring can consume a customer's own Make scenario operations, irrespective of LeadPath infrastructure cost.

## Schema and service model

Migration `db/migrations/0005_subscription_foundation.sql` creates:

| Entity | Purpose |
| --- | --- |
| `subscription_plans` | Configurable prices and plan allowances, with selling disabled |
| `user_subscriptions` | User ownership, trusted provider subscription/customer identifiers, periods, states, cancellation marker, event-order watermark |
| `payment_events` | Unique `(provider,event_id)` deduplication with payload SHA-256 and metadata; no raw card or webhook body |
| `monthly_usage` | Per-user scheduled and manual check counts by UTC month |
| `monitors.schedule_interval_seconds` | New non-destructive persisted effective interval |

Existing user rows need **no rewrite**; `getEntitlements()` returns Free by fallback. Paid entitlements require **both** `PAID_ENTITLEMENTS_ENABLED=true` **and** a linked, active, unexpired subscription stored by trusted backend processes. The frontend cannot supply this flag or modify subscriptions.

`BILLING_WEBHOOKS_ENABLED=true` and a server-side `RAZORPAY_WEBHOOK_SECRET` are separately required even to receive signed webhook events. Both flags are unset in the current Wrangler production configuration. **A verified webhook can update only a pre-existing local mapping**; a client-supplied email or notes field cannot grant access. Webhook signatures cover the exact raw body. Event IDs are deduplicated, older events ignored, and expired subscription periods grant no access.

Monitor quotas are enforced during the **single D1 INSERT** and checked again before any manual or scheduled dispatch. If a subscription lapses, monitors beyond the allowance stay stored with history and settings intact but cannot run. Additional cleanup/selection semantics need product review before launch.

### Staged commercial parameters (NOT live entitlements)

| Plan | Monthly USD (proposed) | Monitors | Target interval | Manual cap/day | History | Alerts |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Free | $0 | 1 | 6h | 3 | 90d | existing |
| Starter | $9 | 5 | 1h | 10 | 90d currently | existing currently |
| Pro | $29 | 25 | 15m | 20 | 90d currently | existing currently |

The paid check intervals and monitor counts are **data definitions, not guarantees or an enabled feature**. Higher retention and advanced alerts are future work. Scheduled checks are best-effort and may miss a tick during downtime. There is no aggressive catch-up burst that could silently exhaust Make credits.

## Payments: India-based merchant selling internationally

**Candidate A — Razorpay:** Indian merchant onboarding, domestic and eligible international recurring card subscriptions, INR settlement for international recurring charges, account-specific international enablement. Zero setup/AMC claims are associated with regular pricing, but actual subscription and cross-border card fees require a merchant quote and verification. For planning only, international payments are often cited around 3% + relevant recurring fees and 18% GST **on applicable fees**, plus FX effects; do not treat as a binding quote. Merchant retains responsibility for taxes and export documentation. See [Razorpay Subscriptions](https://razorpay.com/subscriptions/), [international recurring eligibility](https://razorpay.com/blog/international-subscriptions-india), [Razorpay pricing](https://razorpay.com/pricing/).

**Candidate B — Paddle:** Merchant of Record supporting global SaaS checkout, tax collection/remittance and subscriptions; published pay-as-you-go **5% + $0.50 per transaction**, no standard monthly fee. Account, product, merchant eligibility, payout method, country restrictions and KYC are subject to acceptance. A $9 Starter payment would incur about $0.95 in the listed headline processing fee; a $29 Pro payment about $1.95, before any country-specific payout/FX adjustments. See [Paddle pricing](https://www.paddle.com/pricing), [tax model](https://www.paddle.com/help/start/intro-to-paddle/how-paddle-is-able-to-take-on-your-vat-and-tax-responsibilities).

**Other options:** Cashfree's international recurring eligibility and applicable pricing must be confirmed for the actual merchant account. Stripe India merchant onboarding cannot be assumed available. Lemon Squeezy has announced shutdown in March 2027, so is unsuitable as a new long-term billing dependency; see [official Lemon Squeezy documentation](https://docs.lemonsqueezy.com/).

**Recommendation:** keep the provider-neutral D1 model and use the **Razorpay webhook adapter as an unactivated integration foundation** for an India-first business. Compare a live Razorpay merchant quote and cross-border approval against Paddle's Merchant-of-Record tax simplicity **before** committing to a final checkout integration. No real payments or card details are handled in this PR.

## Cost / scalability scenarios

Official Cloudflare information, reviewed November 2026:
- Workers Free: 100,000 requests/day, 10ms CPU/request/cron invocation, 50 subrequests/invocation; Workers Paid minimum **$5/month** and higher limits: [Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
- D1 Free: **5,000,000 rows read/day, 100,000 rows written/day, 5GB account storage**. Exceeding a free daily row limit causes query failures, not automatic paid scaling: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Assume **every user has one active, verified Free monitor**, no premium users, exactly four scheduled checks/day, 30-day month, and no manual usage. This is a *demand model*, **not capacity testing or a bill quote**.

| Active users | Needed checks/day | Needed checks/month | Minimum checks per 15m tick | Current 3/tick meets demand? | Fixed platform charge today | Indicative future base after explicit paid upgrade |
| ---: | ---: | ---: | ---: | --- | ---: | --- |
| 100 | 400 | 12,000 | ~5 | **No** | $0, but service backlog | Workers Paid minimum $5/mo; actual needs load test |
| 1,000 | 4,000 | 120,000 | ~42 | **No** | $0, but service backlog | $5/mo minimum + measured usage/architecture |
| 10,000 | 40,000 | 1,200,000 | ~417 | **No** | $0, but severe backlog | $5/mo minimum + likely redesign and variable costs |

Current incremental **fixed** infrastructure expense is $0/month for the untouched free deployment (assuming existing vendor free allowances). The working code is **not** able to satisfy these populations at the advertised cadence. Actual cost cannot be assigned without D1 row-metrics, CPU profiling, batch benchmarks, response volumes, retention bytes, retries, traffic, user mix, provider notification fees, and Make credit consumption. Under paid infrastructure the recurring baseline starts at the published $5/month Workers minimum; the total may be materially higher. Subscription fees are transaction-variable and only start after approved checkout.

## Verification matrix and remaining launch blockers

CI is configured to run worker typecheck, JS/SQLite integration, Vitest, frontend build/prerender, production-dependency audit, **local-only** D1 migration, and Playwright smoke tests. Interpret GitHub Actions results in this PR—not a preview deployment—as the source of test outcome. Production, provider sandbox and actual Cloudflare load are **not** covered by the local suite.

**Never run `npm run db:remote` on production until explicitly approved.** Back up D1 and test migration with an isolated database. Cloudflare Worker Previews do **not** have a preview D1 binding in the existing configuration and cannot validate authenticated workflows. See `docs/cloudflare-previews.md`.

Before accepting money:
1. Select a merchant provider after KYC, international recurring enablement, currency/settlement, fee and tax/export review. Confirm business terms, chargeback/refund handling, invoicing and lawful cancellation.
2. Add authenticated checkout intent and server-to-provider subscription creation. Persist the returned provider subscription mapping from a verified API response, never browser input. Use a sandbox and simulate success, failure, renewal, duplicate/reordered webhook, refund, chargeback, cancellation, plan changes, and provider outages.
3. Implement self-service cancellation/status reconciliation/customer portal and a periodic remote provider reconciliation task (webhooks alone may be lost).
4. Prove reliable high-volume scheduling, fair queueing, retry strategy, daily provider budgets, monitoring performance, alert feature delivery and extended-history retention. Rework cron batching/architecture before enabling the draft intervals.
5. Design owner-visible over-quota state and disable/resume semantics for plan downgrade, then validate multi-monitor UI end-to-end with a staging D1.
6. Review legal pages and privacy/export/account-deletion obligations for billing metadata and compliance retention.
7. Require passing CI, independent security review and staging smoke tests with isolated Cloudflare resources; take a production D1 backup, approve and apply migration, deploy Worker, re-run regression tests, then **separately** approve both operational and billing flags.

No paid infrastructure subscriptions, provider accounts, live secrets, production data changes, deployments, or merges are authorized by this PR.
