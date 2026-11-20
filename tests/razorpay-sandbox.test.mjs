import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../.test-build/api.js';
import {sha256,newRandomString} from '../worker/security.mjs';

function db(){
 const sql=new DatabaseSync(':memory:');
 for(const p of ['0001_init.sql','0002_webhook_ownership.sql','0005_subscription_foundation.sql','0006_test_checkout_locks.sql'])
  sql.exec(fs.readFileSync(new URL('../db/migrations/'+p,import.meta.url),'utf8'));
 return {sql,prepare(query){return {query,args:[],bind(...args){this.args=args;return this;},
 async first(){return sql.prepare(this.query).get(...this.args)||null;},
 async all(){return {results:sql.prepare(this.query).all(...this.args),success:true};},
 async run(){const r=sql.prepare(this.query).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}};}};
}
const base='https://leadpath.example',ctx={waitUntil(){}};
async function setup(){
 const DB=db(),userId=crypto.randomUUID(),token=newRandomString(),csrf='csrf-'+crypto.randomUUID(),t=Date.now();
 await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)')
 .bind(userId,'owner@example.test','Owner',t,t).run();
 await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
 .bind(await sha256(token),userId,csrf,t+3600000,t).run();
 const env={DB,BASE_URL:base,
  RAZORPAY_SANDBOX_ENABLED:'true',RAZORPAY_TEST_KEY_ID:'rzp_test_sample_id',
  RAZORPAY_TEST_KEY_SECRET:'only-for-mocked-tests',
  RAZORPAY_TEST_STARTER_PLAN_ID:'plan_StarterTest2026',RAZORPAY_TEST_PRO_PLAN_ID:'plan_ProTest2026'};
 const send=(path,method='GET',payload,overrides={})=>handleApi(new Request(base+path,{method,headers:{
  Origin:base,cookie:'__Host-lp_session='+token,'Content-Type':'application/json','X-CSRF-Token':csrf,...overrides},
  body:payload===undefined?undefined:JSON.stringify(payload)}),env,ctx);
 return {DB,userId,env,send,csrf,token};
}
async function makeSig(secret,message){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message))),v=>v.toString(16).padStart(2,'0')).join('');
}
test('sandbox routes refuse live credentials, unconfigured deployments and invalid/forged requests',async()=>{
 const {DB,env,userId,send}=await setup();
 try {
  const path='/api/billing/sandbox/create';
  assert.equal((await send(path,'POST',{plan_code:'starter'},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await send(path,'POST',{plan_code:'unknown'})).status,400);
  assert.equal((await handleApi(new Request(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{"plan_code":"starter"}'}),env,ctx)).status,401);
  for (const override of [{RAZORPAY_SANDBOX_ENABLED:'false'},{RAZORPAY_TEST_KEY_ID:'rzp_live_DO_NOT_USE'}]) {
   const untrusted={...env,...override};
   const re=await import('../.test-build/razorpay-test.js');
   assert.equal((await re.sandboxCreateSubscription(untrusted,userId,new Request(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"plan_code":"starter"}'}))).status,503);
   assert.equal((await re.sandboxCancelSubscription(untrusted,userId)).status,503);
  }
 } finally{DB.sql.close();}
});
test('test-only provider creation verifies INR price, binds subscription to authenticated owner and deduplicates requests',async()=>{
 const {DB,userId,env,send}=await setup();
 const originalFetch=globalThis.fetch,seen=[];
 globalThis.fetch=async(url,options)=>{
  assert.ok(String(url).startsWith('https://api.razorpay.com/v1/'));
  assert.equal(options.redirect,'manual','Workers must not use unsupported redirect:error or forward credentials');
  assert.equal(options.headers.Authorization,'Basic '+btoa(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET));
  seen.push(String(url));
  if(String(url).endsWith('plans/plan_StarterTest2026'))return Response.json({
   id:'plan_StarterTest2026',period:'monthly',interval:1,item:{amount:79900,currency:'INR'}});
  if(String(url).endsWith('/subscriptions')&&options.method==='POST'){
   const body=JSON.parse(options.body);
   assert.equal(body.plan_id,'plan_StarterTest2026');assert.equal(body.quantity,1);
   assert.equal(body.total_count,12);assert.equal(body.customer_notify,false);
   return Response.json({id:'sub_SandboxTest2026',plan_id:body.plan_id,
    status:'created',short_url:'https://rzp.io/rzp/sandboxtest'});}
  if(String(url).endsWith('/subscriptions/sub_SandboxTest2026/cancel')){
   assert.equal(JSON.parse(options.body).cancel_at_cycle_end,true);
   return Response.json({id:'sub_SandboxTest2026',status:'active'});
  }
  throw Error('Unexpected provider endpoint '+url);
 };
 try {
  const response=await send('/api/billing/sandbox/create','POST',{plan_code:'starter'});
  assert.equal(response.status,201,await response.clone().text());
  const body=await response.json();
  assert.equal(body.mode,'test');assert.equal(body.checkout_url,'https://rzp.io/rzp/sandboxtest');
  assert.equal((await DB.prepare('SELECT user_id,status,plan_code FROM user_subscriptions WHERE provider_subscription_id=?')
   .bind('sub_SandboxTest2026').first()).user_id,userId);
  assert.equal((await send('/api/billing/sandbox/create','POST',{plan_code:'pro'})).status,409);
  const denied=await send('/api/billing/sandbox/verify','POST',{razorpay_payment_id:'pay_test123',
   razorpay_subscription_id:'sub_SandboxTest2026',razorpay_signature:'0'.repeat(64)});
  assert.equal(denied.status,401);
  const verified=await send('/api/billing/sandbox/verify','POST',{razorpay_payment_id:'pay_test123',
   razorpay_subscription_id:'sub_SandboxTest2026',
   razorpay_signature:await makeSig(env.RAZORPAY_TEST_KEY_SECRET,'pay_test123|sub_SandboxTest2026')});
  assert.equal(verified.status,200);
  assert.equal((await verified.json()).entitlements_activated,false);
  const cancel=await send('/api/billing/sandbox/cancel','POST',{});
  assert.equal(cancel.status,200);
  assert.equal((await DB.prepare('SELECT status FROM user_subscriptions WHERE provider_subscription_id=?')
    .bind('sub_SandboxTest2026').first()).status,'pending','provider confirmation must be verified separately');
  assert.equal(seen.length,3);
 } finally{globalThis.fetch=originalFetch;DB.sql.close();}
});
test('sandbox rejects mismatched Razorpay plan amount and never creates a subscription',async()=>{
 const {DB,env,send}=await setup(),originalFetch=globalThis.fetch;
 const visited=[];
 globalThis.fetch=async(url,options)=>{
  visited.push(String(url));
  assert.equal(options.method,'GET');
  return Response.json({id:'plan_StarterTest2026',period:'monthly',interval:1,item:{amount:109900,currency:'INR'}});
 };
 try {
  const result=await send('/api/billing/sandbox/create','POST',{plan_code:'starter'});
  assert.equal(result.status,503);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM user_subscriptions').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM billing_creation_locks').first()).n,0,
   'invalid plans must not hold a 30-minute checkout lock');
  assert.equal(visited.length,1,'price mismatch fails before payment initiation');
 } finally{globalThis.fetch=originalFetch;DB.sql.close();}
});

test('Razorpay TEST plan lookup exposes only safe HTTP diagnostic and leaves no lock',async()=>{
 for(const [status,fragment] of [[401,'HTTP 401'],[403,'HTTP 403'],[404,'HTTP 404'],[429,'HTTP 429'],[500,'HTTP 500']]){
  const {DB,send}=await setup(),originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('Private Razorpay error body', {status});
  try{
   const response=await send('/api/billing/sandbox/create','POST',{plan_code:'starter'});
   const payload=await response.json();
   assert.equal(response.status,status===429?503:502);
   assert.ok(payload.error.includes(fragment));
   assert.ok(!JSON.stringify(payload).includes('Private Razorpay'));
   assert.equal((await DB.prepare('SELECT COUNT(*) n FROM billing_creation_locks').first()).n,0);
  }finally{globalThis.fetch=originalFetch;DB.sql.close();}
 }
});

test('sandbox refuses Razorpay redirects and does not create a subscription or lock',async()=>{
 const {DB,send}=await setup(),originalFetch=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async(_url,options)=>{
  assert.equal(options.redirect,'manual');
  calls++;
  return new Response(null,{status:302,headers:{Location:'https://attacker.example/collect'}});
 };
 try{
  const response=await send('/api/billing/sandbox/create','POST',{plan_code:'starter'});
  assert.equal(response.status,502);
  assert.equal(calls,1,'redirect cannot cause a second API request or credential forwarding');
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM billing_creation_locks').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) n FROM user_subscriptions').first()).n,0);
 }finally{globalThis.fetch=originalFetch;DB.sql.close();}
});
