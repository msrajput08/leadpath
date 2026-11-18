# Make.com → Google Sheets → LeadPath: verified callback

**A Make webhook's HTTP 200 response only records acceptance.** To prove the destination write, Make must call LeadPath only after a successful Google Sheets Add a Row module.

## Prerequisites

1. Create a free Make account and a Google Sheet with a worksheet dedicated to test records. Use these columns: `run_id`, `leadpath_test`, `record_type`, `sample_name`, `sample_email`, `triggered_at`.
2. Create a scenario in Make with these three modules **in this order**:
   - **Webhooks → Custom webhook** (instant trigger); copy the actual Make webhook URL.
   - **Google Sheets → Add a Row**; map incoming fields to those columns, especially `run_id`.
   - **HTTP → Make a request**; POST to LeadPath's callback URL after the Sheets step has succeeded.
3. Ensure the scenario's **webhook module is active** and its subsequent modules aren't bypassed by an error handler. Do not attach the confirmation module in a parallel route that can run before the row write.

## LeadPath configuration

1. Sign in with Google on LeadPath; create your one monitor using the Make webhook URL.
2. LeadPath returns a callback URL and a randomly generated **Bearer token exactly once**. Copy the token into Make. It is not stored in plaintext by LeadPath and cannot be recovered; rotate it to replace a lost token.
3. In Make HTTP module, configure:
   - Method: `POST`
   - URL: the callback URL from LeadPath, e.g. `https://YOUR-WORKER.workers.dev/api/callback/UUID`
   - Header `Content-Type: application/json`
   - Header `Authorization: Bearer YOUR_ONE_TIME_SECRET`
   - Body type: raw JSON
   - JSON body: `{"run_id":"<MAP THE run_id RECEIVED BY WEBHOOK>"}`
   - Do **not** put `YOUR_ONE_TIME_SECRET` in the request body, URL, Google Sheets cells or screenshots.
4. Make's mapping syntax differs by module; use the mapping UI to insert `run_id` from module 1 instead of typing a literal token. The callback field name must be exactly `run_id`.
5. Click Run test on the LeadPath dashboard. A successful result means:
   - LeadPath created a new run ID.
   - The Make webhook received the synthetic payload.
   - The test row is visible in your test Sheet.
   - LeadPath received an authenticated callback for that same run ID within 30 minutes.
   - The status changed to **Confirmed**.

## Deliberate failure test

Disable the third HTTP callback module (but leave Google Sheets enabled), then run another test after the 15-minute cooldown. LeadPath can record `Trigger accepted` and later `Unconfirmed` instead of pretending HTTP 200 equals delivery. To test outright failure, disable or break the Sheets step and confirm that the callback never fires.

## Make free-tier credit accounting

Make's public Free plan lists **1,000 credits/month** as of November 2026. Standard module actions usually cost a credit each; verify each module's actual credit usage in your Make execution history. For three 1-credit modules and 30 days:

| Activity | Approx. runs/month | Approx. Make credits/month |
| --- | ---: | ---: |
| Four automatic runs/day (every 6 hours) | 120 | 360 |
| Maximum three manual runs/day | 90 | 270 |
| **Maximum LeadPath workload under those assumptions** | **210** | **630** |

The cap counts only *this* three-module monitoring scenario. Credits consumed by your other Make scenarios also count. For 31 days, the corresponding estimate is 651 credits. Some Make modules may cost more; never assume exactly one credit without inspecting the Make usage report. No Make paid subscription is needed for the example, assuming all relevant features are available on your Free account.

## Important limitations

- The monitored path begins at the configured Make custom webhook. It **does not independently test the original website form**, its anti-spam rules, any CRM or an actual email inbox.
- Google Sheets confirmation relies on correctly configuring Make so its callback occurs after the successful write. LeadPath does not directly inspect the Google Sheet.
- A missing callback might indicate a Make execution failure, Google API outage, credit exhaustion, misconfiguration or an HTTP callback problem. Distinguish unconfirmed delivery from proved data loss.
- LeadPath does not send actual lead data. The payload uses `test@example.invalid` and is explicitly marked synthetic.
- Make can queue incoming webhooks; unexpected queue delays longer than the 30-minute timeout will be marked unconfirmed.
- Pausing a monitor stops new scheduled checks, not an already-sent synthetic run.
