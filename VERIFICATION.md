# LeadPath — verification and release readiness (18 November 2026)

This document distinguishes executable code and locally tested behavior from deployment and true third-party integration. **LeadPath is a developer MVP, not a production-verified hosted SaaS.** Never represent the simulated Make / Google Sheets flow as a live external integration.

## Verification matrix

| # | Acceptance criterion | Status | Evidence / next step |
| --- | --- | --- | --- |
| 1 | Public pages load | **Source implemented; not browser-verified** | React pages exist; install dependencies and start Vite/build in a network-enabled environment. |
| 2 | Free checker genuine diagnostic results | **Implemented; not browser-verified** | Client-side JSON/HTTPS URL validation and diagnostics, no deceptive network call. |
| 3 | User can sign in | **Mocked OAuth local tests pass; live unverified** | Configure Google or GitHub OAuth app and test callback on deployment host. |
| 4 | Dashboard reads persistent data | **API logic locally tested; live unverified** | Deploy Cloudflare D1 and check authenticated dashboard. |
| 5 | User can create monitor | **Locally tested** | One-user/one-monitor constraint and encrypted Make webhook URL. |
| 6 | Manual test performs synthetic run | **Locally tested** | Intercepted fetch verified outbound test payload; real endpoint not called. |
| 7 | Real Make scenario receives payload | **Not verified** | Configure Make custom webhook and trigger one test. |
| 8 | Google Sheets receives test record | **Not verified** | Add Make "Add a Row" action and verify row in owned sheet. |
| 9 | Callback confirms matching run ID | **Locally tested, live unverified** | Callback bearer auth and matching run ID verified with local integration test. |
| 10 | Confirmed delivery recorded | **Locally tested, live unverified** | D1-equivalent SQLite test exercises confirmed database state. |
| 11 | Missing callback becomes timed out/unconfirmed | **Locally tested** | Simulated expiration; external run not tested. |
| 12 | Repeated failure creates alert | **Locally tested** | Failure streak and in-app alerts. |
| 13 | Successful run after failures records recovery | **Locally tested** | Recovery alert in integration tests. |
| 14 | Paused monitors don't run | **Locally tested** | Scheduler checks active state. |
| 15 | Cross-account isolation | **Locally tested** | Authenticated query ownership checks. |
| 16 | Scheduler runs with website closed | **Implementation only, live unverified** | Cloudflare Cron Trigger configured at 15-minute ticks. |
| 17 | Mobile dashboard works | **CSS implemented; not browser-verified** | Run responsive Playwright test on real Vite app. |
| 18 | Automated tests and production build pass | **Partially verified** | Local Node integration tests and worker TypeScript check pass. React/Vite production build, Vitest and Playwright could not execute because the npm registry is not reachable from this environment. |
| 19 | Deployed site works | **Not deployed** | Cloudflare credentials, D1 UUID, OAuth app credentials and real Make connection needed. |

## Tests run here

- `tsc --project tsconfig.worker.json --noEmit`: worker TS check succeeded.
- `tsc --project tsconfig.worker.json --noEmit false --outDir .test-build && cp worker/security.mjs .test-build/security.mjs`
- `node --experimental-sqlite --test tests/*.test.mjs`: eight local Node test cases passed, zero failures on final verification.
- Tests use simulated/fake HTTP providers and local SQLite as an approximate integration harness; they do **not** run against production Cloudflare D1, Google or Make.
- Dependencies could not be installed: package registry requests failed from this environment. `npm run build`, `npm run test:vitest`, and `npm run test:e2e` remain **not run**.

## Setup prerequisites and outstanding actions

1. Create a new GitHub repository for LeadPath and push this code (no existing LeadPath repository was available to the connected GitHub account; the connector did not expose repository creation).
2. In a network-enabled environment run `npm install`, `npm test`, `npm run test:vitest`, `npm run build`, and `npm run test:e2e` (install Playwright Chromium if needed).
3. Create a Cloudflare D1 database and replace the example ID in `wrangler.jsonc`; confirm free plan and workers.dev hostname, set `BASE_URL`, and apply migrations.
4. Configure Google OAuth for production **or** optional GitHub OAuth; set client ID and client secret as Wrangler secrets; verify callback origin and provider settings.
5. Generate a random 32-byte key; set `WEBHOOK_ENCRYPTION_KEY` as a secret, never commit it.
6. Add a Make custom webhook → Google Sheets Add Row → HTTP callback scenario with the callback token from the dashboard. Set scenario to active and verify test rows manually.
7. Deploy, open the live website, repeat the 19-point acceptance checklist, measure usage and revise monitored quota if necessary.
8. Replace preliminary privacy/terms text with reviewed policy and contact details before inviting real customers; confirm relevant privacy requirements.

## Cost estimates and assumptions

Cloudflare free Workers/D1 plus Cloudflare's free workers.dev hostname are expected to cost **₹0 at this small workload while remaining within published free limits**. One scheduled check every six hours is approximately 4/day and 120/30 days. A three-module Make scenario is approximately 360 credits/month if each execution uses 3 credits. Three permitted manual checks/day could add ~270/month, or ~630/month total if all used and each costs 3 credits. Make's 1,000 credits/month limit is **shared across the user's Make account**, and scenarios may require additional modules or credits. Neither live usage nor successful zero-cost operation has been validated in this environment. Third-party free tiers and their terms may change.

## Security/production caveats

- Permission-based test endpoints only: Make's webhook host is allowlisted; no active public URL probing.
- Callback token is shown once; store it safely in the Make scenario and rotate if compromised.
- Google production OAuth branding/verified domain may require additional manual steps; the optional GitHub sign-in is a fallback, not a verified deployed integration.
- Platform-level rate limiting is best-effort; Cloudflare free-tier edge behavior requires validation.
- This is not a 24/7 SLA service. No genuine incident-history, customer base, billing or subscription checkout exists.
- Inspect, adapt, penetration-test and deploy under a dedicated project account before accepting customer data.
