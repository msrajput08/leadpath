import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDb,user,context} from './helpers/db.mjs';
import {getEntitlements} from '../.test-build/entitlements.js';
import {PaddleProvider} from '../.test-build/billing/paddle.js';
import {processBillingWebhook} from '../.test-build/billing/webhook.js';
import worker from '../.test-build/index.js';
const ids={sub:'sub_'+'a'.repeat(26),customer:'ctm_'+'b'.repeat(26),price:'pri_'+'c'.repeat(26),txn:'txn_'+'d'.repeat(26)};
const epoch=Date.now(),period={starts_at:new Date(epoch-10000).toISOString(),ends_at:new Date(epoch+86400000).toISOString()};
function setup(){const DB=makeDb(),uid=user(DB),env={DB,BASE_URL:'https://leadpath.example',BILLING_MODE:'sandbox',BILLING_WEBHOOKS_ENABLED:'true',PAID_ENTITLEMENTS_ENABLED:'true',PADDLE_API_KEY:'test-only-key',PADDLE_WEBHOOK_SECRET:'test-only-webhook-secret'};
 DB.sql.prepare("UPDATE subscriptions SET provider='paddle',provider_environment='sandbox',provider_customer_id=?,provider_subscription_id=? WHERE user_id=?").run(ids.customer,ids.sub,uid);
 DB.sql.prepare("INSERT INTO billing_prices VALUES('paddle','sandbox',?,'starter')").run(ids.price);DB.sql.exec("UPDATE plans SET release_ready=1 WHERE id='starter'");
 return {DB,uid,env,provider:new PaddleProvider(env)};}
function event(suffix=1,overrides={}){return {event_id:'evt_'+String(suffix).padStart(26,'0'),event_type:'subscription.updated',occurred_at:new Date(epoch).toISOString(),data:{id:ids.sub,custom_data:{user_id:'forged',plan:'pro'}},...overrides};}
async function signed(env,body=event(),time=Date.now()){
 const raw=typeof body==='string'?body:JSON.stringify(body),ts=Math.floor(time/1000);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.PADDLE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(ts+':'+raw))),b=>b.toString(16).padStart(2,'0')).join('');
 return new Request(env.BASE_URL+'/api/billing/webhooks/paddle',{method:'POST',headers:{'content-type':'application/json','Paddle-Signature':`ts=${ts};h1=${sig}`},body:raw});
}
function fixtures(){return {sub:{id:ids.sub,customer_id:ids.customer,status:'active',items:[{quantity:1,price:{id:ids.price,billing_cycle:{interval:'month',frequency:1}}}],current_billing_period:period,scheduled_change:null,canceled_at:null,updated_at:new Date(epoch).toISOString()},transactions:[{id:ids.txn,subscription_id:ids.sub,customer_id:ids.customer,status:'completed',billing_period:period,items:[{quantity:1,price:{id:ids.price}}],details:{totals:{total:'900'}}}],adjustments:[]};}
function mockFetch(f){let calls=0;const original=globalThis.fetch;globalThis.fetch=async(url,opts)=>{calls++;assert.ok(String(url).startsWith('https://sandbox-api.paddle.com/'));assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer test-only-key');
 const path=new URL(url).pathname;return Response.json({data:path.startsWith('/subscriptions/')?f.sub:path==='/transactions'?f.transactions:f.adjustments});};return {restore(){globalThis.fetch=original;},get calls(){return calls;}};}
test('billing remains off with defaults and a live environment requires its separate approval gate',async()=>{
 assert.throws(()=>new PaddleProvider({BILLING_MODE:'live',PADDLE_API_KEY:'x',PADDLE_WEBHOOK_SECRET:'y'}),/BILLING_DISABLED/);
 const r=await worker.fetch(new Request('https://leadpath.example/api/billing/webhooks/paddle',{method:'POST'}),{BASE_URL:'https://leadpath.example'},context);assert.equal(r.status,503);
});
test('signature verification rejects forged, modified, expired and oversized webhooks before D1',async()=>{
 const {DB,env}=setup();
 const valid=await signed(env),raw=await valid.text();
 for(const req of [new Request(valid.url,{method:'POST',headers:valid.headers,body:raw+' '}),await signed(env,event(),Date.now()-301000),new Request(valid.url,{method:'POST',headers:{'content-type':'application/json','Paddle-Signature':'bad'},body:raw})]){
  assert.equal((await worker.fetch(req,env,context)).status,401);
 }
 assert.equal((await worker.fetch(await signed(env,'x'.repeat(66000)),env,context)).status,413);
 assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n,0);DB.sql.close();
});
test('verified provider payment activates mapped plan, duplicates do not repeat API calls and IDs cannot be rebound',async()=>{
 const {DB,uid,env}=setup(),f=fixtures(),fetch=mockFetch(f);
 try{
  const result=await worker.fetch(await signed(env),env,context);assert.equal(result.status,200);assert.equal((await result.json()).applied,true);
  const e=await getEntitlements(env,uid);assert.equal(e.id,'starter');assert.equal(e.subscription.paid_through,Date.parse(period.ends_at));
  assert.equal(fetch.calls,3);assert.equal((await worker.fetch(await signed(env,event(1,{notification_id:'ntf_replayed'})),env,context)).status,200);assert.equal(fetch.calls,3);
  assert.equal((await worker.fetch(await signed(env,event(1,{event_type:'subscription.canceled'})),env,context)).status,409);
  assert.equal(DB.sql.prepare('SELECT attempts FROM payment_events').get().attempts,1);
 }finally{fetch.restore();DB.sql.close();}
});
test('failed or unpaid payments never grant access; refund and chargeback revoke current access',async()=>{
 const {DB,uid,env}=setup(),f=fixtures(),fetch=mockFetch(f);
 try{
  f.transactions[0].status='paid';await worker.fetch(await signed(env,event(1)),env,context);assert.equal((await getEntitlements(env,uid)).id,'free');
  f.transactions[0].status='completed';await worker.fetch(await signed(env,event(2)),env,context);assert.equal((await getEntitlements(env,uid)).id,'starter');
  for(const [n,action] of [[3,'refund'],[4,'chargeback']]){
   f.adjustments=[{action,status:'approved'}];await worker.fetch(await signed(env,event(n,{event_type:'adjustment.updated',data:{subscription_id:ids.sub}})),env,context);assert.equal((await getEntitlements(env,uid)).id,'free');
  }
 }finally{fetch.restore();DB.sql.close();}
});
test('renewal, scheduled cancellation, immediate cancellation, expiry and delayed events use verified state',async()=>{
 const {DB,uid,env}=setup(),f=fixtures(),fetch=mockFetch(f);
 try{
  f.sub.scheduled_change={action:'cancel'};await worker.fetch(await signed(env,event(1)),env,context);assert.equal((await getEntitlements(env,uid)).id,'starter');assert.equal(DB.sql.prepare('SELECT cancel_at_period_end FROM subscriptions').get().cancel_at_period_end,1);
  assert.equal((await getEntitlements(env,uid,epoch+86400001)).id,'free');
  const renewal={starts_at:new Date(epoch-5000).toISOString(),ends_at:new Date(epoch+31*86400000).toISOString()};
  f.sub.current_billing_period=renewal;f.sub.updated_at=new Date(epoch+100).toISOString();f.transactions[0].billing_period=renewal;
  await worker.fetch(await signed(env,event(2,{occurred_at:new Date(epoch+100).toISOString()})),env,context);assert.equal((await getEntitlements(env,uid)).subscription.paid_through,Date.parse(renewal.ends_at));
  f.sub.status='canceled';f.sub.updated_at=new Date(epoch+200).toISOString();
  await worker.fetch(await signed(env,event(3,{occurred_at:new Date(epoch+200).toISOString()})),env,context);assert.equal((await getEntitlements(env,uid)).id,'free');
  // Simulate a stale provider read as well as an old event; CAS must not resurrect.
  f.sub.status='active';f.sub.updated_at=new Date(epoch).toISOString();
  const delayed=await worker.fetch(await signed(env,event(4)),env,context);assert.equal((await delayed.json()).applied,false);assert.equal((await getEntitlements(env,uid)).id,'free');
 }finally{fetch.restore();DB.sql.close();}
});
test('unmapped prices and unknown subscriptions are retryable without granting access',async()=>{
 const {DB,uid,env}=setup(),f=fixtures(),fetch=mockFetch(f);
 try{
  DB.sql.exec('DELETE FROM billing_prices');assert.equal((await worker.fetch(await signed(env),env,context)).status,503);assert.equal((await getEntitlements(env,uid)).id,'free');
  DB.sql.prepare("INSERT INTO billing_prices VALUES('paddle','sandbox',?,'starter')").run(ids.price);
  assert.equal((await worker.fetch(await signed(env),env,context)).status,200);assert.equal(DB.sql.prepare('SELECT attempts FROM payment_events').get().attempts,2);
  const unknown=event(2,{data:{id:'sub_'+'z'.repeat(26),custom_data:{user_id:uid}}});assert.equal((await worker.fetch(await signed(env,unknown),env,context)).status,503);
  f.sub.customer_id='ctm_'+'z'.repeat(26);assert.equal((await worker.fetch(await signed(env,event(3)),env,context)).status,503);
 }finally{fetch.restore();DB.sql.close();}
});
test('leased processing recovers after interruption and transactional failures never mark events processed',async()=>{
 const {DB,uid,env,provider}=setup(),f=fixtures(),fetch=mockFetch(f);
 try{
  DB.sql.exec("CREATE TRIGGER abort_subscription BEFORE UPDATE ON subscriptions BEGIN SELECT RAISE(ABORT,'simulated D1 failure'); END;");
  assert.equal((await worker.fetch(await signed(env),env,context)).status,503);
  assert.equal(DB.sql.prepare('SELECT status FROM payment_events').get().status,'failed');assert.equal((await getEntitlements(env,uid)).id,'free');
  DB.sql.exec('DROP TRIGGER abort_subscription');DB.sql.exec("UPDATE payment_events SET status='processing',lease_until=0");
  assert.equal((await processBillingWebhook(await signed(env),env,provider)).status,200);assert.equal((await getEntitlements(env,uid)).id,'starter');
  DB.sql.exec("UPDATE payment_events SET status='failed',attempts=8");assert.equal((await processBillingWebhook(await signed(env),env,provider)).status,503);
 }finally{fetch.restore();DB.sql.close();}
});
test('concurrent duplicate event has one durable receipt and one entitlement transition',async()=>{
 const {DB,env}=setup(),f=fixtures(),fetch=mockFetch(f);
 try{const [a,b]=await Promise.all([signed(env),signed(env)]);const responses=await Promise.all([worker.fetch(a,env,context),worker.fetch(b,env,context)]);
  assert.ok(responses.every(r=>r.status===200||r.status===503));assert.ok(responses.some(r=>r.status===200));assert.equal(fetch.calls,3);
  assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n,1);
 }finally{fetch.restore();DB.sql.close();}
});
test('provider timeout/HTTP failure leaves a failed receipt and retries without mutating entitlements',async()=>{
 const {DB,uid,env}=setup(),original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('unavailable',{status:503});
 try{assert.equal((await worker.fetch(await signed(env),env,context)).status,503);assert.equal((await getEntitlements(env,uid)).id,'free');assert.equal(DB.sql.prepare('SELECT status FROM payment_events').get().status,'failed');}
 finally{globalThis.fetch=original;DB.sql.close();}
});
