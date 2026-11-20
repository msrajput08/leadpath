# LeadPath authentication — Cloudflare Workers

**New:** Premium email/password signup, login, verification and reset via **Supabase Auth + Brevo SMTP** are documented in [password-auth.md](password-auth.md). Supabase handles password hashing and email tokens; the Cloudflare Worker only creates local application sessions. Legacy email OTP is disabled by default; set ENABLE_EMAIL_OTP=true to explicitly enable it.

LeadPath supports Google, Facebook, X, GitHub, and passwordless email sign-in. Buttons appear only when their required server configuration exists. Existing GitHub users can keep signing in normally.

## Safe production rollout

1. Apply migration db/migrations/0003_email_otp.sql to D1 **before** deploying the new authentication Worker. Run npm ci and npm run db:remote in the updated project folder.
2. Confirm the D1 table exists with: npx wrangler d1 execute leadpath-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='email_login_codes';"
3. Merge/deploy the feature code only after the migration. Test existing GitHub login and Make monitoring before enabling additional provider credentials.
4. Enable providers one at a time and test actual redirect, returning sign-in and consent behavior.

Do not commit or screenshot OAuth secrets, email codes, Resend keys, or callback credentials. Put production credentials in Cloudflare Worker Secrets via npx wrangler secret put NAME.

## Google (existing code)

Create a Google OAuth 2.0 Web Application and configure the exact redirect:
https://leadpath.monty-08-raj.workers.dev/auth/google/callback

Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets. Google may require a verified custom domain and consent-screen branding verification to make the app public. Only signed Google ID tokens with valid nonce, audience, issuer and email_verified=true are accepted.

## Facebook / Meta

Create a Meta Developers app with Facebook Login, Web OAuth Login, and an authorized site domain. Configure the exact redirect:
https://leadpath.monty-08-raj.workers.dev/auth/facebook/callback

Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET as Worker secrets. The backend uses versioned Graph API v27.0, short-lived state, server-side code exchange and appsecret_proof. It requests public_profile and email. App live mode, privacy policy, data deletion info and applicable review requirements must be addressed separately. Email can be unavailable or unverified; never use it to silently link another account.

## X

Create an X Developer OAuth 2.0 Web App with authorization code + PKCE and this exact redirect:
https://leadpath.monty-08-raj.workers.dev/auth/x/callback

Set X_CLIENT_ID and X_CLIENT_SECRET as Worker secrets. The code requests tweet.read and users.read, validates state, uses S256 PKCE, and reads the user's own X profile. X developer API enrollment, profile lookup availability and usage charges must be checked before public enablement. X may not supply a confirmed email, so X-only accounts may show that their email is unavailable.

## Passwordless Email via Resend

You must own a sending domain verified in Resend. A workers.dev subdomain alone is not an owned sender domain. Configure RESEND_API_KEY, EMAIL_FROM_ADDRESS (e.g. LeadPath <login@yourdomain.com>) and EMAIL_OTP_SECRET, each as a Worker secret. Generate EMAIL_OTP_SECRET once with:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

Email OTP codes are six digits, HMAC-hashed at rest, expire after 10 minutes, permit five verification attempts, have a 60-second per-address resend cooldown and a five-request per-24h limit on top of an edge rate limiter. Expired challenges are removed by daily Cron. No email passwords are collected. Email login is hidden unless all required server-side settings are present. Check sending deliverability, mail-provider plan limits and anti-abuse usage before launch.

## Accounts do not silently merge

A provider's verified unique user ID is the account key. Email OTP signs into its own email-verified identity. Even if the Google, GitHub, Facebook or X email matches, LeadPath does not silently merge accounts. Matching email may be stale or unverified. **Use the original provider to access an existing workspace** until a separately verified, user-initiated account-linking feature ships. Facebook/X accounts without an available email show "Email unavailable from this social login" rather than displaying the internal placeholder as a real address.

Sessions use Secure HttpOnly SameSite=Lax cookies on HTTPS; OAuth states are bound to provider, browser cookie, expiration and a single-use D1 record. OAuth access tokens are not persisted. Email OTP challenges are invalid after successful verification.

## Verification

Before release, CI must pass Node tests, TypeScript, build, Vitest, browser tests and Cloudflare preview build. In production verify existing GitHub sign-in, existing monitor health, Make callback, Google login (if configured), Facebook login (if configured), X login (if API access is active), and Email OTP deliverability (if a sender domain has been verified). Test invalid state, replay, wrong code, cooldown, expired code, API errors and email delivery failures. Do not treat CI mocks as live provider approval.

References:
- https://developers.facebook.com/docs/graph-api/
- https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- https://developers.cloudflare.com/workers/tutorials/send-emails-with-resend/
