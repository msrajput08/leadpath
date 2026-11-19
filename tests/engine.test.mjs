import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../.test-build/api.js';
import {confirmCallback,sweepTimedOut,scheduled,runMonitor} from '../.test-build/engine.js';
import {sha256,newRandomString,encryptSecret} from '../worker/security.mjs';
function makeDb(){
 const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('../db/migrations/0001_init.sql',import.meta.url),'utf8'));
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
  const before=await DB.prepare('SELECT state,trigger_accepted_at FROM runs WHERE id=?').bind(result.run_id).first();
  assert.equal(before.state,'pending','HTTP 200 alone never means delivered');
  assert.ok(before.trigger_accepted_at);
  const wrong=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id},'0'.repeat(64)),env,id,ctx);
  assert.equal(wrong.status,401);
  const confirm=await confirmCallback(http(base+`/api/callback/${id}`,'POST',{run_id:result.run_id},secret),env,id,ctx);
  assert.equal(confirm.status,200);
  assert.equal((await confirm.json()).delivery,'destination_confirmed');
  assert.equal((await DB.prepare('SELECT state FROM runs WHERE id=?').bind(result.run_id).first()).state,'confirmed');
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
  await assert.rejects(DB.prepare("INSERT INTO monitors (id,user_id,name,webhook_ciphertext,secret_hash,state,health,interval_seconds,next_due,created_at,updated_at) VALUES(?,?,?,?,?,'active','configuration_required',21600,?,?,?)").bind(crypto.randomUUID(),uid,'Second','cipher','hash',t,t,t).run(),/UNIQUE/);
 }finally{globalThis.fetch=originalFetch;DB.sql.close();}
});
