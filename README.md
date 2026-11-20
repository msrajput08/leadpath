# LeadPath

**Know whether an authorized automation reached its destination.** LeadPath monitors **Make.com webhook → Google Sheets → authenticated callback** using synthetic records.

**Current deployment:** https://leadpath.monty-08-raj.workers.dev/ (operator-reported live Cloudflare Worker). GitHub CI runs type checks, API/database tests, dependency audit, build and Playwright local browser smoke tests. The operator reports successful real Make/Sheets callback, cron, alert and recovery tests; independent live-site verification and unrestricted public-launch approval are **not claimed**. See `PRODUCTION_READINESS.md` and `VERIFICATION.md`.

**Support:** [minty.12.shar@gmail.com](mailto:minty.12.shar@gmail.com). The public UI offers a generally available Free monitor. The Starter ₹799/month Live checkout code is present but intentionally gated to a single India-only pilot; Pro is not available for purchase. Until the final billing/capacity controls are enabled, no new real-money checkout is offered.

## What's built

- React + Vite + TypeScript pre-rendered, search-friendly marketing website, three-tier transparent pricing with server-verified Starter pilot availability, free local JSON/URL diagnostic checker, responsive dashboard, authenticated navigation, light/dark theme, guides, Contact page, factual Privacy Policy and Terms disclosures (subject to operator legal review).
- Cloudflare Worker API (dependency-free native handler), D1 migrations and optional Free Cloudflare Queue dispatch for scheduled checks. Worker includes Cron monitoring, HTTPS Make webhook URL allowlist, encrypted webhook URLs at rest, 256-bit hashed callback credentials, 30-minute confirmation window, replay prevention, concurrency protection, failure/recovery tracking, in-app alerts and optional Telegram delivery.
- Google OAuth (signed ID-token verification, PKCE, nonce/state checks) and optional GitHub OAuth (authorization code + PKCE, verified email). Secure HttpOnly sessions and CSRF token.
- Free tier: one active/paused monitor, target six-hour scheduled cadence, **max three manual tests per rolling 24 hours**, and minimum 15-minute manual cooldown. A gated single-account India-only Starter pilot supports up to five monitors and target hourly checks; Pro is a proposed tier, not an active offer.
- CSV-free local database integration tests using Node's built-in SQLite and native fetch mocks. Real credentials and payments are **not** committed.

## Structure

```text
src/                 React site, free checker, dashboard
worker/              OAuth, API, monitoring engine, security helpers
db/migrations/       Cloudflare D1 schema
examples/             Synthetic payload and confirmation payload
docs/                Detailed Make → Google Sheets wiring guide
tests/               Node integration and validator tests + optional Vitest
e2e/                 Playwright browser smoke tests (executed in GitHub Actions)
public/              robots.txt and sitemap.xml for current workers.dev origin
scripts/             sitemap generator
wrangler.jsonc        Cloudflare Worker static assets + D1 + cron + rate limit
VERIFICATION.md       Verified and unverified acceptance criteria
```

## 1. Requirements

- Node.js 22+ and npm. No paid services are needed for the *target workload*, subject to free-tier restrictions and account eligibility.
- Free Cloudflare account with Workers and D1 available; no paid Workers plan or billing activation.
- Free Make.com account and a Google account with access to a test-only Google Sheet.
- At least one OAuth provider. GitHub OAuth can be a lower-friction option on a free `workers.dev` host; Google OAuth may require verified domain and OAuth branding configuration for public production use. Google OAuth testing mode may restrict eligible test users.

## 2. Install

```bash
npm ci
cp .dev.vars.example .dev.vars
```

Generate the AES-GCM secret key locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the generated **64-character hex value** to `WEBHOOK_ENCRYPTION_KEY` in `.dev.vars`. Never commit `.dev.vars`, GitHub/GCP client secrets or Make webhook URLs.

### Configure an OAuth provider

**GitHub (optional, useful if Google branding approval is unavailable):** Register a GitHub OAuth App under GitHub Settings → Developer settings → OAuth Apps. Set the homepage URL to your local/prod origin and the authorization callback to:

- Local: `http://localhost:8787/auth/github/callback`
- Production: `https://leadpath.YOUR-ACCOUNT.workers.dev/auth/github/callback`

Use separate OAuth apps/credentials for local and production if required by provider callback settings. Copy GitHub client ID and client secret into `.dev.vars` for local testing, and Worker secrets for production. Only `user:email` is requested. **No GitHub repository access** is requested by the login feature. Users need a verified email.

**Google:** In Google Cloud Console, configure an OAuth consent screen, create a Web Application OAuth client, and add the relevant exact redirect URI:

- Local: `http://localhost:8787/auth/google/callback`
- Production: `https://leadpath.YOUR-ACCOUNT.workers.dev/auth/google/callback`

Copy the client ID and client secret to `.dev.vars`. Google requires domain ownership/branding verification for production apps; **do not assume every `workers.dev` subdomain will be accepted for a publicly verified Google login**. If Google's console rejects your host or requires ownership you cannot verify, use GitHub OAuth for the MVP or obtain/verify a domain before opening Google login to everyone. Google implementation requests `openid email profile` only; there is no Sheets OAuth grant in LeadPath itself.

**Account note:** Google and GitHub sign-in currently create distinct accounts even if they share an email address. There is no automatic account linking.

## 3. Local Cloudflare D1 + Worker

```bash
npx wrangler login
npx wrangler d1 create leadpath-db
```

Copy the returned **database UUID** into `wrangler.jsonc` under `d1_databases[0].database_id`. This is a database resource identifier, **not a secret**.

```bash
npm run db:local
npm run build
npx wrangler dev --port 8787 --var BASE_URL:http://localhost:8787
```

Visit `http://localhost:8787`. The `BASE_URL` override must match the origin opened by your browser. `wrangler dev` loads secrets from `.dev.vars`; it also serves `dist/` built by Vite. For source edits, rebuild and refresh. Google and GitHub local OAuth both need exact localhost callbacks registered with their providers.

## 4. Make → Google Sheets real integration

Read [`docs/make-integration.md`](docs/make-integration.md) **before** activating a monitor. The Make scenario must have 3 modules in order:

```text
Custom Webhook (instant trigger)
    ↓
Google Sheets / Add a Row, containing run_id
    ↓ (only after Sheets succeeded)
HTTP / Make a request / POST LeadPath callback with matching run_id
Authorization: Bearer ONE_TIME_CALLBACK_SECRET
```

After creating a monitor, save the callback token shown once and paste it into the HTTP module. Its hash—not the token—is persisted. The actual Make webhook URL is encrypted using `WEBHOOK_ENCRYPTION_KEY` and is never displayed after saving it. If you lose the callback token, use Rotate Secret and update the Make module.

A successful initial POST **does not** change a run to Confirmed. Only the authenticated callback with matching run ID, within 30 minutes, does. If Make receives the webhook but fails to write the Sheet, the resulting run should expire Unconfirmed.

## 5. Deploy on a free Cloudflare Workers subdomain

**Do not enable any paid plan, billing or automatic credit purchase.** Before deployment verify that Workers Free, D1 Free and your Make organization quotas fit the workload.

1. Create a Workers subdomain in your Cloudflare account, e.g. `YOUR-ACCOUNT.workers.dev`.
2. Edit `wrangler.jsonc`:
   - Database UUID from the D1 creation step.
   - `BASE_URL` to your exact future origin, e.g. `https://leadpath.YOUR-ACCOUNT.workers.dev`.
   - Change the rate limit namespace ID if it conflicts with another Worker namespace on your account.
3. Generate the public sitemap for the exact host **before building**:

```bash
node scripts/generate-sitemap.mjs https://leadpath.monty-08-raj.workers.dev
```

4. Store credentials as Cloudflare Worker secrets (add at least one OAuth provider):

```bash
npx wrangler secret put WEBHOOK_ENCRYPTION_KEY
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
# OPTIONAL, only if Google OAuth is configured:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
# OPTIONAL, only if Telegram notifications are configured:
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

5. Apply schema and deploy:

```bash
npm run db:remote
npm run deploy
```

6. **Manually validate**, in the actual deployed environment:
   - Open all public routes, `sitemap.xml`, `robots.txt` and checker on a phone.
   - Sign in with a real OAuth provider and confirm dashboard persistence across sessions.
   - Create an authorized Make monitor; run a real test and find the same ID in the Sheet.
   - Confirm the authenticated callback changes status. Then disable callback and observe Unconfirmed after timeout.
   - Trigger two consecutive failures to inspect alerts; restore callback to inspect recovery.
   - Verify scheduled Cron checks while no browser session is open.
   - Confirm no app secrets, OAuth tokens or full webhook URLs appear in logs/responses.

**The operator reports a live Cloudflare deployment and real OAuth/Make/Sheets/callback tests.** Passing `wrangler deploy` or local CI alone does not prove that these integrations work on a newly deployed revision; smoke-test every release.

## 6. Testing

```bash
npm test               # Type-check Worker; compile it for local tests; run Node SQLite/HTTP tests
npm run test:vitest    # Supplemental Vitest validators
npm run build          # Full React TypeScript check and Vite production bundle
npm run test:e2e       # Playwright; first start the built Worker locally on :8787
```

Playwright requires browser binaries installed and an available local Worker; run `npx playwright install chromium` if necessary (may download external binary). The local SQLite adapter is not Cloudflare D1 and the HTTP/provider endpoints in those tests are mocks; that is intentional, not a substitute for a live service check.

## 7. Zero-cost planning

Publicly documented limits checked 18 November 2026:

| Service | Free tier | Targeted use |
|---|---|---|
| Cloudflare Workers | 100,000 Worker requests/day, 10 ms CPU per normal invocation | Worker APIs + cron; static assets served separately when possible |
| Cloudflare D1 | 5 million rows read/day, 100,000 rows written/day, 5 GB storage | Tenant-isolated monitor history with indexed queries |
| Make Free | 1,000 credits/month | Three-module scenario, once per six hours |
| GitHub OAuth | No paid API required for the basic login flow | Optional alternative to Google |
| Google OAuth | No paid API for authentication itself | Branding/verification requirements can block public launch |

At three one-credit Make modules: four scheduled runs/day × 3 credits × 30 days = **360 credits/month**. Three extra manual runs/day at most = **270 additional credits/month**, for an illustrative **630-credit month**. A 31-day month is **651 credits** on the same assumptions. These figures exclude all your other Make usage, retry behavior, provider-side overhead and any module-specific costs. Make free credits do not roll over.

**Illustrative infrastructure target: ₹0/month under current free-tier quotas; not a guaranteed bill or independently verified usage report.** Exceeding free-tier quotas can stop requests or monitoring; it does not mean the service is guaranteed to remain available. Google may require a verified domain for public approval, which isn't assured by owning a free `workers.dev` hostname.

## 8. Security model / caveats

- Calls can go **only to official Make regional `hook.REGION.make.com` HTTPS endpoints**; localhost, internal IPs, URL credentials, query strings, redirects and arbitrary third-party hosts are rejected.
- The browser checker does **not** actively probe arbitrary endpoints; it runs local syntax and safety checks only.
- OAuth session cookie is HttpOnly, host-only, SameSite=Lax and Secure on HTTPS; session ID is hashed in D1. State + PKCE + CSRF header protect authentication and mutation flows.
- Callback Bearer token is 256-bit random and hashed; callbacks are limited, tied to a specific monitor/run ID, and have a 30-minute deadline.
- Request and data sizes are bounded, periodic checks have a 6-hour cadence, manual checks are capped, and the native Cloudflare rate-limit binding is approximate per Cloudflare edge location.
- No stored real lead data. Synthetic addresses use the reserved `.invalid` suffix.
- No invoices, payment flow or third-party analytics script are enabled. Supabase Auth and Brevo SMTP handle email/password confirmation and reset email.
- Public privacy/terms pages now describe known product behavior, but operator identity, jurisdiction-specific obligations and professional legal review remain a release gate.
- The app is an early public-ready implementation of one workflow path, not a guarantee of 100% uptime, compliance certification or detection of every real lead failure.

## 9. Useful official documentation

- Cloudflare Worker limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare rate-limit binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Make pricing: https://www.make.com/en/pricing
- Google OAuth/branding: https://support.google.com/cloud/answer/15549049
- GitHub OAuth web flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

## License

MIT, see [`LICENSE`](LICENSE). No dependency licenses are copied or redistributed. Review actual installed dependencies and lock versions after the first successful `npm install` before production release.

## Sign-in and transactional email

Email/password accounts use hosted **Supabase Auth** for password hashing, email verification and recovery, with **Brevo SMTP** for transactional email delivery. GitHub and Google OAuth remain available when configured. Facebook, X and legacy email OTP are not enabled by default; do not publish them as available capabilities. Different sign-in providers are not automatically linked when email addresses match. See [password-auth configuration](docs/password-auth.md) and [authentication documentation](docs/authentication.md).

## Current public release gate

Do not infer production assurance from passing simulated tests. The operator must validate the deployed Worker, database backup/recovery, SMTP inbox delivery, quota/cost visibility, security monitoring, privacy identity-deletion process and final legal business identity before unrestricted general-public onboarding. See [production readiness](PRODUCTION_READINESS.md).

## SEO and crawlable public pages

`npm run build` generates 16 static HTML pages with unique titles, descriptions, canonical links, JSON-LD schema, related-guide links, `sitemap.xml`, `robots.txt` and a real 404 response. React hydrates the static markup for interactivity. Private auth and account pages are separate noindex shells. Read [SEO release and Google Search Console steps](docs/seo-release.md). **Search Console verification and indexing require separate operator actions; ranking is not guaranteed.**
