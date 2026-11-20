// Indexable pages and truthful, page-specific snippets for the live LeadPath service.
export const SITE_ORIGIN='https://leadpath.monty-08-raj.workers.dev';
export type SeoPage={title:string;description:string};
export const PUBLIC_SEO:Record<string,SeoPage>={
 '/':{title:'Make Webhook & Google Sheets Monitoring | LeadPath',description:'Catch silent Make to Google Sheets workflow failures. LeadPath checks authorized webhooks, confirms destination writes and tracks missing callbacks. Start free.'},
 '/how-it-works':{title:'How Destination-Confirmed Webhook Monitoring Works | LeadPath',description:'See how synthetic webhook checks, Google Sheets rows and authenticated callbacks help distinguish accepted requests from confirmed workflow delivery.'},
 '/features':{title:'Workflow Monitoring, Run History & Failure Alerts | LeadPath',description:'Explore six-hour automated checks, callback verification, run history, failure and recovery alerts, and a browser-only JSON checker for Make workflows.'},
 '/pricing':{title:'LeadPath Pricing — Free Monitoring & Starter Pilot',description:'Monitor one Make to Google Sheets workflow free. View the limited ₹799/month India-only Starter pilot and proposed Pro features, with clear recurring billing terms.'},
 '/checker':{title:'Free Webhook JSON Payload & URL Checker | LeadPath',description:'Check JSON syntax, run_id fields and safe webhook URL formatting in your browser. No signup and no network request to your endpoint.'},
 '/docs':{title:'Make Webhook & Google Sheets Setup Guides | LeadPath',description:'Set up a Make custom webhook, Google Sheets Add a Row module and authenticated LeadPath callback. Troubleshoot silent automation failures.'},
 '/docs/webflow-make':{title:'Webflow Form Not Triggering Make? Troubleshooting Guide',description:'Find where a Webflow-to-Make form automation stops: native submissions, webhook execution, field mapping, scenario state and authorization.'},
 '/docs/make-sheets':{title:'Make Webhook Not Updating Google Sheets? Fix the Flow',description:'Diagnose why a Make webhook receives a request but Google Sheets has no new row. Check scenario logs, connections, mapping and callbacks.'},
 '/docs/crm-missing':{title:'Website Leads Not Reaching Your CRM? Trace the Failure',description:'Trace missing website leads through form submissions, automation runs, CRM permissions and validation. Learn what LeadPath can and cannot verify.'},
 '/docs/webhook-200':{title:'Webhook Returns HTTP 200 but Automation Fails — Why?',description:'An HTTP 200 response can mean a webhook accepted a request, not that Google Sheets saved it. Learn to confirm delivery with matching run IDs.'},
 '/docs/silent-failures':{title:'How to Detect Silent Automation & Lead Workflow Failures',description:'Use synthetic checks, destination acknowledgments and failure recovery tracking to detect silent Make to Google Sheets workflow problems.'},
 '/docs/free-monitoring':{title:'How to Monitor Make Automations for Free | LeadPath',description:'Build a free Make webhook monitoring setup with Google Sheets, a callback and scheduled synthetic checks. Understand quota and reliability limits.'},
 '/faq':{title:'LeadPath FAQ — Make Workflow Monitoring Answers',description:'Answers about Google Sheets confirmation, six-hour checks, free-plan limits, data security, missing callbacks and what LeadPath actually monitors.'},
 '/contact':{title:'Contact LeadPath Support | Help & Privacy Requests',description:'Get help with your LeadPath account, synthetic workflow monitoring, sign-in, deletion requests and Make to Google Sheets setup.'},
 '/privacy':{title:'Privacy Policy — LeadPath Workflow Monitoring',description:'Read how LeadPath handles accounts, encrypted Make webhook URLs, synthetic run history, Supabase sign-in data and deletion requests.'},
 '/terms':{title:'Terms of Service — LeadPath',description:'Terms for authorized synthetic webhook monitoring, free-plan limits, acceptable use, availability and third-party Make and Google accounts.'}
};
export const PRIVATE_ROUTES=['/login','/signup','/forgot-password','/reset-password','/verify-email','/resend-verification','/dashboard','/account'] as const;
export const PUBLIC_PATHS=Object.keys(PUBLIC_SEO);
export function pageSeo(path:string):SeoPage|undefined{return PUBLIC_SEO[path];}
