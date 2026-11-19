# LeadPath email/password + Brevo setup

This feature is in an isolated pull request. **Never deploy its Worker before migration 0004 is applied to the production D1 database.** Existing Google and GitHub accounts and sessions remain independent.

## 1. Create a Brevo sender and API key

Create a Brevo account at https://www.brevo.com/. Create/verify a sending address under Senders, Domains & Dedicated IPs. Create an API v3 key from SMTP & API settings. A sender email must be registered/verified and permitted for transactional sending.

Brevo may rewrite free-domain senders (including Gmail) using its compliant sender domain. Deliverability is not guaranteed; domain authentication is strongly recommended before public launch. The free sending quota, account approval and transactional limits may change. This integration uses HTTPS POST to \`https://api.brevo.com/v3/smtp/email\` with the \`api-key\` header, **not** a raw SMTP socket or SMTP key.

## 2. Apply the migration first

In your local LeadPath checkout, pull the branch containing this migration:

\`\`\`powershell
git fetch origin
git switch feat/premium-password-auth-brevo
npm ci
npm run db:remote
\`\`\`

Confirm migration 0004 is applied before merging or deploying the feature. Do not run the migration against a production DB until you have reviewed it and have a backup. The migration adds password_accounts, password_tokens and password_mail_limits; existing tables/rows are not rewritten.

## 3. Configure Cloudflare Worker Secrets

Run these commands one at a time and paste the **values** at Wrangler's prompts:

\`\`\`powershell
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_SENDER_EMAIL
npx wrangler secret put BREVO_SENDER_NAME
\`\`\`

- BREVO_API_KEY = the Brevo **API v3 key** (not an SMTP relay password).
- BREVO_SENDER_EMAIL = exact sender email registered and verified in Brevo.
- BREVO_SENDER_NAME = LeadPath (optional).

Secrets are server-side only; do not commit them. If the sending credentials are missing, the public interface will show that password signup is not configured. The old email OTP form is **disabled by default**. To temporarily restore the legacy OTP endpoints, explicitly configure \`ENABLE_EMAIL_OTP=true\` as a Worker secret. This does not link OTP and password identities.

Cloudflare Workers Free and D1 quotas still apply; password hashing uses WebCrypto PBKDF2-HMAC-SHA256 with 600,000 iterations, a new 16-byte salt per password and a 256-bit derived key. Benchmark production CPU behavior before opening public signup.

## 4. Authentication flow

- \`/signup\`: name, email, password, confirmation. Signup creates an **unverified** password account and sends a 24-hour single-use verification link.
- \`/verify-email?token=...\`: click Verify. No authenticated session is created by clicking an emailed link; the user must sign in.
- \`/login\`: verified email/password accounts only; secure HttpOnly cookie, SameSite Lax. Repeated incorrect passwords cause a temporary lockout.
- \`/forgot-password\`: generic success response regardless of whether the account exists.
- \`/reset-password?token=...\`: single-use 30-minute reset link; all existing sessions for the password-account user are revoked.
- \`/resend-verification\`: a new verification link, subject to per-address send limits.

Per-address email delivery is limited to no more than one send per 60 seconds and five per 24 hours, in addition to edge IP limits. This protects Brevo free-tier quota but can delay urgent retries. A sender outage leaves unverified registration data in D1; resend can be used later. Authentication cannot be considered live until actual emails arrive and both flows are confirmed end to end.

Password identities and Google/GitHub/legacy-OTP identities intentionally do **not** merge on matching email. A person signing up with email/password alongside an existing Google account gets a separate workspace. User-driven verified account linking is a future feature.

## 5. Tests and launch checklist

Run \`npm test\`, \`npm run build\`, \`npm run test:vitest\`, \`npm run db:local\`, \`npm run test:e2e\` and CI. With the sender verified, test signup, verification, login, resend cooldown, reset, password change, session revocation and existing Google/GitHub sign-in.

Do not merge or publicly enable registration before applying the migration, verifying the sender, completing integration checks and confirming mail delivery to an external recipient. A verified Brevo sender is an operational prerequisite, not a guarantee of inbox placement.
