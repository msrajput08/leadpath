import type { Env, Monitor, Session } from './types.js';
import { json, fail, getSession, mustBeSameOrigin, csrfOk, readSmallJson, publicMonitor, audit, now } from './util.js';
import { newRandomString, sha256, encryptSecret, validateMakeWebhook } from './security.mjs';
import { runMonitor } from './engine.js';
import { emailLoginConfigured } from './email-auth.js';
import { passwordAuthConfigured } from './password-auth.js';
import { getEntitlements, billingOverview } from './entitlements.js';
import { sandboxCreateSubscription,sandboxCancelSubscription,sandboxVerifyCheckout } from './razorpay-test.js';
import {createLiveSubscription,cancelLiveSubscription,confirmLiveCheckout,syncLiveSubscription,resumeLiveCheckout,liveCheckoutReady,pilotCanEnroll} from './razorpay-live.js';

type Context = { waitUntil(promise: Promise<unknown>): void };
const isId=(value:string)=>/^[0-9a-f-]{36}$/.test(value);

async function owned(env:Env, userId:string, id:string) {
 if (!isId(id)) return null;
 return env.DB.prepare('SELECT * FROM monitors WHERE id=? AND user_id=?').bind(id,userId).first<Monitor>();
}
async function accountExport(env:Env, userId:string) {
 const [account,monitors,runs,alerts,preferences,auditEvents]=await Promise.all([
  env.DB.prepare('SELECT id,email,name,created_at FROM users WHERE id=?').bind(userId).first(),
  env.DB.prepare('SELECT id,name,state,health,interval_seconds,next_due,created_at FROM monitors WHERE user_id=?').bind(userId).all(),
  env.DB.prepare('SELECT r.* FROM runs r JOIN monitors m ON m.id=r.monitor_id WHERE m.user_id=? ORDER BY r.created_at DESC LIMIT 500').bind(userId).all(),
  env.DB.prepare('SELECT id,monitor_id,kind,message,created_at FROM alerts WHERE user_id=? ORDER BY created_at DESC LIMIT 500').bind(userId).all(),
  env.DB.prepare('SELECT telegram_chat_id FROM preferences WHERE user_id=?').bind(userId).first(),
  env.DB.prepare('SELECT action,target_id,occurred_at FROM audit_events WHERE user_id=? ORDER BY occurred_at DESC LIMIT 500').bind(userId).all()
 ]);
 return { exported_at: new Date().toISOString(), account, monitors:monitors.results, runs:runs.results, alerts:alerts.results, preferences, audit_events:auditEvents.results,
  note:'Encrypted webhook URLs, session tokens, authorization secrets and callback credentials are intentionally excluded.' };
}
export async function handleApi(req:Request,env:Env,ctx:Context):Promise<Response> {
 const pathname=new URL(req.url).pathname;
 if (pathname==='/api/public/status' && req.method==='GET') {
  // Read-only diagnostics: credentials configured does not imply a usable DB binding.
  const db_binding_configured=!!env.DB && typeof env.DB.prepare==='function';
  let db_schema_ready=false;
  if (db_binding_configured) {
    try {
      await env.DB.prepare('SELECT state_hash,provider,verifier,nonce,expires_at FROM oauth_states LIMIT 1').all();
      db_schema_ready=true;
    } catch {
      // Do not expose SQL errors, provider credentials or database details publicly.
    }
  }
  return json({online:true,google_auth_configured:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),github_auth_configured:!!(env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET),facebook_auth_configured:!!(env.FACEBOOK_APP_ID&&env.FACEBOOK_APP_SECRET),x_auth_configured:!!(env.X_CLIENT_ID&&env.X_CLIENT_SECRET),email_auth_configured:emailLoginConfigured(env),password_auth_configured:passwordAuthConfigured(env),db_binding_configured,db_schema_ready,version:'0.1.0'});
 }
 if(pathname==='/api/public/billing' && req.method==='GET'){
  // Public, low-detail commerce availability; never expose API keys, customer data or slots.
  let pilotAvailable=false;
  if(liveCheckoutReady(env)&&pilotCanEnroll(env)&&env.DB){
   try {
    const slots=await env.DB.prepare('SELECT COUNT(*) AS total FROM live_billing_slots').first<{total:number}>();
    pilotAvailable=(slots?.total??Infinity)<1;
   } catch { /* Do not advertise paid checkout if D1 is unavailable. */ }
  }
  return json({pilot_plan:'starter',starter_pilot_available:pilotAvailable,
   pro_available:false,currency:'INR',region:'India',billing_period:'monthly'},200,
   {'Cache-Control':'no-store, private'});
 }
 const session=await getSession(req,env);
 if (!session) return fail(401,'Sign in to access your dashboard.');
 if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:'user:'+session.user_id})).success) return fail(429,'Too many API requests; try again shortly.');
 if (req.method!=='GET' && (!mustBeSameOrigin(req,env) || !csrfOk(req,session))) return fail(403,'CSRF protection failed. Reload the page.');
 const userId=session.user_id;
 if (pathname==='/api/me' && req.method==='GET') return json({ id:userId,email:session.email,name:session.name,avatar_url:session.avatar_url,csrf_token:session.csrf_token });
 if (pathname==='/api/billing' && req.method==='GET') return json(await billingOverview(env,userId));
 if (pathname==='/api/billing/sandbox/create' && req.method==='POST') return sandboxCreateSubscription(env,userId,req);
 if (pathname==='/api/billing/sandbox/cancel' && req.method==='POST') return sandboxCancelSubscription(env,userId);
 if (pathname==='/api/billing/sandbox/verify' && req.method==='POST') return sandboxVerifyCheckout(env,userId,req);
 if (pathname==='/api/billing/live/create' && req.method==='POST') return createLiveSubscription(env,userId,req);
 if (pathname==='/api/billing/live/resume' && req.method==='POST') return resumeLiveCheckout(env,userId);
 if (pathname==='/api/billing/live/confirm' && req.method==='POST') return confirmLiveCheckout(env,userId,req);
 if (pathname==='/api/billing/live/sync' && req.method==='POST') return syncLiveSubscription(env,userId);
 if (pathname==='/api/billing/live/cancel' && req.method==='POST') return cancelLiveSubscription(env,userId);
 if (pathname==='/api/monitors' && req.method==='GET') {
  const result=await env.DB.prepare('SELECT * FROM monitors WHERE user_id=? ORDER BY created_at DESC').bind(userId).all<Record<string,unknown>>();
  const plan=await getEntitlements(env,userId);
  return json({monitors:result.results.map(row=>({...publicMonitor(row),interval_seconds:plan.interval_seconds}))});
 }
 if (pathname==='/api/monitors' && req.method==='POST') {
  const form=await readSmallJson(req);
  const name=typeof form.name==='string'?form.name.trim():'';
  const candidate=validateMakeWebhook(form.webhook_url);
  if (name.length<2 || name.length>80) return fail(400,'Workflow name must be 2–80 characters.');
  if (!candidate.ok || !candidate.url) return fail(400,candidate.error||'Invalid Make webhook.');
  if (form.authorized!==true) return fail(400,'Please confirm you own or are authorized to test this Make workflow.');
  if (!env.WEBHOOK_ENCRYPTION_KEY) return fail(503,'Webhook encryption secret not configured.');
  const plan=await getEntitlements(env,userId);
  const count=await env.DB.prepare('SELECT COUNT(*) AS total FROM monitors WHERE user_id=?').bind(userId).first<{total:number}>();
  if ((count?.total||0)>=plan.monitor_limit) return fail(403,plan.display_name+' plan permits '+plan.monitor_limit+' monitor(s).');
  const id=crypto.randomUUID(); const callbackSecret=newRandomString();
  const time=now(); const ciphertext=await encryptSecret(candidate.url,env.WEBHOOK_ENCRYPTION_KEY);
  // A single D1 write serializes the quota decision; do not trust a prior count under concurrency.
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO monitors (id,user_id,name,webhook_ciphertext,secret_hash,state,health,interval_seconds,schedule_interval_seconds,next_due,created_at,updated_at) SELECT ?,?,?,?,?,'active','configuration_required',21600,?,?,?,? WHERE (SELECT COUNT(*) FROM monitors WHERE user_id=?) < ?")
   .bind(id,userId,name,ciphertext,await sha256(callbackSecret),plan.interval_seconds,time+plan.interval_seconds*1000,time,time,userId,plan.monitor_limit).run();
  if (!inserted.meta.changes) return fail(403,'Monitor quota reached. Refresh your account limits.');
  await audit(env,userId,'monitor_created',id);
  return json({ monitor:{id,name,state:'active',health:'configuration_required',interval_seconds:plan.interval_seconds,next_due:time+plan.interval_seconds*1000},
   callback_url:new URL(`/api/callback/${id}`,env.BASE_URL).toString(),callback_secret:callbackSecret,
   instructions:'Save this secret now: it will never be shown again. For first-time Make webhook verification, map both run_id and proof_code from the incoming webhook into the HTTP callback body after Google Sheets succeeds.' },201);
 }
 const match=pathname.match(/^\/api\/monitors\/([^/]+)(?:\/(runs|run|rotate))?$/);
 if (match) {
  const id=match[1], action=match[2];
  const monitor=await owned(env,userId,id);
  if (!monitor) return fail(404,'Monitor not found.');
  if (action==='runs' && req.method==='GET') {
   const rows=await env.DB.prepare('SELECT id,state,source,created_at,trigger_sent_at,trigger_accepted_at,expires_at,confirmed_at,response_status,error_code,duration_ms FROM runs WHERE monitor_id=? ORDER BY created_at DESC LIMIT 50').bind(id).all();
   return json({runs:rows.results});
  }
  if (action==='run' && req.method==='POST') {
   const result=await runMonitor(env,monitor,'manual',ctx);
   return json(result,result.accepted?202:429);
  }
  if (action==='rotate' && req.method==='POST') {
   const callbackSecret=newRandomString();
   await env.DB.prepare("UPDATE monitors SET secret_hash=?,health='configuration_required',updated_at=? WHERE id=? AND user_id=?")
    .bind(await sha256(callbackSecret),now(),id,userId).run();
   await audit(env,userId,'callback_secret_rotated',id);
   return json({ callback_url:new URL(`/api/callback/${id}`,env.BASE_URL).toString(),callback_secret:callbackSecret,
    instructions:'Replace the Bearer token in Make. Previous callback token is invalid.' });
  }
  if (!action && req.method==='PATCH') {
   const payload=await readSmallJson(req);
   if (payload.state!=='active' && payload.state!=='paused') return fail(400,'Only active or paused is allowed.');
   const isPaused=payload.state==='paused';
   await env.DB.prepare('UPDATE monitors SET state=?,health=?,next_due=?,lock_until=NULL,updated_at=? WHERE id=? AND user_id=?')
    .bind(payload.state,isPaused?'paused':'configuration_required',now()+(isPaused?6*3600000:0),now(),id,userId).run();
   await audit(env,userId,isPaused?'monitor_paused':'monitor_resumed',id);
   return json({ok:true,state:payload.state});
  }
  if (!action && req.method==='DELETE') {
   await env.DB.prepare('DELETE FROM monitors WHERE id=? AND user_id=?').bind(id,userId).run();
   await audit(env,userId,'monitor_deleted',id);
   return json({ok:true});
  }
 }
 if (pathname==='/api/alerts' && req.method==='GET') {
  const rows=await env.DB.prepare('SELECT id,monitor_id,kind,message,created_at,read_at FROM alerts WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(userId).all();
  return json({alerts:rows.results});
 }
 const alertMatch=pathname.match(/^\/api\/alerts\/([^/]+)\/read$/);
 if (alertMatch && req.method==='POST' && isId(alertMatch[1])) {
  await env.DB.prepare('UPDATE alerts SET read_at=? WHERE id=? AND user_id=?').bind(now(),alertMatch[1],userId).run();
  return json({ok:true});
 }
 if (pathname==='/api/settings/telegram' && req.method==='GET') {
  const record=await env.DB.prepare('SELECT telegram_chat_id FROM preferences WHERE user_id=?').bind(userId).first();
  return json({telegram_chat_id:(record as {telegram_chat_id?:string}|null)?.telegram_chat_id||'',enabled:!!env.TELEGRAM_BOT_TOKEN});
 }
 if (pathname==='/api/settings/telegram' && req.method==='POST') {
  const payload=await readSmallJson(req); const id=payload.chat_id;
  if (typeof id!=='string' || (id!=='' && !/^-?\d{5,20}$/.test(id))) return fail(400,'Use a numeric Telegram chat ID, or blank to disable.');
  await env.DB.prepare('INSERT INTO preferences (user_id,telegram_chat_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=excluded.telegram_chat_id').bind(userId,id||null).run();
  return json({ok:true});
 }
 if (pathname==='/api/settings/telegram/test' && req.method==='POST') {
  if (!env.TELEGRAM_BOT_TOKEN) return fail(503,'Telegram bot token is not configured on server.');
  const row=await env.DB.prepare('SELECT telegram_chat_id FROM preferences WHERE user_id=?').bind(userId).first<{telegram_chat_id:string}>();
  if (!row?.telegram_chat_id) return fail(400,'Save your Telegram chat ID first.');
  const result=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:row.telegram_chat_id,text:'LeadPath test: alerts are connected.'}),signal:AbortSignal.timeout(7000)
  });
  return result.ok?json({ok:true}):fail(502,'Telegram delivery was rejected. Check bot chat access and chat ID.');
 }
 if (pathname==='/api/data/export' && req.method==='GET') return json(await accountExport(env,userId),200,{'Content-Disposition':'attachment; filename="leadpath-export.json"'});
 if (pathname==='/api/account' && req.method==='DELETE') {
  // Never orphan a real Razorpay mandate: deleting D1 alone cannot stop recurring charges.
  const activeBilling=await env.DB.prepare(`SELECT id FROM user_subscriptions WHERE user_id=?
   AND billing_mode='live' AND status IN ('pending','active','past_due') LIMIT 1`).bind(userId).first();
  if(activeBilling)return fail(409,'Cancel your live Razorpay subscription and wait until it ends before deleting your account. Contact support if the provider cannot cancel.');
  // SQLite/D1 foreign keys cascade sessions, monitors, runs, acknowledgments, alerts, preferences and audits.
  await env.DB.prepare('DELETE FROM users WHERE id=?').bind(userId).run();
  const local=new URL(env.BASE_URL).protocol==='http:' && new URL(env.BASE_URL).hostname==='localhost';
  return json({ok:true,account_deleted:true},200,{'Set-Cookie':local?'lp_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax':'__Host-lp_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'});
 }
 return fail(404,'API endpoint not found.');
}
