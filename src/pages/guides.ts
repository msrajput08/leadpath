// Search-useful troubleshooting content. Do not publish confidential user data or overclaim product scope.
export type GuideInfo={title:string;summary:string;context:string;steps:string[];verification:string;limitation:string};
export const articles:Record<string,GuideInfo>={
 'webflow-make':{
  title:'Webflow form not triggering Make automation',
  summary:'Diagnose a missing Webflow-to-Make submission without confusing a successful form screen with an executed scenario.',
  context:'A visitor may see a successful Webflow form submission even when a downstream Make scenario is inactive or its mapping has changed. Begin at the original form, then inspect the Make execution history. Testing the Make custom webhook separately is useful for isolating the later automation, but does not validate the original Webflow-to-Make connection.',
  steps:[
   'Send one clearly labelled test submission through the actual published Webflow form. Record the approximate time and a non-sensitive reference ID; do not use a real customer contact.',
   'Check Webflow form submissions. If the test never appears there, investigate site publishing, form configuration, validation and spam handling before changing Make.',
   'Open the relevant Make scenario and confirm the webhook/trigger is the same integration used by the published form, the scenario is switched on and the connection is valid.',
   'Inspect Make execution history for the test time. If no execution exists, focus on the handoff or trigger; avoid assuming a downstream Google Sheets problem.',
   'If an execution exists, open each module and compare received field names, mappings, filters, routers and error handlers. A renamed field can create a silent missing value.',
   'Verify whether the next destination module ran successfully. A webhook request accepted by Make does not prove that any final action completed.',
   'If you control a Make custom webhook, test that endpoint with a synthetic run to isolate Make-to-Google-Sheets delivery, then repair the original form-to-Make handoff separately.'
  ],
  verification:'Repeat the form submission once. Find the test in Webflow, locate its corresponding Make execution and confirm the required destination change. Keep a reference ID that connects each hop; avoid copying customer PII into debugging tickets.',
  limitation:'LeadPath currently monitors only the authorized Make custom webhook to Google Sheets path. It does not independently submit a Webflow form or confirm the original Webflow trigger.'
 },
 'make-sheets':{
  title:'Make webhook not updating Google Sheets',
  summary:'Trace why a Make.com webhook accepts data but no new row appears in the expected Google Sheet.',
  context:'An accepted webhook call and a completed Google Sheets Add a Row operation are different events. A missing row can come from an inactive scenario, stale Google authorization, wrong spreadsheet or worksheet, a filter, field mapping, or an error handler that masks a failed step. Inspect Make execution details before changing a working webhook.',
  steps:[
   'Trigger one authorized synthetic webhook test and copy only its run_id. Avoid real leads or passwords in the test payload.',
   'Open Make scenario history at the test time. Confirm the first Custom Webhook module received the same run_id.',
   'Check that the route to Google Sheets was not blocked by a filter, router, scenario scheduling state or an exhausted Make credit quota.',
   'Open Google Sheets → Add a Row execution details. Check connection permissions, spreadsheet file, worksheet/tab, and any required column values.',
   'Compare webhook field mapping with actual incoming payload fields. A row may go to the wrong tab or contain empty cells when a mapping breaks.',
   'Search the test worksheet for the exact run_id, not just the newest visible row. Sorting and filters can hide successfully inserted records.',
   'Place Make HTTP → Make a request after a successful row write. Map the received run_id and, for new LeadPath monitors, the temporary proof_code from the webhook into the authenticated callback.',
   'Run the authorized LeadPath verification and confirm it changes to Confirmed only after the matching row is present and Make successfully calls back.'
  ],
  verification:'A valid result has one matching run_id in the Google Sheet and a Confirmed event in LeadPath. If the webhook responded but the callback did not arrive within the confirmation window, label the result Unconfirmed rather than saying data was delivered.',
  limitation:'LeadPath trusts a properly configured post-write Make callback. It cannot independently read your Google Sheet or prove the original website form received a real submission.'
 },
 'crm-missing':{
  title:'Website leads not reaching CRM',
  summary:'Locate the failing hop between the website form, automation middleware and CRM without guessing which component lost the lead.',
  context:'The phrase “lead missing from CRM” can describe several different failures. A submission might never reach the form backend, a Make scenario might reject or skip an event, or a CRM might reject a record because of authorization, required fields, deduplication or limits. Check each system in order and compare a non-sensitive correlation ID.',
  steps:[
   'Confirm that the original website or form backend stored the test submission. A green browser success message alone is not sufficient evidence.',
   'Check the integration trigger at the same timestamp and establish whether it received a record with the expected reference ID.',
   'Inspect every automation step for filters, conditional branches, validation errors, retries, disabled scenarios and exhausted quotas.',
   'Verify the destination CRM connection and user permissions; look for expired tokens, revoked scopes and changed API requirements.',
   'Check CRM field mappings for required fields, data types and duplicate handling. A record may have been updated or merged rather than created.',
   'Search CRM records using a stable reference rather than the name alone. Check whether a queue or import step delays visibility.',
   'For supported workflows, add an acknowledgment only after the CRM confirms the appropriate write. Keep failures visible instead of returning a misleading success status.'
  ],
  verification:'The strongest validation is a test originating at the real form, a traceable automation execution and the intended record or update visible in the CRM. Repeat after fixing the specific failed step.',
  limitation:'LeadPath does not currently verify arbitrary CRM writes. Its built-in confirmation workflow is specifically Make custom webhook → Google Sheets → authenticated callback.'
 },
 'webhook-200':{
  title:'Webhook returns 200 but automation fails',
  summary:'Understand why HTTP success at a webhook endpoint is not evidence that the final destination received the payload.',
  context:'HTTP 200 generally describes the endpoint response to an HTTP request. It may mean an automation accepted or queued an event, while later scenario steps are still pending, filtered out or failing. Distinguish transport success from business-process completion to avoid false healthy dashboards.',
  steps:[
   'Record the HTTP response status, request time and a unique synthetic run_id. Do not put tokens or private webhook addresses in shared logs.',
   'Check whether the automation actually executed; receiving 200 from the intake endpoint is only the first observation.',
   'Inspect the destination step, such as Google Sheets Add a Row. Read its own execution status and any permission or validation error.',
   'Confirm the destination changed as expected. For Google Sheets, find the row containing the same run_id.',
   'After the destination write, send a separate authenticated acknowledgment containing that run_id. Never send the acknowledgment from a parallel branch that may run first.',
   'Enforce a confirmation window. A missing or mismatched acknowledgment should result in Pending then Unconfirmed, not “delivered.”',
   'Test the negative path by preventing the callback after an otherwise accepted webhook; verify the monitoring screen does not report Confirmed.'
  ],
  verification:'A successful monitoring run should show the request was accepted AND a later independent callback acknowledged the exact run_id. Only the latter warrants the Confirmed label.',
  limitation:'A callback proves what your configured automation reports. It does not automatically audit a database transaction or arbitrary system outside the configured Make-to-Sheets path.'
 },
 'silent-failures':{
  title:'How to detect silent workflow failures',
  summary:'Use small synthetic tests and explicit destination acknowledgments to notice a workflow that appears active but stops delivering.',
  context:'A status page can look healthy even while a downstream integration is broken. Independent synthetic checks detect certain failures by running the same authorized Make workflow and waiting for confirmation from the final Google Sheets step. They complement, rather than replace, real form tests and provider logs.',
  steps:[
   'Choose a critical workflow and document what “delivery” means: for the supported LeadPath path, a row written to a dedicated Google Sheets worksheet.',
   'Use a synthetic payload with a unique run_id and clearly fake sample values. Never generate or contact real customer leads as a monitoring test.',
   'Configure Make to acknowledge the run_id only after Google Sheets reports a successful row write.',
   'Establish a bounded timeout. LeadPath uses a 30-minute confirmation window; accepted-but-unconfirmed events should not be treated as successful delivery.',
   'Run the first authorized manual verification to prove ownership of the Make webhook, including echoing its temporary proof_code from the incoming event.',
   'Allow scheduled checks approximately every six hours, subject to platform and Make free-tier quotas; leave the browser closed to confirm scheduling is server-side.',
   'Inspect failure streaks, repeated-failure alerts and recovery events. Test alert delivery and destination access after configuration changes.',
   'Investigate a missing acknowledgment using Make execution history before concluding that a real customer lead was lost.'
  ],
  verification:'The monitoring history should distinguish Confirmed, Unconfirmed and error outcomes. After an injected failure and restored callback, the app should show the subsequent verified recovery event.',
  limitation:'A synthetic check detects that this controlled path failed at a particular time. It cannot guarantee all real leads were delivered or identify every reason for a missing confirmation.'
 },
 'free-monitoring':{
  title:'Monitor lead automation without paid tools',
  summary:'Build a low-frequency synthetic monitoring workflow with LeadPath, a Make custom webhook and Google Sheets.',
  context:'LeadPath currently offers one monitor without a LeadPath subscription fee. To stay on free provider plans, design the workflow around realistic operation counts and the usage limits shown in your own Make and Cloudflare accounts. “Free” does not mean unlimited or guaranteed availability.',
  steps:[
   'Create a test-only Google Sheets worksheet with run_id, leadpath_test and other safe sample columns. Do not store actual customer details in the test sheet.',
   'Configure one Make scenario: Custom Webhook → Google Sheets Add a Row → HTTP Make a request. Connect the actual test worksheet.',
   'Create a LeadPath monitor using only your own Make custom webhook. Save the randomly generated callback Bearer secret securely; it will not be shown twice.',
   'Configure the final Make HTTP module to POST to the LeadPath callback URL with Authorization: Bearer YOUR_SECRET; map run_id and the first-time proof_code from the incoming webhook.',
   'Trigger an authorized manual test and confirm the run_id appears in the Sheet before the matching callback changes the result to Confirmed.',
   'Use the approximately six-hour automated cadence, with manual-test cooldown and daily limits. Review each provider quota before increasing usage.',
   'Budget Make operations. With three one-credit module actions and four scheduled checks daily, 30 days is about 360 Make credits; actual charges vary by module, retries and your existing scenarios.',
   'Inspect Cloudflare/D1 usage and Make credit balances, and confirm that alerts are visible when a callback fails or a check is delayed.'
  ],
  verification:'The free setup is working when a fresh scheduled check appears without an open browser, a matching row is present and an authenticated callback confirms the run. Review usage periodically to avoid quota exhaustion.',
  limitation:'Make and Cloudflare are independent providers with changing limits. If quotas are exceeded, checks can be delayed or rejected. LeadPath does not offer uptime guarantees or paid failover.'
 }
};
