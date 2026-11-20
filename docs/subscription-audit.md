# LeadPath subscription foundation audit — 20 November 2026

Audited source: `main` at `684d9def29eb7872dd3966d2424363e6b53d501b`. Repository inventory covered all Worker modules, React routes/components/styles, four existing migrations, configuration, scripts, tests, CI and operational documentation. No production database, merchant dashboard, secret store or live customer workflow was accessed. Prior production assertions in `PRODUCTION_READINESS.md` are operator reports, not verification performed here.

## Existing architecture and findings

| Area | Observed implementation | Assessment / change |
| --- | --- | --- |
| Serving | Vite/React 19, prerendered public HTML, Cloudflare static assets; Worker runs first for `/api/*`, `/auth/*` | Preserved; `/billing` gets a noindex application shell and no-store headers. |
| API | `worker/index.ts` dispatches into auth, API and callback handlers; ownership-scoped SQL and bounded request bodies | Preserved; billing webhook has its own signature-authenticated route, user billing APIs use sessions/CSRF. |
| Authentication | Google RS256 verification + nonce/PKCE/state; GitHub/Facebook/X identity flows; Supabase Auth handles password/verification/reset; optional legacy email OTP via Resend | Existing tests preserved. No replacement identity system. Matching email addresses are not automatically linked. D1 signup trigger supplies Free subscription for every identity path. |
| Sessions | SHA-256 token hashes in D1, HttpOnly/SameSite cookies, seven-day expiry; exact configured-origin + CSRF token for API writes | Preserved. Existing production accepts the local-cookie name as a fallback; tightening that is a separate auth-hardening change. Password reset/session invalidation behavior remains covered by existing tests. |
| D1 | Users, identities, sessions, monitors, runs, acknowledgments, alerts, preferences, audit, legacy auth tables | Migration 0005 adds billing/quota structures without rebuilding user/monitor/run tables. |
| Limits | API checked one monitor, plus a UNIQUE database index; interval column CHECK >=21600; three manual runs per monitor per rolling day | Existing UNIQUE index already prevented overcreation. Replaced with atomic INSERT…SELECT count against trusted entitlement. Manual accounting now survives monitor deletion and is per account, three/day for all plans until reviewed. |
| Scheduling | Cron every 15 minutes, at most three due monitors; hardcoded six-hour next_due; lock/run insert were separate writes | New claim and run/accounting transaction; entitlement interval, overlapping-pending guard, one cron claim/slot, daily execution ceilings. |
| Recovery | No automatic retry of synthetic POSTs, timeout sweep eight/run tick; newest run controls health | Preserve no-resend safety. Sweep two expired runs/tick to keep query work bounded. A long outage drains gradually. No guarantee of exactly-once external delivery. |
| Alerts | In-app failure after second consecutive failed/unconfirmed run, recovery notice; optional Telegram best-effort send | Preserved; there are no existing email monitoring alerts, durable notification retries or enhanced/advanced alert tiers. Those remain unavailable. |
| History | Latest 50 API rows, only 10 visible, ninety-day cleanup; 365-day audit | Free API remains 50 rows; UI can now display them. Proposed paid view 500 rows, still ninety days. No retention reduction or invented extended-retention promise. |
| Cleanup | Unbounded DELETEs, only if cron runs at exactly 00:00 | Rotating indexed maintenance batches (100 rows) throughout day, resilient to missed midnight. Cleanup remains approximate; backlog must be observed. |
| Dashboard | Assumed `monitors[0]`; hardcoded one active/six hours; no billing | Multi-monitor selector and allowance-aware creation/actions; server-provided frequency; account/billing screen. Polling reduced from 15s to 60s and skipped in hidden tabs. |
| Deployment | GitHub CI; Wrangler previews explicitly lack a D1 binding/secrets | No remote migration, merge or deployment performed. External Cloudflare preview checks may run on branch pushes; such previews are not evidence of live auth/billing. |
| Testing | 20 Node tests + 2 Vitest tests, 14 Playwright tests at baseline | Baseline unit/build passed; new migration/entitlement/scheduler/payment/API tests and three real local-D1 browser tests added. See `subscription-validation.md`. |

## Material limits preventing paid launch

1. **Capacity:** 3 checks × 96 cron slots/day = 288 scheduled checks/day; 72 fully active Free monitors is a theoretical ceiling without downtime. This is not a safe sold capacity. New quotas deliberately do not raise it. Full Starter needs 120/day; full Pro needs 2,400/day.
2. **CPU / quotas:** Workers Free has 10 ms CPU per HTTP and Cron invocation. D1 has a 50-query invocation limit, 100,000 written rows/day, 5 million read rows/day and 500 MB per database. Local SQL correctness tests cannot establish production CPU compliance. Index updates and cascade deletes cost rows too. The older eight-timeout-plus-three-dispatch worst case could exceed invocation query budget.
3. **Downgrade:** Silently deleting over-limit monitors would lose data. The implementation retains every monitor, permits checks only on the oldest allowed set and makes the restriction visible. A future paid customer should be offered a choice of retained active monitors before launch.
4. **Billing:** No current merchant approval, sandbox credentials, provider price IDs, trusted checkout binding workflow, end-to-end paid checkout or portal/cancel flow. No live payments can be created by this PR. Backend lifecycle reconciliation is an integration foundation, not a certified merchant integration.
5. **Notifications:** Telegram is best-effort; enhanced/advanced failure-alert promises would be false. No premium notification promise is published or activated.
6. **Operations:** Production CPU, backlog, Make credits, mail delivery, real callbacks, merchant webhook latency and backup restoration require an isolated staging rehearsal, then explicitly approved production verification.
7. **Account deletion / legal:** D1 deletion does not delete Supabase identity (existing limitation). Linked renewable subscriptions now block account deletion to avoid orphaned ongoing charges. Operator identity, refund terms, privacy additions, merchant approval and Indian tax/export treatment must be settled before commercial launch.

## What this audit does not establish

It is a source and automated-test audit, not a penetration test, real merchant certification, live delivery guarantee or Cloudflare account billing inspection. No fixed-cost services or paid account upgrades were introduced. The free-tier cost assumption depends on the operator retaining their existing free plans.
