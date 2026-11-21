import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../.test-build/api.js';
import {getEntitlements} from '../.test-build/entitlements.js';
import {razorpayWebhook} from '../.test-build/billing.js';
import {sha256,newRandomString} from '../worker/security.mjs';

const base='https://leadpath.example',ctx={waitUntil(){}};
function makeDb(){
 const sql=new DatabaseSync(':memory:');
 for(const p of ['0001_init.sql','0002_webhook_ownership.sql','0005_subscription_foundation.sql',
  '0006_test_checkout_locks.sql','0007_live_billing_mode.sql'])
  sql.exec(fs.readFileSync(new URL('../db/migrations/'+p,import.meta.url),'utf8'));
 return {sql,
  prepare(query){return {query,args:[],bind(...args){this.args=args;return this;},
   async first(){return sql.prepare(this.query).get(...this.args)||null;},
   async all(){return {results:sql.prepare(this.query).all(...this.args),success:true};},
   async run(){const r=sql.prepare(this.query).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}};},
  async batch(queries){
   sql.exec('BEGIN');try{const out=[];for(const q of queries)out.push(await q.run());sql.exec('COMMIT');return out;}
   catch(e){sql.exec('ROLLBACK');throw e;}
  }};
}
async function account(DB){
 const userId=crypto.randomUUID(),token=newRandomString(),csrf=crypto.randomUUID(),now=Date.now();
 await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)')
  .bind(userId,'pilot@example.test','Pilot',now,now).run();
 await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(token),userId,csrf,now+86400000,now).run();
 return {userId,csrf,token};
}
function setupEnv(DB){
 return {DB,BASE_URL:base,LIVE_BILLING_ENABLED:'true',LIVE_BILLING_WEBHOOKS_ENABLED:'true',
  PAID_ENTITLEMENTS_ENABLED:'true',LIVE_CAPACITY_REVIEWED:'true',LIVE_MAX_PAID_ACCOUNTS:'1',
  SCHEDULE_BATCH_LIMIT:'6',LIVE_PILOT_PLAN:'starter',RAZORPAY_LIVE_KEY_ID:'rzp_live_fake_live_id',
  RAZORPAY_LIVE_KEY_SECRET:'mocked-live-secret-for-HMAC-only',
  RAZORPAY_LIVE_STARTER_PLAN_ID:'plan_StarterLive2026',
  RAZORPAY_LIVE_PRO_PLAN_ID:'plan_ProLive2026',
  RAZORPAY_LIVE_WEBHOOK_SECRET:'mocked-live-webhook-secret'};
}
function send(env,who,path,method='GET',payload,csrfOverride){
 const headers={'content-type':'application/json',Origin:base,
  cookie:'__Host-lp_session='+who.token,'X-CSRF-Token':csrfOverride||who.csrf};
 return handleApi(new Request(base+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),env,ctx);
}
async function signature(secret,value){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value))),
  b=>b.toString(16).padStart(2,'0')).join('');
}
test('live checkout refuses keys, feature flags, unreviewed capacity and nonmatching INR plans',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),previous=globalThis.fetch;
 try{
  const path='/api/billing/live/create';
  assert.equal((await send({...env,LIVE_BILLING_ENABLED:'false'},who,path,'POST',{plan_code:'starter'})).status,503);
  assert.equal((await send({...env,RAZORPAY_LIVE_KEY_ID:'rzp_test_forbidden'},who,path,'POST',{plan_code:'starter'})).status,503);
  assert.equal((await send({...env,LIVE_CAPACITY_REVIEWED:'false'},who,path,'POST',{plan_code:'starter'})).status,503);
  assert.equal((await send({...env,SCHEDULE_BATCH_LIMIT:'3'},who,path,'POST',{plan_code:'starter'})).status,503);
  assert.equal((await send({...env,SCHEDULE_BATCH_LIMIT:'30'},who,path,'POST',{plan_code:'starter'})).status,503);
  assert.equal((await send({...env,LIVE_PILOT_PLAN:'pro'},who,path,'POST',{plan_code:'starter'})).status,503);
  assert.equal((await send(env,who,path,'POST',{plan_code:'pro'})).status,403,
   'Pro checkout is blocked in the initial one-customer Starter pilot');
  assert.equal((await send(env,who,path,'POST',{plan_code:'starter'},'wrong-csrf')).status,403);
  assert.equal((await send(env,who,path,'POST',{plan_code:'free'})).status,400);
  globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,'manual');
   return Response.json({id:'plan_StarterLive2026',period:'monthly',interval:1,
    item:{amount:50000,currency:'INR'}});};
  const mismatch=await send(env,who,path,'POST',{plan_code:'starter'});
  assert.equal(mismatch.status,503);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM live_billing_slots').first()).c,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM user_subscriptions').first()).c,0);
 }finally{globalThis.fetch=previous;DB.sql.close();}
});
test('verified LIVE payment activates only the matching live record, and owner can cancel future renewals',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),previous=globalThis.fetch;
 const subId='sub_LivePilot2026';let cancelled=false,paidThrough=Date.now()+86400000,requests=0;
 globalThis.fetch=async(url,options)=>{
  requests++;
  assert.equal(options.redirect,'manual');
  assert.ok(String(url).startsWith('https://api.razorpay.com/v1/'));
  assert.equal(options.headers.Authorization,'Basic '+btoa(env.RAZORPAY_LIVE_KEY_ID+':'+env.RAZORPAY_LIVE_KEY_SECRET));
  if(String(url).endsWith('plans/plan_StarterLive2026'))
   return Response.json({id:'plan_StarterLive2026',period:'monthly',interval:1,item:{amount:79900,currency:'INR'}});
  if(String(url).endsWith('/subscriptions')&&options.method==='POST'){
   const body=JSON.parse(options.body);
   assert.equal(body.plan_id,'plan_StarterLive2026');assert.equal(body.total_count,12);
   assert.equal(body.quantity,1);assert.equal(body.customer_notify,true);
   return Response.json({id:subId,plan_id:'plan_StarterLive2026',status:'created',
    short_url:'https://rzp.io/rzp/livepilot'});}
  if(String(url).endsWith('/subscriptions/'+subId+'/cancel')){
   assert.equal(JSON.parse(options.body).cancel_at_cycle_end,true);
   cancelled=true;return Response.json({id:subId,plan_id:'plan_StarterLive2026'});}
  if(String(url).endsWith('/subscriptions/'+subId))
   return Response.json({id:subId,plan_id:'plan_StarterLive2026',
    status:cancelled?'cancelled':'active',current_start:Math.floor(Date.now()/1000)-60,
    current_end:Math.floor(paidThrough/1000),cancel_at_cycle_end:cancelled,paid_count:1});
  throw Error('Unexpected Razorpay API request '+url);
 };
 try{
  assert.equal((await getEntitlements(env,who.userId)).code,'free');
  const checkout=await send(env,who,'/api/billing/live/create','POST',{plan_code:'starter'});
  assert.equal(checkout.status,201,await checkout.clone().text());
  const details=await checkout.json();
  assert.equal(details.checkout_url,'https://rzp.io/rzp/livepilot');
  assert.equal(details.mode,'live');
  const record=await DB.prepare('SELECT billing_mode,status FROM user_subscriptions WHERE user_id=?').bind(who.userId).first();
  assert.equal(record.billing_mode,'live');assert.equal(record.status,'pending');
  assert.equal((await getEntitlements(env,who.userId)).code,'free','payment not yet verified');
  assert.equal((await send(env,who,'/api/billing/live/create','POST',{plan_code:'pro'})).status,403);
  const second=await account(DB);
  assert.equal((await send(env,second,'/api/billing/live/create','POST',{plan_code:'starter'})).status,409,
   'atomic pilot reservations reject a second paying account');
  const baseProof={razorpay_payment_id:'pay_LivePilot01',razorpay_subscription_id:subId};
  const forged=await send(env,who,'/api/billing/live/confirm','POST',{...baseProof,razorpay_signature:'a'.repeat(64)});
  assert.equal(forged.status,401);
  assert.equal((await getEntitlements(env,who.userId)).code,'free');
  const verified=await send(env,who,'/api/billing/live/confirm','POST',{
   ...baseProof,razorpay_signature:await signature(env.RAZORPAY_LIVE_KEY_SECRET,baseProof.razorpay_payment_id+'|'+subId)});
  assert.equal(verified.status,200);
  assert.equal((await verified.json()).paid_access,true);
  assert.equal((await getEntitlements(env,who.userId)).code,'starter');
  assert.equal((await send(env,who,'/api/account','DELETE',{})).status,409,
   'account deletion cannot silently leave a Razorpay mandate charging the user');
  const bill=await send(env,who,'/api/billing');
  const overview=await bill.json();
  assert.equal(overview.checkout_enabled,false,'single-account pilot checkout must close after slot reservation');
  assert.equal(overview.live_pilot_plan,'starter');
  assert.equal(overview.plans.find(p=>p.code==='starter').available_for_purchase,false,'Starter CTA closes when slot is occupied');
  assert.equal(overview.plans.find(p=>p.code==='pro').available_for_purchase,false);
  const cancel=await send(env,who,'/api/billing/live/cancel','POST',{});
  assert.equal(cancel.status,200);
  assert.equal((await cancel.json()).cancel_at_period_end,true);
  assert.equal((await getEntitlements(env,who.userId)).code,'starter','paid-through access retained until end');
  paidThrough=Date.now()-3600000;
  const lapsed=await send(env,who,'/api/billing/live/sync','POST',{});
  assert.equal((await lapsed.json()).status,'cancelled');
  assert.equal((await getEntitlements(env,who.userId)).code,'free','expired paid access revoked');
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM live_billing_slots').first()).c,0,
   'provider-confirmed expiry releases limited pilot capacity');
  assert.ok(requests>=5);
 }finally{globalThis.fetch=previous;DB.sql.close();}
});
test('live and test webhooks cannot cross-grant payment access',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),subId='sub_LiveOnly123',t=Date.now(),original=globalThis.fetch;
 try{
  await DB.prepare(`INSERT INTO user_subscriptions(id,user_id,plan_code,provider,provider_subscription_id,status,
    current_period_end,created_at,updated_at,billing_mode)
    VALUES(?,?,'starter','razorpay',?,'pending',?,?,?,'live')`)
   .bind(crypto.randomUUID(),who.userId,subId,t+86400000,t,t).run();
  const event={event:'subscription.activated',created_at:Math.floor(Date.now()/1000),payload:{
   subscription:{entity:{id:subId,plan_id:'plan_StarterLive2026',
    status:'active',paid_count:1,current_start:Math.floor(Date.now()/1000)-50,current_end:Math.floor(Date.now()/1000)+86400}}}};
  async function fire(mode,secret,eventId){
   const body=JSON.stringify(event),sig=await signature(secret,body);
   return razorpayWebhook(new Request(base+'/api/billing/webhook/razorpay'+(mode==='live'?'-live':''),{
    method:'POST',headers:{'X-Razorpay-Signature':sig,'X-Razorpay-Event-Id':eventId},body}),env,mode);
  }
  assert.equal((await fire('test',env.RAZORPAY_LIVE_WEBHOOK_SECRET,'evt_testwrong')).status,503,
   'test webhook is disabled without its separate flag');
  assert.equal((await fire('live','bad-secret','evt_badlive')).status,401);
  event.payload.subscription.entity.paid_count=0;
  assert.equal((await fire('live',env.RAZORPAY_LIVE_WEBHOOK_SECRET,'evt_nocharge')).status,200);
  assert.equal((await getEntitlements(env,who.userId)).code,'free','subscription mandate without a paid cycle is not entitlement');
  event.payload.subscription.entity.paid_count=1;
  event.created_at+=1;
  assert.equal((await fire('live',env.RAZORPAY_LIVE_WEBHOOK_SECRET,'evt_livegood')).status,200);
  assert.equal((await getEntitlements(env,who.userId)).code,'starter');
  assert.equal((await fire('live',env.RAZORPAY_LIVE_WEBHOOK_SECRET,'evt_livegood')).status,200,'replay idempotent');
  const events=await DB.prepare('SELECT COUNT(*) c FROM payment_events').first();
  assert.equal(events.c,2);
 }finally{globalThis.fetch=original;DB.sql.close();}
});

test('definitive provider rejection releases slot without creating duplicate recurring mandates',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),previous=globalThis.fetch;
 globalThis.fetch=async(url)=>{
  if(String(url).includes('/plans/'))
   return Response.json({id:'plan_StarterLive2026',period:'monthly',interval:1,
    item:{amount:79900,currency:'INR'}});
  return new Response('Bad request',{status:400});
 };
 try{
  const response=await send(env,who,'/api/billing/live/create','POST',{plan_code:'starter'});
  assert.equal(response.status,502);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM live_billing_slots').first()).c,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM billing_creation_locks').first()).c,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) c FROM user_subscriptions').first()).c,0);
 }finally{globalThis.fetch=previous;DB.sql.close();}
});

test('interrupted live payment resumes the ORIGINAL mandate, not a duplicate subscription, and unfinished checkout can be cancelled',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),original=globalThis.fetch;
 const id='sub_ResumablePilot123',url='https://rzp.io/rzp/unfinishedpilot';
 let creates=0,cancelled=false;
 globalThis.fetch=async(target,options)=>{
  const path=String(target);
  if(path.endsWith('plans/plan_StarterLive2026'))
   return Response.json({id:'plan_StarterLive2026',period:'monthly',interval:1,
    item:{amount:79900,currency:'INR'}});
  if(path.endsWith('/subscriptions')&&options.method==='POST'){
   creates++;
   return Response.json({id,plan_id:'plan_StarterLive2026',status:'created',short_url:url});
  }
  if(path.endsWith('/subscriptions/'+id+'/cancel')){
   assert.equal(JSON.parse(options.body).cancel_at_cycle_end,false,
    'unfinished mandate cancelled immediately, not at a paid period end');
   cancelled=true;
   return Response.json({id,plan_id:'plan_StarterLive2026',status:'cancelled'});
  }
  if(path.endsWith('/subscriptions/'+id))
   return Response.json({id,plan_id:'plan_StarterLive2026',
    status:cancelled?'cancelled':'created',short_url:url,paid_count:0});
  throw Error('Unexpected Razorpay URL: '+path);
 };
 try{
  const opened=await send(env,who,'/api/billing/live/create','POST',{plan_code:'starter'});
  assert.equal(opened.status,201,await opened.clone().text());
  assert.equal((await opened.json()).checkout_url,url);
  const resumed=await send(env,who,'/api/billing/live/resume','POST',{});
  assert.equal(resumed.status,200,await resumed.clone().text());
  assert.equal((await resumed.json()).checkout_url,url);
  assert.equal(creates,1,'recovery MUST NOT create a second Razorpay recurring mandate');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM billing_creation_locks').first()).n,0,
   'successful durable mandate setup must not leave a stale 30-minute creation lock');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM live_billing_slots').first()).n,1);
  const cancelledRes=await send(env,who,'/api/billing/live/cancel','POST',{});
  assert.equal(cancelledRes.status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM live_billing_slots').first()).n,0);
  assert.equal((await DB.prepare('SELECT status FROM user_subscriptions WHERE user_id=?')
   .bind(who.userId).first()).status,'cancelled');
  assert.equal((await send(env,who,'/api/billing/live/resume','POST',{})).status,409);
 }finally{globalThis.fetch=original;DB.sql.close();}
});

test('live checkout cannot leak a pilot slot when a stale billing creation lock rejects a new mandate',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),original=globalThis.fetch;
 try{
  const t=Date.now();
  await DB.prepare('INSERT INTO billing_creation_locks(user_id,nonce,locked_until,created_at) VALUES(?,?,?,?)')
   .bind(who.userId,crypto.randomUUID(),t+600000,t).run();
  globalThis.fetch=async(target)=>{
   assert.ok(String(target).endsWith('plans/plan_StarterLive2026'),
    'the live mandate creation POST must never occur after a locked checkout');
   return Response.json({id:'plan_StarterLive2026',period:'monthly',interval:1,
    item:{amount:79900,currency:'INR'}});
  };
  const blocked=await send(env,who,'/api/billing/live/create','POST',{plan_code:'starter'});
  assert.equal(blocked.status,409);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM live_billing_slots').first()).n,0,
   'an unsuccessful checkout MUST NOT permanently block the only paid pilot slot');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM user_subscriptions').first()).n,0);
 }finally{globalThis.fetch=original;DB.sql.close();}
});

test('signed live activation upgrades old Free monitor to hourly schedule; cancellation downgrades without drifting on duplicate events',async()=>{
 const DB=makeDb(),who=await account(DB),env=setupEnv(DB),t=Date.now();
 const monitorId=crypto.randomUUID(),subId='sub_CadencePilot123';
 try{
  await DB.prepare(`INSERT INTO monitors(id,user_id,name,webhook_ciphertext,secret_hash,
   verified_at,state,health,interval_seconds,schedule_interval_seconds,next_due,created_at,updated_at)
   VALUES(?,?,?,?,?,?,'active','healthy',21600,21600,?,?,?)`)
   .bind(monitorId,who.userId,'Previously free monitor','encrypted','hashed',t-100000,
    t+4*3600000,t-200000,t).run();
  await DB.prepare(`INSERT INTO user_subscriptions(id,user_id,plan_code,provider,provider_subscription_id,
    status,current_period_end,created_at,updated_at,billing_mode)
    VALUES(?,?,'starter','razorpay',?,'pending',?,?,?,'live')`)
   .bind(crypto.randomUUID(),who.userId,subId,t+86400000,t,t).run();
  let seq=0;
  async function post(kind,entityStatus,paidCount=1){
   seq++;
   const entity={id:subId,plan_id:'plan_StarterLive2026',status:entityStatus,paid_count:paidCount,
    current_start:Math.floor(t/1000)-100,current_end:Math.floor(t/1000)+86400};
   const body=JSON.stringify({event:kind,created_at:Math.floor(t/1000)+seq,payload:{subscription:{entity}}});
   const sig=await signature(env.RAZORPAY_LIVE_WEBHOOK_SECRET,body);
   return razorpayWebhook(new Request(base+'/api/billing/webhook/razorpay-live',{
    method:'POST',headers:{'X-Razorpay-Signature':sig,'X-Razorpay-Event-Id':'evt_cadence_'+seq},
    body}),env,'live');
  }
  assert.equal((await post('subscription.activated','active')).status,200);
  const upgraded=await DB.prepare('SELECT schedule_interval_seconds,next_due FROM monitors WHERE id=?')
   .bind(monitorId).first();
  assert.equal(upgraded.schedule_interval_seconds,3600);
  assert.ok(upgraded.next_due<=Date.now()+3600000+2000);
  assert.equal((await post('subscription.charged','active')).status,200);
  assert.equal((await DB.prepare('SELECT next_due FROM monitors WHERE id=?')
   .bind(monitorId).first()).next_due,upgraded.next_due,
   'an additional paid webhook must not keep moving an already-aligned next due');
  assert.equal((await post('subscription.cancelled','cancelled')).status,200);
  const downgraded=await DB.prepare('SELECT schedule_interval_seconds,next_due FROM monitors WHERE id=?')
   .bind(monitorId).first();
  assert.equal(downgraded.schedule_interval_seconds,21600);
  assert.ok(downgraded.next_due>=Date.now()+21600000-2000,
   'no extra hourly checks after cancellation');
  assert.equal((await getEntitlements(env,who.userId)).code,'free');
 }finally{DB.sql.close();}
});

test('private live payment pilot is unavailable to the public and blocks other signed-in accounts',async()=>{
 const DB=makeDb(),owner=await account(DB),outsider=await account(DB),env=setupEnv(DB);
 env.LIVE_PILOT_USER_ID=owner.userId;
 try{
  const publicPrice=await handleApi(new Request(base+'/api/public/billing'),env,ctx);
  assert.equal(publicPrice.status,200);
  assert.equal((await publicPrice.json()).starter_pilot_available,false,
   'an internal one-account pilot must not advertise open purchase to the public');
  const ownerOverview=await send(env,owner,'/api/billing');
  assert.equal((await ownerOverview.json()).checkout_enabled,true,
   'the designated pilot account can see the real paid checkout');
  const outsiderOverview=await send(env,outsider,'/api/billing');
  assert.equal((await outsiderOverview.json()).checkout_enabled,false);
  assert.equal((await send(env,outsider,'/api/billing/live/create','POST',{plan_code:'starter'})).status,403);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS total FROM live_billing_slots').first()).total,0);
 }finally{DB.sql.close();}
});
