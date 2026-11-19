# LeadPath production-readiness gate

**Status: Limited live alpha; public paid launch NOT YET APPROVED.** A successful Make → Google Sheets callback is one integration test, not a full production certification.

## Hardening added
- GitHub/Google OAuth entry points and public status now use Cloudflare edge rate limiting.
- API and callback JSON payloads are streamed with strict byte ceilings (400/413/415 on client errors).
- Successful run status, acknowledgment and current monitor status commit together in an atomic D1 batch.
- Scheduled handler surfaces failures to Cloudflare Observability rather than silently reporting success.
- Static assets include a content security policy, HSTS and defensive headers.
- Dashboard counts now explicitly describe only the latest 50 runs.

## Required real-environment acceptance tests
1. Confirm deployment of the hardening commit and verify that GitHub OAuth, dashboard, Make webhook, Google Sheets write and callback still produce a matching Confirmed run.
2. Disable Make's last HTTP callback module (not the Google Sheets write) and run a new test; after 30 minutes plus next cron sweep, verify Unconfirmed and no false Healthy result.
3. Produce a second failed check and verify exactly one failure alert; restore the callback and verify a subsequent recovery alert and Healthy status.
4. Confirm an automatic run after six hours with no browser open. Compare LeadPath run_id with the Google Sheets row and check Cloudflare Cron Past Events.
5. Validate wrong Bearer secret, mismatched run_id, expired/duplicate callbacks, cross-account authorization, CSRF, export and deletion.
6. Check desktop/mobile login and dashboard usability, page CSP in browser DevTools, keyboard access, and route handling.
7. Review Workers/D1 request and storage usage plus Make credit consumption and email/Telegram delivery if configured.
8. Monitor production errors, run a database backup/restore drill, rehearse deployment rollback, and verify zero secrets appear in build logs.

## Unresolved blockers for general public release
- Publish an actual support contact and operator-specific Privacy Policy and Terms; current pages are preliminary templates and need legal review.
- Add ownership verification for Make webhook endpoints; a checkbox alone does not prove authorization and may enable credit abuse.
- Dependency lockfile is now committed and CI uses npm ci; continue dependency vulnerability audits and scheduled updates.
- CI now executes Playwright Chromium smoke tests against a local Wrangler Worker with D1 migrations. Real Cloudflare/Make and multi-user browser E2E coverage remain unverified.
- Add server-rendered/pre-rendered documentation and validate search indexing; client-only pages do not guarantee organic acquisition.
- Confirm retention cleanup on Cloudflare cron and correct alert delivery under real errors.
- Cloudflare Free rate limiting is per location, not a globally enforced anti-abuse policy or uptime SLA.
- The Cron currently processes at most three due monitors every fifteen minutes. An ideal 6-hour cadence supports roughly seventy-two active monitors before scheduling backlog, excluding failures and overhead; capacity planning is required before broad signup.
- LeadPath monitors the Make webhook onward, not the original website form or arbitrary CRM/email delivery.

## Rollout / rollback
- Keep the working production branch unchanged until GitHub Actions tests pass for the hardening PR.
- When merged, Cloudflare's GitHub integration can auto-deploy; inspect the active version and re-test core login + callback.
- If smoke tests fail, roll back Cloudflare to the previous deployment and investigate before re-releasing.
- Never put OAuth secrets, Telegram tokens, Make webhook URLs or callback credentials into source control or screenshots.

## D1 backup and recovery (operator action required)
- Cloudflare D1 Free offers a 7-day Time Travel window; it is not an infinite backup history. See Cloudflare D1 Time Travel documentation.
- Before changes involving user data, use Wrangler with your authenticated Cloudflare account:
  `mkdir backups` (first time), then `npx wrangler d1 export DB --remote --output backups/leadpath-backup.sql`
- Keep the exported SQL securely offline. It contains user profiles and monitoring records; do not commit it or share it in issue comments.
- Verify the backup file and practice restore in a disposable database. Never overwrite the production database during a drill.
