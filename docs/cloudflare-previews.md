# Cloudflare Worker Previews — LeadPath

The Wrangler `preview` command requires a `previews` block when production `vars` and `ratelimits` exist. This was the cause of the failed Cloudflare Workers Builds check on 19 November 2026.

## What is configured

- `previews.vars.BASE_URL` uses `https://leadpath-preview.invalid`, an intentionally non-routable placeholder. It must never point at the actual production Worker when testing branch previews.
- `previews.ratelimits.RATE_LIMITER` uses a separate namespace ID (`910246`) from production (`910245`) so preview traffic does not consume production counters.
- **There is no preview D1 binding.** This is intentional, to prevent a branch preview from reading or modifying production users, sessions, monitors, or callbacks. Preview login and monitoring are not end-to-end functional until an isolated test D1 instance is created and bound.
- **No OAuth or webhook encryption secrets are configured for preview.** Do not copy production OAuth secrets or callback tokens to previews.

## Validation

- A successful `Workers Builds: leadpath` check on this branch means the Cloudflare preview was created. It does **not** verify login or monitoring in preview.
- The existing production `BASE_URL`, `DB`, rate limiting, OAuth credentials and scheduled Cron remain unchanged.
- Verify that the production deployment uses the latest commit and the real Make → Sheets → authenticated callback still works before claiming it has been deployed.
- For full feature previews, first provision a **separate D1 database**, apply migrations there, bind it under `previews.d1_databases`, and provision isolated staging OAuth credentials.
- Cloudflare Worker Previews do not run Cron Triggers; the warning about Cron limitations is expected and not a deployment failure.

References: https://developers.cloudflare.com/workers/previews/configuration/ and https://developers.cloudflare.com/workers/previews/resources/
