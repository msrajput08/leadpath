import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeDb,user,monitor,context} from './helpers/db.mjs';
import {getEntitlements,billingSummary,resourceLimits} from '../.test-build/entitlements.js';
import {runMonitor,scheduled} from '../.test-build/engine.js';
import worker from '../.test-build/index.js';
import {sha256,encryptSecret} from '../worker/security.mjs';
const base='https://leadpath.example';
const envFor=DB=>({DB,BASE_URL:base,WEBHOOK_ENCRYPTION_KEY:'f'.repeat(64)});
function paid(DB,uid,plan='pro',overrides={}){
 const time=Date.now();DB.sql.prepare("UPDATE plans SET release_ready=1 WHERE id=?").run(plan);
 const fields={plan_id:plan,status:'active',provider:'paddle',provider_environment:'sandbox',provider_customer_id:'ctm_'+uid.replaceAll('-','').slice(0,26),provider_subscription_id:'sub_'+uid.replaceAll('-','').slice(0,26),provider_price_id:'pri_'+'a'.repeat(26),period_start:time-10000,period_end:time+86400000,paid_through:time+86400000,last_verified_at:time,...overrides};
 DB.sql.prepare(`UPDATE subscriptions SET ${Object.keys(fields).map(k=>k+'=?').join(',')} WHERE user_id=?`).run(...Object.values(fields),uid);
}
const enabled=env=>({...env,PAID_ENTITLEMENTS_ENABLED:'true',BILLING_MODE:'sandbox',MONITOR_MIN_INTERVAL_SECONDS:'900'});
async function session(DB,uid){const token='a'.repeat(64),csrf='csrf-test';DB.sql.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)').run(await sha256(token),uid,csrf,Date.now()+600000,Date.now());return {cookie:`__Host-lp_session=${token}`,'X-CSRF-Token':csrf,Origin:base,'Content-Type':'application/json'};}
function request(path,method='GET',headers={},body){return new Request(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});}
test('migration preserves all legacy data and provisions Free for existing and new users',async()=>{
 const DB=makeDb({through:4}),uid=user(DB),m=monitor(DB,uid);DB.sql.prepare('INSERT INTO preferences VALUES(?,?)').run(uid,'123456');
 DB.sql.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'confirmed','manual',?,?)").run(crypto.randomUUID(),m.id,Date.now(),Date.now()+1);
 const before=DB.sql.prepare('SELECT * FROM monitors').all(),runs=DB.sql.prepare('SELECT * FROM runs').all();
 DB.sql.exec(fs.readFileSync(new URL('../db/migrations/0005_subscription_foundation.sql',import.meta.url),'utf8'));
 assert.deepEqual(DB.sql.prepare('SELECT * FROM monitors').all(),before);assert.deepEqual(DB.sql.prepare('SELECT * FROM runs').all(),runs);
 assert.equal(DB.sql.prepare('SELECT telegram_chat_id FROM preferences').get().telegram_chat_id,'123456');
 for(const id of [uid,user(DB)]){const e=await getEntitlements(envFor(DB),id);assert.equal(e.id,'free');assert.equal(e.monitor_limit,1);assert.equal(e.effective_interval_seconds,21600);assert.equal(e.history_days,90);}
 assert.deepEqual(DB.sql.prepare('PRAGMA foreign_key_check').all(),[]);DB.sql.close();
});
test('paid access fails closed for disabled gates, invalid states, expiry and unpaid periods',async()=>{
 const DB=makeDb(),uid=user(DB),env=envFor(DB);paid(DB,uid);
 assert.equal((await getEntitlements(env,uid)).id,'free');
 const on=enabled(env);assert.equal((await getEntitlements(on,uid)).id,'pro');
 DB.sql.exec("UPDATE plans SET release_ready=0 WHERE id='pro'");assert.equal((await getEntitlements(on,uid)).id,'free');DB.sql.exec("UPDATE plans SET release_ready=1 WHERE id='pro'");
 for(const state of ['pending','trialing','past_due','paused','canceled','expired']){paid(DB,uid,'pro',{status:state});assert.equal((await getEntitlements(on,uid)).id,'free',state);}
 for(const fields of [{paid_through:null},{period_end:Date.now()-1,period_start:Date.now()-10000},{paid_through:Date.now()-1},{period_start:Date.now()+1000},{provider_subscription_id:null},{last_verified_at:null},{provider_environment:'live'}]){paid(DB,uid,'pro',fields);assert.equal((await getEntitlements(on,uid)).id,'free',JSON.stringify(fields));}
 paid(DB,uid,'pro',{cancel_at_period_end:1});assert.equal((await getEntitlements(on,uid)).id,'pro','scheduled cancellation preserves paid period');
 assert.equal((await getEntitlements({...on,MONITOR_MIN_INTERVAL_SECONDS:undefined},uid)).effective_interval_seconds,21600,'safe default floor');DB.sql.close();
});
test('atomic monitor limits are 1/5/25 and browser premium fields are ignored',async()=>{
 for(const [plan,limit] of [['free',1],['starter',5],['pro',25]]){
  const DB=makeDb(),uid=user(DB),env=enabled(envFor(DB)),headers=await session(DB,uid);if(plan!=='free')paid(DB,uid,plan);
  const responses=await Promise.all(Array.from({length:limit+2},()=>worker.fetch(request('/api/monitors','POST',headers,{name:'Workflow',webhook_url:'https://hook.eu1.make.com/abcdefgh123',authorized:true,plan_id:'pro',interval_seconds:1,paid:true}),env,context)));
  assert.equal(responses.filter(r=>r.status===201).length,limit);assert.equal(responses.filter(r=>r.status===403).length,2);
  assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM monitors').get().n,limit);
  const summary=await billingSummary(env,uid);assert.equal(summary.checkout_available,false);assert.equal(JSON.stringify(summary).includes('monthly_price_cents'),false);DB.sql.close();
 }
});
test('billing APIs require auth/CSRF, cannot upgrade, and block deleting renewable subscriptions',async()=>{
 const DB=makeDb(),uid=user(DB),env=envFor(DB),headers=await session(DB,uid);
 assert.equal((await worker.fetch(request('/api/billing'),env,context)).status,401);
 assert.equal((await worker.fetch(request('/api/billing/checkout','POST',{...headers,Origin:'https://evil.example'},{}),env,context)).status,403);
 for(const action of ['checkout','cancel','portal'])assert.equal((await worker.fetch(request('/api/billing/'+action,'POST',headers,{plan:'pro',paid:true}),env,context)).status,503);
 assert.equal((await getEntitlements(env,uid)).id,'free');
 paid(DB,uid);assert.equal((await worker.fetch(request('/api/account','DELETE',headers,{}),env,context)).status,409);
 DB.sql.exec("UPDATE subscriptions SET status='canceled'");assert.equal((await worker.fetch(request('/api/account','DELETE',headers,{}),env,context)).status,200);DB.sql.close();
});
test('manual usage cannot be bypassed by deleting/recreating monitors',async()=>{
 const DB=makeDb(),uid=user(DB),env=envFor(DB),m=monitor(DB,uid);
 for(let i=0;i<3;i++)DB.sql.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'error','manual',?,?)").run(crypto.randomUUID(),m.id,Date.now()-3600000-i,Date.now()-1);
 DB.sql.prepare('DELETE FROM monitors WHERE id=?').run(m.id);
 const next=monitor(DB,uid);assert.equal((await runMonitor(env,next,'manual',context)).accepted,false);
 assert.equal((await billingSummary(env,uid)).usage.manual_runs_last_24h,3);DB.sql.close();
});
test('scheduler uses plan frequencies and prevents overlapping runs and catch-up bursts',async()=>{
 for(const [plan,seconds] of [['free',21600],['starter',3600],['pro',900]]){
  const DB=makeDb(),uid=user(DB),env=enabled(envFor(DB));if(plan!=='free')paid(DB,uid,plan);
  const m=monitor(DB,uid),time=Date.now();
  const results=await Promise.all([runMonitor(env,m,'scheduled',context),runMonitor(env,m,'scheduled',context)]);
  assert.equal(results.filter(r=>r.accepted).length,1);assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM runs').get().n,1);
  const next=DB.sql.prepare('SELECT next_due FROM monitors').get().next_due;assert.ok(next>=time+seconds*1000 && next<time+seconds*1000+5000);
  DB.sql.prepare("UPDATE runs SET state='pending',expires_at=?").run(Date.now()+1800000);
  DB.sql.prepare('UPDATE monitors SET next_due=0,last_checked=0,lock_until=NULL').run();
  assert.equal((await runMonitor(env,m,'scheduled',context)).accepted,false,'pending destination check must not overlap');DB.sql.close();
 }
});
test('downgrade keeps all monitors/history, restricts execution to oldest allowance, applies Free frequency immediately',async()=>{
 const DB=makeDb(),uid=user(DB),env=enabled(envFor(DB));paid(DB,uid,'starter');
 const a=monitor(DB,uid,{created_at:1}),b=monitor(DB,uid,{created_at:2});
 DB.sql.exec("UPDATE subscriptions SET paid_through=0");
 assert.equal((await runMonitor(env,b,'manual',context)).accepted,false);
 assert.equal((await runMonitor(env,a,'scheduled',context)).accepted,true);
 DB.sql.prepare('UPDATE monitors SET next_due=0,last_checked=? WHERE id=?').run(Date.now()-3600000,a.id);
 assert.equal((await runMonitor(env,a,'scheduled',context)).accepted,false);
 assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM monitors').get().n,2);assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM runs').get().n,1);DB.sql.close();
});
test('global resource budget and per-tick cap survive retries, across users',async()=>{
 const DB=makeDb(),env={...envFor(DB),SCHEDULED_CHECKS_PER_DAY:'2'};
 for(let i=0;i<5;i++)monitor(DB,user(DB));
 await scheduled(env,context);await scheduled(env,context);
 assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM runs').get().n,2);
 const budget=DB.sql.prepare('SELECT scheduled_runs FROM resource_usage').get();assert.equal(budget.scheduled_runs,2);
 assert.equal(resourceLimits({...env,SCHEDULED_CHECKS_PER_DAY:'999999'}).scheduledPerDay,288);
 assert.equal(resourceLimits({...env,SCHEDULER_BATCH_SIZE:'999999'}).checksPerTick,3);DB.sql.close();
});
test('failed D1 run initialization rolls back monitor claim and quota accounting',async()=>{
 const DB=makeDb(),uid=user(DB),env=envFor(DB),m=monitor(DB,uid);
 DB.sql.exec("CREATE TRIGGER simulated_failure BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'simulated failure'); END;");
 await assert.rejects(runMonitor(env,m,'manual',context),/simulated failure/);
 assert.equal(DB.sql.prepare('SELECT last_run_id FROM monitors').get().last_run_id,null);
 assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM run_usage').get().n,0);DB.sql.close();
});
test('worst-case scheduled failures and timeout sweeps fit the Free D1 query budget',async()=>{
 const DB=makeDb(),env={...envFor(DB),TELEGRAM_BOT_TOKEN:'test-token'};
 for(let i=0;i<5;i++){
  const uid=user(DB),m=monitor(DB,uid,{failure_streak:1});DB.sql.prepare('INSERT INTO preferences VALUES(?,NULL)').run(uid);
  if(i<2){const rid=crypto.randomUUID();DB.sql.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','scheduled',?,?)").run(rid,m.id,Date.now()-3600000,Date.now()-1);DB.sql.prepare('UPDATE monitors SET last_run_id=? WHERE id=?').run(rid,m.id);}
 }
 DB.queries=0;await scheduled(env,context);assert.ok(DB.queries<=50,`queries=${DB.queries}`);DB.sql.close();
});
test('successful dispatch remains one network request even when a cron invocation is repeated',async()=>{
 const DB=makeDb(),uid=user(DB),env=envFor(DB);monitor(DB,uid,{webhook_ciphertext:await encryptSecret('https://hook.eu1.make.com/abcdefgh123',env.WEBHOOK_ENCRYPTION_KEY)});
 let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;return new Response('Accepted');};
 try{await scheduled(env,context);await scheduled(env,context);assert.equal(calls,1);}finally{globalThis.fetch=original;DB.sql.close();}
});
