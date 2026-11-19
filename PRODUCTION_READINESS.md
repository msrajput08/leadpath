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
- Run browser E2E tests in a CI environment; existing Node tests use mocks and local SQLite, not live Cloudflare D1.
- Add server-rendered/pre-rendered documentation and validate search indexing; client-only pages do not guarantee organic acquisition.
- Confirm retention cleanup on Cloudflare cron and correct alert delivery under real errors.
- Cloudflare Free rate limiting is per location, not a globally enforced anti-abuse policy or uptime SLA.
- LeadPath monitors the Make webhook onward, not the original website form or arbitrary CRM/email delivery.

## Rollout / rollback
- Keep the working production branch unchanged until GitHub Actions tests pass for the hardening PR.
- When merged, Cloudflare's GitHub integration can auto-deploy; inspect the active version and re-test core login + callback.
- If smoke tests fail, roll back Cloudflare to the previous deployment and investigate before re-releasing.
- Never put OAuth secrets, Telegram tokens, Make webhook URLs or callback credentials into source control or screenshots.
