import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../.test-build/api.js';
import {confirmCallback,sweepTimedOut,scheduled,runMonitor,runQueuedMonitor} from '../.test-build/engine.js';
import worker from '../.test-build/index.js';
import {sha256,newRandomString,encryptSecret} from '../worker/security.mjs';
function makeDb(){
 const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('../db/migrations/0001_init.sql',import.meta.url),'utf8'));
 sql.exec(fs.readFileSync(new URL('../db/migrations/0002_webhook_ownership.sql',import.meta.url),'utf8'));
 sql.exec(fs.readFileSync(new URL('../db/migrations/0005_subscription_foundation.sql',import.meta.url),'utf8'));
 sql.exec(fs.readFileSync(new URL('../db/migrations/0006_test_checkout_locks.sql',import.meta.url),'utf8'));
 sql.exec(fs.readFileSync(new URL('../db/migrations/0007_live_billing_mode.sql',import.meta.url),'utf8'));
 const db={
  prepare(s){const x={sql:s,args:[],bind(...v){this.args=v;return this;},async first(){return sql.prepare(this.sql).get(...this.args)||null;},async all(){return {results:sql.prepare(this.sql).all(...this.args),success:true};},async run(){const r=sql.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}};return x;},
  async batch(statements){sql.exec('BEGIN');try{const out=[];for(const stmt of statements)out.push(await stmt.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}},
  sql
 };return db;
}
const ctx={waitUntil(p){p.catch(()=>{});}};
function http(url,method='GET',data,token='',csrf='',cookie=''){
 const headers={Origin:'https://leadpath.example',cookie};
 if(token)headers.Authorization=`Bearer ${token}`;
 if(method!=='GET') {headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrf;}
 return new Request(url,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
}
test('local integration: account isolation, actual dispatch contract, callback, replay, timeouts and alerts',async()=>{
 const DB=makeDb();const env={DB,BASE_URL:'https://leadpath.example',WEBHOOK_ENCRYPTION_KEY:'f'.repeat(64)};
 const userId=crypto.randomUUID(),userId2=crypto.randomUUID();const current=Date.now();
 for(const [id,mail] of [[userId,'first@example.test'],[userId2,'other@example.test']]){
  await DB.prepare('INSERT INTO users (id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id,mail,'Tester',current,current).run();
 }
 const sessionToken=newRandomString(),sessionToken2=newRandomString(),csrf=newRandomString(16),csrf2=newRandomString(16);
 for (const [token,user,csrfValue] of [[sessionToken,userId,csrf],[sessionToken2,userId2,csrf2]]){
  await DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
   .bind(await sha256(token),user,csrfValue,current+600000,current).run();
 }
 const cookie=`__Host-lp_session=${sessionToken}`,cookie2=`__Host-lp_session=${sessionToken2}`;
 const base='https://leadpath.example';
 const createReq=http(base+'/api/monitors','POST',{name:'Lead funnel',webhook_url:'https://hook.eu1.make.com/AbcdEFgh123',authorized:true},'',csrf,cookie);
 const created=await handleApi(createReq,env,ctx);
 assert.equal(created.status,201);
 const payload=await created.json();
 const id=payload.monitor.id,secret=payload.callback_secret;
 assert.match(secret,/^[a-f0-9]{64}$/);
 const raw=await DB.prepare('SELECT webhook_ciphertext FROM monitors WHERE id=?').bind(id).first();
 assert.equal(raw.webhook_ciphertext.includes('https://hook'),false);
 const otherGet=await handleApi(http(base+'/api/monitors/'+id+'/runs','GET',undefined,'','',cookie2),env,ctx);
 assert.equal(otherGet.status,404,'other account cannot read monitor');
 const otherDelete=await handleApi(http(base+'/api/monitors/'+id,'DELETE',undefined,'',csrf2,cookie2),env,ctx);
 assert.equal(otherDelete.status,404,'other account cannot delete monitor');
 const extra=await handleApi(http(base+'/api/monitors','POST',{name:'Duplicate',webhook_url:'https://hook.us1.make.com/AbcdEFgh123',authorized:true},'',csrf,cookie),env,ctx);
 assert.equal(extra.status,403,'free plan one monitor');
 const csrfReject=await handleApi(http(base+'/api/monitors/'+id+'/run','POST',{},'','wrong',cookie),env,ctx);
 assert.equal(csrfReject.status,403);
 let received=null; const originalFetch=globalThis.fetch;
 globalThis.fetch=async(target,options)=>{assert.equal(target,'https://hook.eu1.make.com/AbcdEFgh123');assert.equal(options.redirect,'manual');received=JSON.parse(options.body);return new Response('Accepted',{status:200});};
 try {
  const dispatch=await handleApi(http(base+'/api/monitors/'+id+'/run','POST',{},'',csrf,cookie),env,ctx);
  assert.equal(dispatch.status,202);
  const result=await dispatch.json();
  assert.equal(result.accepted,true);
  assert.equal(received.run_id,result.run_id);
  assert.match(received.proof_code,/^[a-f0-9]{64}$/,'only real Make webhook recipient sees the proof');
  const before=await DB.prepare('SELECT state,trigger_accepted_at FROM runs WHERE id=?').bind(result.run_id).first();
  assert.equal(before.state,'pending','HTTP 200 alone never means delivered');
  assert.ok(before.trigger_accepted_at);
  const wrong=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id},'0'.repeat(64)),env,id,ctx);
  assert.equal(wrong.status,401);
  const missingProof=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id},secret),env,id,ctx);
  assert.equal(missingProof.status,403,'callback secret alone cannot prove webhook control');
  const invalidProof=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id,proof_code:'0'.repeat(64)},secret),env,id,ctx);
  assert.equal(invalidProof.status,403,'proof cannot be guessed from returned run ID');
  const confirm=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id,proof_code:received.proof_code},secret),env,id,ctx);
  assert.equal(confirm.status,200);
  assert.equal((await confirm.json()).delivery,'destination_confirmed');
  assert.equal((await DB.prepare('SELECT state FROM runs WHERE id=?').bind(result.run_id).first()).state,'confirmed');
  assert.ok((await DB.prepare('SELECT verified_at FROM monitors WHERE id=?').bind(id).first()).verified_at,'successful server-only proof persists verification');
  const replay=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id},secret),env,id,ctx);
  assert.equal((await replay.json()).already_confirmed,true);
  assert.equal((await DB.prepare('SELECT COUNT(*) as total FROM acknowledgments').first()).total,1);
  const rapid=await handleApi(http(base+'/api/monitors/'+id+'/run','POST',{},'',csrf,cookie),env,ctx);
  assert.equal(rapid.status,429,'manual cooldown enforced');
  const missing=await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(id).first();
  assert.equal(missing.health,'healthy');
  // Simulate a future failing run without waiting thirty minutes.
  for(let n=0;n<2;n++){
   const rid=crypto.randomUUID();
   await DB.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','scheduled',?,?)").bind(rid,id,current-3600000,current-1).run();
   await DB.prepare('UPDATE monitors SET last_run_id=? WHERE id=?').bind(rid,id).run();
   await sweepTimedOut(env,ctx);
  }
  assert.equal((await DB.prepare("SELECT COUNT(*) as total FROM alerts WHERE kind='failure'").first()).total,1,'one alert after repeated failures');
  assert.equal((await DB.prepare('SELECT health,failure_streak FROM monitors WHERE id=?').bind(id).first()).health,'failing');
  const recoveredId=crypto.randomUUID();
  await DB.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','manual',?,?)").bind(recoveredId,id,current-1000,current+600000).run();
  await DB.prepare('UPDATE monitors SET last_run_id=? WHERE id=?').bind(recoveredId,id).run();
  const recovered=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:recoveredId},secret),env,id,ctx);
  assert.equal(recovered.status,200);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS total FROM alerts WHERE kind='recovery'").first()).total,1);
  assert.equal((await DB.prepare('SELECT health FROM monitors WHERE id=?').bind(id).first()).health,'healthy');
  const exportRes=await handleApi(http(base+'/api/data/export','GET',undefined,'','',cookie),env,ctx);
  const exported=JSON.stringify(await exportRes.json());
  assert.equal(exported.includes(secret),false);
  assert.equal(exported.includes('hook.eu1.make.com'),false);
  const deletion=await handleApi(http(base+'/api/account','DELETE',undefined,'',csrf,cookie),env,ctx);
  assert.equal(deletion.status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) as total FROM runs').first()).total,0,'cascade account deletion erases runs');
  assert.equal((await DB.prepare('SELECT COUNT(*) as total FROM sessions WHERE user_id=?').bind(userId).first()).total,0);
 } finally {globalThis.fetch=originalFetch;DB.sql.close();}
});

test('scheduler claim is idempotent; upstream errors are not marked confirmed; paused and expired runs stay blocked',async()=>{
 const DB=makeDb(),t=Date.now(),uid=crypto.randomUUID(),mid=crypto.randomUUID(),key='8'.repeat(64),secret=newRandomString();
 const env={DB,BASE_URL:'https://leadpath.example',WEBHOOK_ENCRYPTION_KEY:key,RATE_LIMITER:{async limit(){return {success:true};}}};
 await DB.prepare('INSERT INTO users (id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').bind(uid,'x@example.invalid','X',t,t).run();
 await DB.prepare("INSERT INTO monitors (id,user_id,name,webhook_ciphertext,secret_hash,state,health,interval_seconds,next_due,created_at,updated_at) VALUES(?,?,?,?,?,'active','configuration_required',21600,?,?,?)").bind(mid,uid,'Monitor',await encryptSecret('https://hook.eu1.make.com/AbcdEFgh123',key),await sha256(secret),t-1,t,t).run();
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('No',{status:503});
 try {
  const unverified=await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(mid).first();
  const refused=await runMonitor(env,unverified,'scheduled',ctx);
  assert.equal(refused.accepted,false,'unverified monitor cannot send unattended checks');
  await scheduled(env,ctx);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS total FROM runs WHERE monitor_id=?').bind(mid).first()).total,0,'Cron must skip unverified webhooks');
  await DB.prepare('UPDATE monitors SET verified_at=? WHERE id=?').bind(t,mid).run();
  const mon=await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(mid).first();
  const first=await runMonitor(env,mon,'scheduled',ctx);
  assert.equal(first.accepted,true);
  const row=await DB.prepare('SELECT state,error_code,response_status FROM runs WHERE id=?').bind(first.run_id).first();
  assert.deepEqual([row.state,row.error_code,row.response_status],['error','HTTP_503',503]);
  const second=await runMonitor(env,mon,'scheduled',ctx);
  assert.equal(second.accepted,false,'the monitor can be claimed only once while next_due is future');
  const tooLate=await confirmCallback(http(`https://leadpath.example/api/callback/${mid}`,'POST',{run_id:first.run_id},secret),env,mid,ctx);
  assert.equal(tooLate.status,409);
  const expiredId=crypto.randomUUID();
  await DB.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','manual',?,?)").bind(expiredId,mid,t-3600000,t-1).run();
  await DB.prepare('UPDATE monitors SET last_run_id=? WHERE id=?').bind(expiredId,mid).run();
  await sweepTimedOut(env,ctx);
  assert.equal((await DB.prepare('SELECT state FROM runs WHERE id=?').bind(expiredId).first()).state,'unconfirmed');
  const old=await confirmCallback(http(`https://leadpath.example/api/callback/${mid}`,'POST',{run_id:expiredId},secret),env,mid,ctx);
  assert.equal(old.status,409);
  await DB.prepare("UPDATE monitors SET state='paused',health='paused' WHERE id=?").bind(mid).run();
  const paused=await runMonitor(env,await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(mid).first(),'manual',ctx);
  assert.equal(paused.accepted,false);
  // A callback for an in-flight run may still arrive after an operator pauses monitoring.
  const pausedRunId=crypto.randomUUID();
  await DB.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','manual',?,?)").bind(pausedRunId,mid,t,t+600000).run();
  await DB.prepare("UPDATE monitors SET last_run_id=? WHERE id=?").bind(pausedRunId,mid).run();
  const pausedCallback=await confirmCallback(http(`https://leadpath.example/api/callback/${mid}`,'POST',{run_id:pausedRunId},secret),env,mid,ctx);
  assert.equal(pausedCallback.status,200);
  assert.equal((await DB.prepare('SELECT health FROM monitors WHERE id=?').bind(mid).first()).health,'paused','late confirmation must not resume a paused monitor');
  const pausedExpiredId=crypto.randomUUID();
  await DB.prepare("INSERT INTO runs(id,monitor_id,state,source,created_at,expires_at) VALUES(?,?,'pending','manual',?,?)").bind(pausedExpiredId,mid,t-3600000,t-1).run();
  await DB.prepare('UPDATE monitors SET last_run_id=? WHERE id=?').bind(pausedExpiredId,mid).run();
  await sweepTimedOut(env,ctx);
  assert.equal((await DB.prepare('SELECT state FROM runs WHERE id=?').bind(pausedExpiredId).first()).state,'unconfirmed');
  assert.equal((await DB.prepare('SELECT health FROM monitors WHERE id=?').bind(mid).first()).health,'paused','late timeout must not resume a paused monitor');
  // Migration removes the old physical single-monitor index; central entitlements
  // must still prevent Free users from exercising additional monitors.
  const extraId=crypto.randomUUID();
  await DB.prepare("INSERT INTO monitors (id,user_id,name,webhook_ciphertext,secret_hash,state,health,interval_seconds,next_due,created_at,updated_at) VALUES(?,?,?,?,?,'active','configuration_required',21600,?,?,?)").bind(extraId,uid,'Second','cipher','hash',t,t+1,t+1).run();
  const denied=await runMonitor(env,await DB.prepare('SELECT * FROM monitors WHERE id=?').bind(extraId).first(),'manual',ctx);
  assert.equal(denied.accepted,false,'Free over-limit monitor cannot send a manual check');
 }finally{globalThis.fetch=originalFetch;DB.sql.close();}
});

test('paid cron excludes over-quota free monitors before LIMIT and leaves capacity for other accounts',async()=>{
 const DB=makeDb(),time=Date.now();
 const freeId=crypto.randomUUID(),paidId=crypto.randomUUID();
 const env={DB,BASE_URL:'https://leadpath.example',PAID_ENTITLEMENTS_ENABLED:'true',SCHEDULE_BATCH_LIMIT:'3'};
 try{
  for(const [user,mail] of [[freeId,'freepilot@example.test'],[paidId,'paidpilot@example.test']])
   await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)')
    .bind(user,mail,'Pilot',time,time).run();
  // Existing over-quota rows can occur after a downgrade; only the oldest Free
  // monitor must compete with the three paid monitors in each cron SQL batch.
  for(const [user,count] of [[freeId,6],[paidId,3]]){
   for(let i=0;i<count;i++){
    const due=time-(user===freeId?100000:20000)+i;
    await DB.prepare(`INSERT INTO monitors
     (id,user_id,name,webhook_ciphertext,secret_hash,verified_at,state,health,interval_seconds,next_due,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'active','healthy',21600,?,?,?)`)
     .bind(crypto.randomUUID(),user,'Mon '+i,'encrypted-secret','hash',time-200000,due,time-100000+i,time).run();
   }
  }
  await DB.prepare(`INSERT INTO user_subscriptions(id,user_id,plan_code,provider,provider_subscription_id,
    status,current_period_end,created_at,updated_at,billing_mode)
    VALUES(?,?,'starter','razorpay',?,'active',?,?,?,'live')`)
   .bind(crypto.randomUUID(),paidId,'sub_RealPaidPilot123',time+86400000,time,time).run();
  await scheduled(env,ctx);
  const free=await DB.prepare(`SELECT COUNT(*) n FROM runs r JOIN monitors m ON m.id=r.monitor_id
   WHERE m.user_id=?`).bind(freeId).first();
  const paid=await DB.prepare(`SELECT COUNT(*) n FROM runs r JOIN monitors m ON m.id=r.monitor_id
   WHERE m.user_id=?`).bind(paidId).first();
  assert.equal(free.n,1,'only oldest over-quota Free monitor is considered');
  assert.equal(paid.n,2,'remaining cron capacity is available to paid account');
 }finally{DB.sql.close();}
});

test('Cloudflare Free Queue dispatch is idempotent, keeps callback secrets out of messages, and isolates expiry sweeps',async()=>{
 const DB=makeDb(),time=Date.now(),userId=crypto.randomUUID(),monitorId=crypto.randomUUID();
 const url='https://hook.eu1.make.com/FreeQueuePilot123';
 const secretKey='b'.repeat(64),encrypted=await encryptSecret(url,secretKey);
 const queueMessages=[],env={DB,BASE_URL:'https://leadpath.example',WEBHOOK_ENCRYPTION_KEY:secretKey,
  MONITOR_QUEUE:{async sendBatch(messages){queueMessages.push(...messages);}}};
 const oldFetch=globalThis.fetch;let dispatched=0;
 try{
  await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)')
   .bind(userId,'queue-user@example.test','Queue User',time,time).run();
  await DB.prepare(`INSERT INTO monitors(id,user_id,name,webhook_ciphertext,secret_hash,
    verified_at,state,health,interval_seconds,next_due,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'active','healthy',21600,?,?,?)`)
   .bind(monitorId,userId,'Free queue test',encrypted,'dummy-hash',time-86400000,time-1000,time-86400000,time).run();
  await scheduled(env,ctx);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM runs').first()).n,0,
   'Cron publishes IDs without sending Make payload directly');
  assert.equal(queueMessages.length,2,'one due monitor plus one timeout-sweep job');
  assert.deepEqual(queueMessages[0].body,{monitor_id:monitorId,enqueued_at:queueMessages[0].body.enqueued_at});
  assert.equal(queueMessages[1].body.kind,'sweep');
  assert.equal(JSON.stringify(queueMessages).includes(url),false,'queued job must not leak Make webhook URL');
  assert.equal(JSON.stringify(queueMessages).includes(encrypted),false,'queued job must not leak encrypted webhook');
  globalThis.fetch=async(target,options)=>{
   assert.equal(target,url);assert.equal(options.redirect,'manual');dispatched++;
   return new Response('accepted',{status:200});
  };
  const acks={ack:0,retry:0};
  const message={body:queueMessages[0].body,ack(){acks.ack++;},retry(){acks.retry++;}};
  await worker.queue({queue:'leadpath-monitor-jobs',messages:[message]},env,ctx);
  assert.equal(acks.ack,1);assert.equal(acks.retry,0);
  assert.equal(dispatched,1);
  await runQueuedMonitor(env,queueMessages[0].body,ctx);
  assert.equal(dispatched,1,'at-least-once message replays cannot trigger a second Make dispatch');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM runs').first()).n,1);
  await DB.prepare('UPDATE runs SET expires_at=? WHERE monitor_id=?').bind(Date.now()-1,monitorId).run();
  await runQueuedMonitor(env,queueMessages[1].body,ctx);
  assert.equal((await DB.prepare('SELECT state FROM runs WHERE monitor_id=?').bind(monitorId).first()).state,'unconfirmed',
   'separate bounded timeout sweep processes expired run');
  const unexpected={body:{monitor_id:monitorId},ack(){throw Error('Unexpected ack');},retry(){acks.retry++;}};
  await worker.queue({queue:'wrong-queue',messages:[unexpected]},env,ctx);
  assert.equal(acks.retry,1,'unexpected queue must never process a monitoring job');
 }finally{globalThis.fetch=oldFetch;DB.sql.close();}
});
