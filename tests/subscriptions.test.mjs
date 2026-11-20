import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../.test-build/api.js';
import {runMonitor} from '../.test-build/engine.js';
import {getEntitlements,withinMonitorLimit} from '../.test-build/entitlements.js';
import {razorpayWebhook} from '../.test-build/billing.js';
import {sha256,newRandomString} from '../worker/security.mjs';

const base='https://leadpath.example';
const ctx={waitUntil(p){p.catch(()=>{});}};
function makeDb(withBilling=true){
 const sql=new DatabaseSync(':memory:');
 for(const file of ['0001_init.sql','0002_webhook_ownership.sql',...(withBilling?['0005_subscription_foundation.sql']:[])])
  sql.exec(fs.readFileSync(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
 return {sql,
  prepare(s){return {sql:s,args:[],bind(...args){this.args=args;return this;},
   async first(){return sql.prepare(this.sql).get(...this.args)||null;},
   async all(){return {results:sql.prepare(this.sql).all(...this.args),success:true};},
   async run(){const row=sql.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(row.changes)}};}};},
  async batch(queries){sql.exec('BEGIN');try{const results=[];for(const q of queries)results.push(await q.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}
 };
}
async function account(DB){
 const userId=crypto.randomUUID(),time=Date.now(),token=newRandomString(),csrf=newRandomString(16);
 await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(userId,'example@example.test','Example',time,time).run();
 await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
 .bind(await sha256(token),userId,csrf,time+86400000,time).run();
 return {userId,csrf,cookie:'__Host-lp_session='+token};
}
function request(path,method='GET',data,account){
 const headers={Origin:base,cookie:account?.cookie||''};
 if(method!=='GET'){headers['content-type']='application/json';headers['x-csrf-token']=account?.csrf||'';}
 return new Request(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
}
function eventPayload(event,subId,createdAt=Math.floor(Date.now()/1000),end=Math.floor(Date.now()/1000)+86400){
 return {event,created_at:createdAt,payload:{subscription:{entity:{
  id:subId,status:event==='subscription.activated'||event==='subscription.charged'?'active':'cancelled',
  current_start:createdAt-1000,current_end:end
 }}}};
}
async function webhook(env,id,payload,correct=true){
 const body=JSON.stringify(payload);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(correct?env.RAZORPAY_WEBHOOK_SECRET:'wrong'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))),b=>b.toString(16).padStart(2,'0')).join('');
 return razorpayWebhook(new Request(base+'/api/billing/webhook/razorpay',{method:'POST',
  headers:{'content-type':'application/json','x-razorpay-signature':sig,'x-razorpay-event-id':id},body}),env);
}

test('additive D1 migration keeps original monitor and runs, permits controlled future multi-monitor quota',async()=>{
 const DB=makeDb(false),t=Date.now(),uid=crypto.randomUUID(),mid=crypto.randomUUID(),rid=crypto.randomUUID();
 try {
  await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(uid,'test@example.test','Test',t,t).run();
  await DB.prepare("INSERT INTO monitors(id,user_id,name,webhook_ciphertext,secret_hash,state,health,interval_seconds,next_due,created_at,updated_at) VALUES(?,?,?,?,?,'active','configuration_required',21600,?,?,?)").bind(mid,uid,'Original','ciphertext','hash',t,t,t).run();
  await DB.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','manual',?,?)").bind(rid,mid,t,t+10000).run();
  DB.sql.exec(fs.readFileSync(new URL('../db/migrations/0005_subscription_foundation.sql',import.meta.url),'utf8'));
  const saved=await DB.prepare('SELECT schedule_interval_seconds FROM monitors WHERE id=?').bind(mid).first();
  assert.equal(saved.schedule_interval_seconds,21600);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM runs WHERE monitor_id=?').bind(mid).first()).c,1);
  await DB.prepare("INSERT INTO monitors(id,user_id,name,webhook_ciphertext,secret_hash,state,health,interval_seconds,next_due,created_at,updated_at) VALUES(?,?,?,?,?,'active','configuration_required',21600,?,?,?)").bind(crypto.randomUUID(),uid,'Second','cipher','hash',t,t+1,t+1).run();
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM monitors WHERE user_id=?').bind(uid).first()).c,2);
 }finally{DB.sql.close();}
});
test('Free is fail-closed, verified webhook alone does not activate payments, expiry and downgrades preserve monitors',async()=>{
 const DB=makeDb(),a=await account(DB),subId='sub_test123456',t=Date.now();
 const env={DB,BASE_URL:base,WEBHOOK_ENCRYPTION_KEY:'a'.repeat(64),RAZORPAY_WEBHOOK_SECRET:'staging-only-webhook-secret',BILLING_WEBHOOKS_ENABLED:'true',PAID_ENTITLEMENTS_ENABLED:'true'};
 try{
  const newMonitor=(n)=>handleApi(request('/api/monitors','POST',{name:'Monitor '+n,webhook_url:'https://hook.eu1.make.com/TestWebhook123',authorized:true},a),env,ctx);
  assert.equal((await getEntitlements(env,a.userId)).code,'free');
  assert.equal((await newMonitor(1)).status,201);
  assert.equal((await newMonitor(2)).status,403);
  const inactive=await razorpayWebhook(new Request(base+'/api/billing/webhook/razorpay',{method:'POST',body:'{}'}),{...env,BILLING_WEBHOOKS_ENABLED:'false'});
  assert.equal(inactive.status,503);
  await DB.prepare(`INSERT INTO user_subscriptions(id,user_id,plan_code,provider,provider_subscription_id,status,current_period_end,created_at,updated_at)
  VALUES(?,?,'starter','razorpay',?,'pending',?,?,?)`).bind(crypto.randomUUID(),a.userId,subId,t+86400000,t,t).run();
  assert.equal((await getEntitlements(env,a.userId)).code,'free');
  const activate=eventPayload('subscription.activated',subId);
  assert.equal((await webhook(env,'evt_activated1',activate,false)).status,401);
  assert.equal((await getEntitlements(env,a.userId)).code,'free');
  assert.equal((await webhook(env,'evt_activated1',activate)).status,200);
  assert.equal((await getEntitlements(env,a.userId)).code,'starter');
  assert.equal((await webhook(env,'evt_activated1',activate)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM payment_events').first()).c,1,'duplicate webhook idempotence');
  for(let i=2;i<=5;i++)assert.equal((await newMonitor(i)).status,201);
  assert.equal((await newMonitor(6)).status,403,'Starter quota from server');
  await webhook(env,'evt_ignored_type',eventPayload('subscription.authenticated',subId,activate.created_at+1));
  assert.equal((await getEntitlements(env,a.userId)).code,'starter','unrecognized signed events cannot downgrade a subscription');
  const lateCancel=eventPayload('subscription.cancelled',subId,activate.created_at-5);
  await webhook(env,'evt_old_cancel',lateCancel);
  assert.equal((await getEntitlements(env,a.userId)).code,'starter','older out-of-order event ignored');
  await webhook(env,'evt_cancel',eventPayload('subscription.cancelled',subId,activate.created_at+1));
  assert.equal((await getEntitlements(env,a.userId)).code,'free');
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM monitors WHERE user_id=?').bind(a.userId).first()).c,5,'downgrade keeps existing data');
  const latest=await DB.prepare('SELECT id,user_id,created_at FROM monitors WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(a.userId).first();
  assert.equal(await withinMonitorLimit(env,latest,1),false);
  assert.equal((await handleApi(request('/api/billing','GET',undefined,a),env,ctx)).status,200);
  assert.equal((await handleApi(request('/api/billing','GET',undefined),env,ctx)).status,401,'billing overview requires authentication');
  assert.equal((await handleApi(request('/api/billing','POST',{plan_code:'pro'},a),env,ctx)).status,404,'browser cannot upgrade its own plan');
  // A correctly signed webhook for an unlinked provider ID must not create a subscription.
  await webhook(env,'evt_unknown',eventPayload('subscription.activated','sub_unknown123',activate.created_at+2));
  assert.equal((await getEntitlements(env,a.userId)).code,'free');
  // Disabling the operational gate always returns Free, regardless of DB state.
  await webhook(env,'evt_reactivate',eventPayload('subscription.activated',subId,activate.created_at+3));
  assert.equal((await getEntitlements({...env,PAID_ENTITLEMENTS_ENABLED:'false'},a.userId)).code,'free');
  await DB.prepare('UPDATE user_subscriptions SET current_period_end=? WHERE user_id=?').bind(t-1,a.userId).run();
  assert.equal((await getEntitlements(env,a.userId)).code,'free','expired subscription cannot grant access');
 }finally{DB.sql.close();}
});
test('scheduled cadence derives from server entitlements; same monitor cannot be claimed twice',async()=>{
 const DB=makeDb(),a=await account(DB),now=Date.now(),subId='sub_scheduled123';
 const env={DB,BASE_URL:base,WEBHOOK_ENCRYPTION_KEY:'9'.repeat(64),PAID_ENTITLEMENTS_ENABLED:'true'};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response('accepted',{status:200});
 try{
  const created=await handleApi(request('/api/monitors','POST',{name:'Scheduled',webhook_url:'https://hook.eu1.make.com/Testing123456',authorized:true},a),env,ctx);
  assert.equal(created.status,201);
  const monitorId=(await created.json()).monitor.id;
  await DB.prepare('UPDATE monitors SET verified_at=?,next_due=? WHERE id=?').bind(now,now-1000,monitorId).run();
  await DB.prepare(`INSERT INTO user_subscriptions(id,user_id,plan_code,provider,provider_subscription_id,status,current_period_end,created_at,updated_at)
  VALUES(?,?,'starter','razorpay',?,'active',?,?,?)`).bind(crypto.randomUUID(),a.userId,subId,now+86400000,now,now).run();
  let monitor=await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(monitorId).first();
  const started=await runMonitor(env,monitor,'scheduled',ctx);
  assert.equal(started.accepted,true);
  let result=await DB.prepare('SELECT next_due,last_checked,schedule_interval_seconds FROM monitors WHERE id=?').bind(monitorId).first();
  assert.equal(result.next_due-result.last_checked,3600000);
  assert.equal(result.schedule_interval_seconds,3600);
  assert.equal((await runMonitor(env,monitor,'scheduled',ctx)).accepted,false,'idempotent due claim');
  await DB.prepare("UPDATE user_subscriptions SET plan_code='pro' WHERE user_id=?").bind(a.userId).run();
  await DB.prepare('UPDATE monitors SET next_due=?,lock_until=NULL WHERE id=?').bind(Date.now()-1,monitorId).run();
  monitor=await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(monitorId).first();
  assert.equal((await runMonitor(env,monitor,'scheduled',ctx)).accepted,true);
  result=await DB.prepare('SELECT next_due,last_checked,schedule_interval_seconds FROM monitors WHERE id=?').bind(monitorId).first();
  assert.equal(result.next_due-result.last_checked,900000);
  assert.equal(result.schedule_interval_seconds,900);
  const usage=await DB.prepare('SELECT scheduled_checks FROM monthly_usage WHERE user_id=?').bind(a.userId).first();
  assert.equal(usage.scheduled_checks,2);
 }finally{globalThis.fetch=originalFetch;DB.sql.close();}
});
