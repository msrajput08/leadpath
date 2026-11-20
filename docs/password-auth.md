# LeadPath email/password sign-in: Supabase Auth + Brevo SMTP

**Critical runtime fix:** Cloudflare Workers Free limits CPU to 10 ms/request and the workerd PBKDF2 implementation rejects more than 100,000 iterations. The original direct D1/password-hashing implementation passed Node tests but cannot run reliably in the free production Worker. Do not deploy commit 466132ba (PR #8) by itself.

This follow-up implementation delegates password hashing, email verification and reset tokens to Supabase Auth (free tier). The existing Cloudflare Worker still manages local D1 workspaces/sessions and all existing Google/GitHub accounts. It never stores the user's plaintext password or password hash in D1.

## Setup

1. Create a **free Supabase project** at https://supabase.com/dashboard. Use a strong database password.
2. Under **Authentication > Sign In / Providers > Email**, enable Email provider and **Confirm email**. Do not enable auto-confirm.
3. Under **Authentication > URL Configuration**, set **Site URL** to \`https://leadpath.monty-08-raj.workers.dev\` and allow this address.
4. In Brevo, create an **SMTP key** (different from the Brevo API v3 key): https://app.brevo.com/settings/keys/smtp. Your already-verified sender address remains the From address. SMTP is subject to your Brevo account's approval, sending limits, sender authentication and potential free-domain sender rewriting.
5. Under **Supabase > Authentication > Emails > SMTP Settings**, enable custom SMTP:
   - Sender email: your Brevo verified sender
   - Sender name: LeadPath
   - Host: \`smtp-relay.brevo.com\`
   - Port: \`587\`
   - Username: your Brevo **SMTP login** (displayed on Brevo's SMTP settings tab)
   - Password: your **Brevo SMTP key** (not API v3 key)
6. Under **Supabase > Authentication > Email Templates**, change the link in **Confirm signup** to:
   \`\`\`html
   <a href="https://leadpath.monty-08-raj.workers.dev/verify-email?token_hash={{ .TokenHash }}">Verify my email</a>
   \`\`\`
   Change the **Reset password** email link to:
   \`\`\`html
   <a href="https://leadpath.monty-08-raj.workers.dev/reset-password?token_hash={{ .TokenHash }}">Reset my password</a>
   \`\`\`
   Use these in the HTML message bodies; style their surrounding content as desired. Do not include the token hash in outgoing analytics, screenshots or logs. Disable click tracking that rewrites auth links. Templates can be customized with your own SMTP.
7. Under **Supabase > Project Settings > API Keys**, get the Project URL (\`https://PROJECT_REF.supabase.co\`) and the **publishable/anon key**, *not* the \`service_role\` secret. Set these on Cloudflare:
   \`\`\`powershell
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_ANON_KEY
   \`\`\`
   Never paste secrets into chat. Note: the previously configured \`BREVO_API_KEY\` is not used by Supabase SMTP; you can remove it from Workers once this integration is working.
8. Run tests (\`npm test\`, \`npm run build\`), check CI, and deploy only the corrected main branch with \`npm run deploy\`.

## Behavior / account safety

- Signup delegates password hashing and confirmation mail to Supabase Auth. No D1 workspace is created before the user's **verified login**.
- Email verification requires opening a link then pressing **Verify email**; Supabase validates the expiring single-use token hash.
- Login receives a provider-issued token only server-side, checks the provider-verified email and ID, then issues the existing LeadPath session cookie. OAuth identities remain separate even when email text matches.
- Forgot password sends the generic confirmation message regardless of account existence.
- Reset verifies Supabase's one-time recovery link and updates the password at Supabase, then invalidates existing LeadPath D1 sessions for that identity.
- Supabase Auth controls token lifetimes, password storage and recovery rate limits. LeadPath's Cloudflare edge limiter applies to the corresponding routes.

Supabase free-tier limits and Brevo SMTP quotas apply. For public scale, enable CAPTCHA/Turnstile to protect signup abuse and verify real inbox placement. See https://developers.brevo.com/docs/supabase-smtp-integration and https://supabase.com/docs/guides/auth/auth-email-templates.

The D1 migration 0004 created unused \`password_accounts\` and \`password_tokens\` tables for an approach abandoned before production. Leave those tables in place for now; deleting them blindly risks losing data if any testing was done. New passwords live in Supabase Auth, never these tables.
