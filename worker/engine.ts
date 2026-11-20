import type { Env, Monitor, Run } from './types.js';
import { getEntitlements, resourceLimits } from './entitlements.js';
import { json, now, readBoundedJson, InputError } from './util.js';
import { CONFIRMATION_WINDOW_MS, decryptSecret, syntheticPayload, sha256, constantTimeEqual, validateMakeWebhook, webhookOwnershipProof } from './security.mjs';

type SideEffect = { waitUntil(promise: Promise<unknown>): void };
export const HOUR6 = 6*60*60*1000;

async function emitAlert(env: Env, monitor: Monitor, runId: string, kind: 'failure'|'recovery', ctx: SideEffect): Promise<void> {
 const message=kind==='failure' ? `Delivery unconfirmed repeatedly for “${monitor.name}”. Check the Make scenario and Google Sheets.` : `Delivery confirmed again for “${monitor.name}”.`;
 const result=await env.DB.prepare('INSERT OR IGNORE INTO alerts (id,user_id,monitor_id,run_id,kind,message,created_at) VALUES(?,?,?,?,?,?,?)')
  .bind(crypto.randomUUID(),monitor.user_id,monitor.id,runId,kind,message,now()).run();
 if (!result.meta.changes || !env.TELEGRAM_BOT_TOKEN) return;
 const pref=await env.DB.prepare('SELECT telegram_chat_id FROM preferences WHERE user_id=?').bind(monitor.user_id).first<{telegram_chat_id:string|null}>();
 if (!pref?.telegram_chat_id) return;
 const chatId=pref.telegram_chat_id;
 ctx.waitUntil(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text:`LeadPath: ${message}`}),
  signal:AbortSignal.timeout(7000)
 }).then(result=>{ if(!result.ok) console.error('LeadPath Telegram notification rejected',result.status); })
   .catch(()=>console.error('LeadPath Telegram notification transport failed')));
}

async function failRun(env: Env, runId: string, monitorId: string, state: 'unconfirmed'|'error', code: string, ctx: SideEffect): Promise<boolean> {
 const changed=await env.DB.prepare("UPDATE runs SET state=?,error_code=? WHERE id=? AND monitor_id=? AND state='pending'")
  .bind(state,code,runId,monitorId).run();
 if (!changed.meta.changes) return false;
 const row=await env.DB.prepare('SELECT * FROM monitors WHERE id=?').bind(monitorId).first<Monitor>();
 if (!row || row.last_run_id!==runId) return true;
 const updated=await env.DB.prepare("UPDATE monitors SET failure_streak=failure_streak+1,health=CASE WHEN failure_streak>=1 THEN 'failing' ELSE 'degraded' END,updated_at=?,lock_until=NULL WHERE id=? AND last_run_id=? AND state='active'")
  .bind(now(),monitorId,runId).run();
 if (updated.meta.changes && row.failure_streak===1) await emitAlert(env,row,runId,'failure',ctx);
 return true;
}

export async function runMonitor(env: Env, monitor: Monitor, source: 'manual'|'scheduled', ctx: SideEffect): Promise<{accepted:boolean;run_id?:string;message?:string}> {
 const time=now(); const runId=crypto.randomUUID();
 if (source==='scheduled' && !monitor.verified_at) return {accepted:false,message:'Verify Make webhook ownership before automatic monitoring.'};
 const entitlement=await getEntitlements(env,monitor.user_id,time);
 const limits=resourceLimits(env),day=new Date(time).toISOString().slice(0,10);
 const guard=source==='scheduled' ? 'next_due<=? AND verified_at IS NOT NULL' : '(last_checked IS NULL OR last_checked<=?)';
 const threshold=source==='scheduled'?time:time-entitlement.manual_cooldown_seconds*1000;
 // A downgrade never deletes monitors. Only the oldest allowed monitors execute.
 // Claim + run insert + trigger-based accounting form ONE D1 transaction. A failed
 // insert rolls back the claim; a crashed dispatch is not retried (Make isn't idempotent).
 const result=await env.DB.batch<{meta:{changes:number}}>([
  env.DB.prepare(`UPDATE monitors SET next_due=?,lock_until=?,last_checked=?,last_run_id=?,health='pending',updated_at=?
   WHERE id=? AND user_id=? AND state='active' AND ${guard} AND (lock_until IS NULL OR lock_until<?)
   AND (?='manual' OR last_checked IS NULL OR last_checked<=?)
   AND EXISTS(SELECT 1 FROM subscriptions WHERE user_id=? AND updated_at=?)
   AND id IN (SELECT id FROM monitors WHERE user_id=? ORDER BY created_at,id LIMIT ?)
   AND NOT EXISTS(SELECT 1 FROM runs WHERE monitor_id=? AND state='pending' AND expires_at>?)
   AND COALESCE((SELECT ${source==='scheduled'?'scheduled_runs':'manual_runs'} FROM resource_usage WHERE day=?),0)<?
   AND (?='scheduled' OR (SELECT COUNT(*) FROM run_usage WHERE user_id=? AND source='manual' AND created_at>=?)<?)`)
   .bind(time+entitlement.effective_interval_seconds*1000,time+60000,time,runId,time,monitor.id,monitor.user_id,
    threshold,time,source,time-entitlement.effective_interval_seconds*1000,monitor.user_id,entitlement.subscription.updated_at,monitor.user_id,entitlement.monitor_limit,monitor.id,time,day,
    source==='scheduled'?limits.scheduledPerDay:limits.manualPerDay,source,monitor.user_id,time-86400000,entitlement.manual_daily_limit),
  env.DB.prepare("INSERT INTO runs (id,monitor_id,state,source,created_at,expires_at) SELECT ?,id,'pending',?,?,? FROM monitors WHERE id=? AND last_run_id=?")
   .bind(runId,source,time,time+CONFIRMATION_WINDOW_MS,monitor.id,runId)
 ]);
 if (!result[0]?.meta.changes) return {accepted:false,message:'Check unavailable: monitor paused, awaiting confirmation, outside plan allowance, or a cooldown / usage limit was reached.'};
 let target: string;
 try {
  if (!env.WEBHOOK_ENCRYPTION_KEY) throw new Error('NO_KEY');
  target=await decryptSecret(monitor.webhook_ciphertext,env.WEBHOOK_ENCRYPTION_KEY);
  if (!validateMakeWebhook(target).ok) throw new Error('INVALID_TARGET');
 } catch {
  await failRun(env,runId,monitor.id,'error','CONFIGURATION',ctx);
  return {accepted:true,run_id:runId};
 }
 const callbackUrl=new URL(`/api/callback/${monitor.id}`,env.BASE_URL).toString();
 try {
  await env.DB.prepare("UPDATE runs SET trigger_sent_at=? WHERE id=? AND state='pending'").bind(now(),runId).run();
  // Send a proof known only to the real webhook recipient for the first verification run.
  const payload = syntheticPayload(runId,time,callbackUrl);
  if (!monitor.verified_at) Object.assign(payload,{proof_code:await webhookOwnershipProof(runId,env.WEBHOOK_ENCRYPTION_KEY!)});
  // Never redirect: the URL is a secret, and redirecting to another host would expose its payload.
  const response=await fetch(target,{ method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),
   headers:{'Content-Type':'application/json','X-LeadPath-Test':'true'},
   body:JSON.stringify(payload) });
  const status=response.status;
  await env.DB.prepare('UPDATE runs SET response_status=?,trigger_accepted_at=? WHERE id=?').bind(status,response.ok?now():null,runId).run();
  if (!response.ok) await failRun(env,runId,monitor.id,'error',`HTTP_${status}`,ctx);
  else await env.DB.prepare("UPDATE monitors SET lock_until=NULL WHERE id=? AND last_run_id=?").bind(monitor.id,runId).run();
 } catch (error) {
  const code=error instanceof Error && error.name==='TimeoutError'?'FETCH_TIMEOUT':'FETCH_FAILURE';
  await failRun(env,runId,monitor.id,'error',code,ctx);
 }
 return {accepted:true,run_id:runId};
}

export async function confirmCallback(req: Request, env: Env, monitorId: string, ctx: SideEffect): Promise<Response> {
 if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:'callback:'+monitorId})).success) return json({error:'Rate limit exceeded'},429);
 const raw=req.headers.get('Authorization')||'';
 if (!raw.startsWith('Bearer ') || !/^[a-f0-9]{64}$/.test(raw.slice(7))) return json({error:'Unauthorized callback'},401);
 const monitor=await env.DB.prepare('SELECT * FROM monitors WHERE id=?').bind(monitorId).first<Monitor>();
 if (!monitor || !constantTimeEqual(await sha256(raw.slice(7)),monitor.secret_hash)) return json({error:'Unauthorized callback'},401);
 let data: Record<string, unknown>;
 try { data=await readBoundedJson(req,1024); }
 catch (error) {
  return json({error:error instanceof InputError?error.message:'Unable to read callback'},error instanceof InputError?error.status:400);
 }
 const runId=data.run_id;
 if (typeof runId!=='string' || !/^[0-9a-f-]{36}$/.test(runId)) return json({error:'Valid run_id required'},400);
 const run=await env.DB.prepare('SELECT * FROM runs WHERE id=? AND monitor_id=?').bind(runId,monitorId).first<Run>();
 if (!run) return json({error:'Unknown run'},404);
 if (run.state==='confirmed') return json({ok:true,run_id:runId,already_confirmed:true});
 if (run.state!=='pending' || run.expires_at<now()) return json({error:'Run no longer accepts confirmation'},409);
 if (!monitor.verified_at) {
  // The callback secret belongs to the user; it cannot prove control of an arbitrary
  // Make webhook. The unpredictable HMAC is only delivered to the real Make endpoint.
  const supplied = data.proof_code;
  if (!env.WEBHOOK_ENCRYPTION_KEY || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
      !constantTimeEqual(supplied,await webhookOwnershipProof(runId,env.WEBHOOK_ENCRYPTION_KEY))) {
   return json({error:'Make webhook ownership proof is required'},403);
  }
 }
 const time=now();
 // Atomic D1 transaction: confirmation, acknowledgment and health update cannot partially commit.
 const committed=await env.DB.batch<{meta:{changes:number}}>([
  env.DB.prepare("UPDATE runs SET state='confirmed',confirmed_at=?,duration_ms=?,error_code=NULL WHERE id=? AND monitor_id=? AND state='pending' AND expires_at>=?")
   .bind(time,time-run.created_at,runId,monitorId,time),
  env.DB.prepare("INSERT OR IGNORE INTO acknowledgments(run_id,monitor_id,received_at) SELECT id,monitor_id,? FROM runs WHERE id=? AND monitor_id=? AND state='confirmed'")
   .bind(time,runId,monitorId),
  env.DB.prepare("UPDATE monitors SET failure_streak=0,health='healthy',verified_at=COALESCE(verified_at,?),updated_at=?,lock_until=NULL WHERE id=? AND last_run_id=? AND state='active' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND monitor_id=? AND state='confirmed')")
   .bind(time,time,monitorId,runId,runId,monitorId)
 ]);
 if (!committed[0]?.meta?.changes) return json({error:'Concurrent completion, retry to inspect status'},409);
 if (committed[2]?.meta?.changes && monitor.failure_streak>0) await emitAlert(env,monitor,runId,'recovery',ctx);
 return json({ok:true,run_id:runId,delivery:'destination_confirmed'});
}

export async function sweepTimedOut(env: Env, ctx: SideEffect): Promise<void> {
 const expired=await env.DB.prepare("SELECT id,monitor_id FROM runs WHERE state='pending' AND expires_at<? ORDER BY expires_at LIMIT 2").bind(now()).all<{id:string;monitor_id:string}>();
 for (const run of expired.results) await failRun(env,run.id,run.monitor_id,'unconfirmed','ACK_TIMEOUT',ctx);
}
export async function scheduled(env: Env, ctx: SideEffect): Promise<void> {
 // Once per 15-minute slot across overlapping/retried cron invocations. A crash
 // skips the remainder of that slot; overdue monitors are picked fairly next time.
 const time=now(),tick=Math.floor(time/900000);
 const claim=await env.DB.prepare(`INSERT INTO job_ticks(job,tick) VALUES('monitoring',?)
  ON CONFLICT(job) DO UPDATE SET tick=excluded.tick WHERE job_ticks.tick<excluded.tick`).bind(tick).run();
 if (!claim.meta.changes) return;
 await sweepTimedOut(env,ctx);
 const due=await env.DB.prepare("SELECT * FROM monitors WHERE state='active' AND verified_at IS NOT NULL AND next_due<=? AND (lock_until IS NULL OR lock_until<?) ORDER BY next_due LIMIT ?")
  .bind(time,time,resourceLimits(env).checksPerTick).all<Monitor>();
 for (const monitor of due.results) {
  const result=await runMonitor(env,monitor,'scheduled',ctx);
  // Ineligible or pending monitors must not permanently starve the due queue.
  if (!result.accepted) await env.DB.prepare('UPDATE monitors SET next_due=? WHERE id=? AND next_due<=?')
   .bind(time+900000,monitor.id,time).run();
 }
 // Bounded maintenance batches on every tick: outages at midnight no longer skip
 // a whole day's cleanup. At most one table/slot; no unbounded historical deletes.
 const cleanup=[
  ['oauth_states','expires_at',time],['email_login_codes','expires_at',time],
  ['password_tokens','expires_at',time],['password_mail_limits','window_start',time-2*86400000],
  ['sessions','expires_at',time],['runs','created_at',time-90*86400000],
  ['audit_events','occurred_at',time-365*86400000],['run_usage','created_at',time-2*86400000],
  ['usage_daily','day',new Date(time-90*86400000).toISOString().slice(0,10)],
  ['resource_usage','day',new Date(time-90*86400000).toISOString().slice(0,10)]
 ] as const;
 const [table,column,cutoff]=cleanup[tick%cleanup.length];
 await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column}<? LIMIT 100)`).bind(cutoff).run();
}
