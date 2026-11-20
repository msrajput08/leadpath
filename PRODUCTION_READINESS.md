# LeadPath — public production release gate (20 November 2026)

**Current:** The code is deployed on the operator-reported Cloudflare workers.dev origin and the operator reports successful Make → Google Sheets callback, failure, recovery, and scheduled Cron tests. These live assertions were supplied by the operator, not independently reproduced in CI. GitHub Actions verifies TypeScript, Node API/D1 integration tests, dependency audit, Vite build, local database migrations, and Playwright browser smoke tests.

## Completed in repository

- Support email `minty.12.shar@gmail.com` on public Contact page and footer.
- Privacy/Terms describe actual account data, D1, Supabase Auth, Brevo SMTP, OAuth, Make synthetic events, known deletion boundaries, 90-day run retention and 365-day audit retention. **Professional legal review and operator identity are still required before unrestricted commercial rollout.**
- Pricing lists **only the available Free plan**, no invented paid plan values or unused checkout.
- Public routes have canonical descriptions; private/auth routes opt out of indexing.
- Authentication, email verification and recovery, callback authorization, CSRF, encryption, rate limiting and migration checks are tested with simulated providers and local Worker browser sessions.
- Site uses only synthetic test records (no real customer submissions).
- GitHub CI stays the merge gate and runs actual browser tests. Preserve test fixtures; they are NOT mock marketing claims.

## Actual launch checks still requiring operator or independent live verification

1. Confirm the exact deployed commit in Cloudflare and conduct a fresh real email/signup/login/reset/OAuth smoke test.
2. Verify a real Make webhook → Sheets row → matching callback, a missing callback timeout, recovery alert and Cron run after the browser closes on the **new release**.
3. Test account export and deletion, including the fact **Supabase Auth identities are not removed by deleting the LeadPath D1 account**. Put an operational support process in place for Supabase identity deletion or implement secure provider-admin cleanup before broadly inviting users.
4. Check SPF/DKIM and domain alignment for Brevo sender. Mail arriving in Spam is a deliverability issue, not solved by an on-screen notice.
5. Verify free-tier Workers CPU/D1 quotas, Make credits, outbound email limits and scheduled Cron throughput under expected concurrent load. Current scheduler handles a limited batch per tick; avoid unlimited acquisition before capacity controls are tested.
6. Validate mobile/browser accessibility, real Cloudflare response headers, security logs and alert delivery on the deployed version.
7. Export a D1 backup (and perform a restore drill in a separate disposable database), rehearse rollback, confirm that build and logs disclose no secrets.
8. Review Terms/Privacy for the legally responsible operator, applicable jurisdiction, data-rights obligations and required business notices. Do not fabricate a legal entity or governing jurisdiction.
9. Public pages are now prerendered at build time with metadata, canonical and JSON-LD. Submit the sitemap to Google Search Console and independently verify live crawling, indexing, redirects and Core Web Vitals; these external results are not established by CI.

## Known product limits

- One active or paused Make → Google Sheets monitor per LeadPath account; not a full website-form-to-CRM trace.
- Six-hour check interval is a target; the runtime and third-party quotas can delay runs.
- Confirmation relies on configuring the authenticated HTTP callback **after** the Google Sheets write.
- No paid billing, advertised SLA or guarantee that every lost lead will be detected.
- Cloudflare's free Workers rate limiting is per edge location and does not replace layered abuse defenses.

## Release/rollback

1. Inspect GitHub PR CI; never deploy failing source.
2. Operator runs `git switch main`, `git pull --ff-only`, `npm run deploy` only after merge.
3. Observe the deployed Cloudflare version ID; re-run private auth and Make callbacks.
4. Roll back in Cloudflare if production smoke tests fail.
5. Keep secrets exclusively in Cloudflare and Supabase/Brevo dashboards; never paste into chat, screenshots or repository.

## D1 backup

```powershell
npx wrangler d1 export leadpath-db --remote --output="$HOME\leadpath-d1-backup.sql"
```

Backups contain user and monitoring metadata. Keep securely offline and never commit them. D1 Time Travel and restore capabilities depend on the Cloudflare plan; do not assume unlimited retention.
