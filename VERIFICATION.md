# LeadPath verification record — 20 November 2026

This document intentionally separates **GitHub CI evidence**, **operator-reported production results**, and **unverified release work**.

## Verified in GitHub Actions

- Worker TypeScript check + Node integration tests (auth, callback, webhook authorization, scheduler, encryption, and data rules).
- Vite React production build and Vitest checks.
- Dependency audit of deployed packages with `npm audit --omit=dev --audit-level=high`.
- Cloudflare Wrangler local D1 migrations and local Worker Playwright browser routes, signup, verification, reset, checker, Contact, Privacy, Terms, Pricing and SEO rules.
- See the latest GitHub Actions workflow and matching PR SHA for actual pass/fail status.

CI simulations validate our implementation but do **not** prove Google, Supabase, Brevo, Make, Google Sheets or Cloudflare production availability.

## Operator-reported real checks (not independently reproduced here)

- Website deployed to `https://leadpath.monty-08-raj.workers.dev/`.
- Google/GitHub OAuth and email/password signup configured on Cloudflare with Supabase Auth + Brevo SMTP.
- Brevo verification messages arrive, sometimes in Spam; email verification UX now directly offers login.
- A real authorized Make → Sheets → HTTP callback delivery returned Confirmed.
- A missing callback became Unconfirmed, repeat failures alerted, delivery recovery was observed.
- Scheduled 6-hour checks and Cron history were inspected.

## Outstanding items before unrestricted public release

1. Verify deployed commit matches latest GitHub main after changes, then repeat core integration smoke tests.
2. Confirm SPF/DKIM/domain alignment for reliable verification email delivery.
3. Review the public privacy/terms against the operator's actual legal identity and jurisdiction.
4. Handle complete deletion of a **Supabase** Auth identity separately from the D1 workspace deletion.
5. Load/abuse tests and capacity guardrails for Workers Free, D1, SMTP and Make quotas.
6. D1 restore/rollback drill, live error reporting and accessible interaction audit.
7. Confirm search indexing for client-rendered content; consider pre-rendered public pages.

**Never advertise guaranteed delivery, zero lead loss, zero cost outside third-party quotas, or live results based solely on mocked test fixtures.**
