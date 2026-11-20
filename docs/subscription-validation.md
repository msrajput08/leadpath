# Subscription validation — 20 November 2026

Baseline `684d9def29eb7872dd3966d2424363e6b53d501b`: 20 Node integration/unit tests, 2 Vitest tests and production build passed before implementation.

## Local results

- Node tests: new subscription, migration, race, scheduling and billing tests run alongside the original auth/security/monitoring regression suites. See the PR CI and final counts below.
- Vitest: 2 validator tests passed.
- TypeScript: frontend and Worker checks passed.
- Production build: Vite build and prerender passed; 16 public pages, 9 private shells including `/billing`.
- D1: all five migrations applied successfully to a disposable local Wrangler D1; populated SQLite migration test compares monitor/run/settings records and checks foreign keys. New signup-trigger behavior runs in auth regression tests.
- Worker packaging: `wrangler deploy --dry-run` passed. This does not deploy or prove deployed runtime capacity.
- Production dependency audit: zero vulnerabilities reported by `npm audit --omit=dev --audit-level=high` at validation time; development tooling is not covered by that command.
- End-to-end local attempt: 17 tests could not run successfully here. Chromium launch fails with `socket() failed: Operation not permitted`; local Wrangler dev fails with `uv_interface_addresses ... error 1`. Playwright browser download also received HTTP 403. These are environment failures, not passing browser results. Existing CI installs Chromium and runs against local Wrangler; its result is reported in the PR.

No live merchant calls, actual KYC, live payments, refunds, production migrations/deployments, real Make callbacks or emails were performed. Provider API/network responses in Node tests are deliberately simulated. Do not treat those tests as provider certification or CPU/load testing.

## Added automated coverage

| Area | Checks |
| --- | --- |
| Migration | Populated pre-0005 database preserved; Free backfill; signup provisioning; foreign keys; recent quota backfill |
| Entitlements | Free defaults, 1/5/25 limits, separate paid gates, approved environment, missing binding, unpaid/future/expired periods, lifecycle states, six-hour safety floor |
| API security | Anonymous billing, CSRF/origin, forged frontend upgrade fields, ownership isolation regressions, unavailable checkout/portal/cancel, account-delete guard |
| Monitoring | Concurrent claims, transactional rollback, pending overlap prevention, plan cadence, expiry cadence, downgrade preservation, delete/recreate quota bypass, global budget and duplicate cron slots |
| Resources | Configuration ceilings, per-tick bounds and conservative D1 query count; no network retries on duplicate cron |
| Billing | Raw signature/tamper/age/size checks, read-after-webhook server verification, mapped price, completed payment, duplicate/replayed transport metadata, event conflict, delayed snapshot, cancellation, renewal, expiry, refund/dispute, unknown mapping, failures, lease recovery, atomic receipt completion and attempt ceiling |
| Browser | Existing 14 regression tests; 3 added tests use seeded **local** D1 sessions and real billing APIs (not billing route mocks), check disabled controls, mobile width, account navigation, Free creation and noindex |

The browser fixture only seeds `.wrangler`'s local test database and deletes its test user afterward. It must never be pointed at production. CI saves a mobile billing screenshot/test evidence for seven days.

## Remaining validation gates

Actual provider sandbox contract/latency and lifecycle tests, visual inspection of browser screenshots, Cloudflare 10-ms CPU measurements, D1 row/storage load measurements, realistic failure/timeout/backlog tests, backup restore drill, live Make/Sheets and authentication/mail delivery checks. They require isolated credentials/environment or deployment approval; premium remains disabled meanwhile.
