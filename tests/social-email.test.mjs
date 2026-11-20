import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {socialStart,socialCallback} from '../.test-build/social.js';
import {emailRequest,emailVerify} from '../.test-build/email-auth.js';

function makeDb(){
 const raw=new DatabaseSync(':memory:');
 for(const name of ['0001_init.sql','0002_webhook_ownership.sql','0003_email_otp.sql','0004_password_auth.sql','0005_subscription_foundation.sql']){
  raw.exec(fs.readFileSync(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
 }
 return {
  raw,
  prepare(sql){return{sql,args:[],bind(...args){this.args=args;return this;},
   async first(){return raw.prepare(this.sql).get(...this.args)||null;},
   async run(){const result=raw.prepare(this.sql).run(...this.args);return{success:true,meta:{changes:Number(result.changes)}};},
   async all(){return{results:raw.prepare(this.sql).all(...this.args),success:true};}
  }},
  async batch(statements){raw.exec('BEGIN');try{
   const out=[];for(const s of statements)out.push(await s.run());raw.exec('COMMIT');return out;
  }catch(e){raw.exec('ROLLBACK');throw e;}}
 };
}
const base='https://leadpath.example';
function post(path,body,origin=base){
 return new Request(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
}

test('Facebook: server exchange, state validation, private profile identity, no auto-linking',async()=>{
 const DB=makeDb(),env={DB,BASE_URL:base,FACEBOOK_APP_ID:'app-123',FACEBOOK_APP_SECRET:'fb-secret'};
 const start=await socialStart(env,'facebook');
 const auth=new URL(start.headers.get('location'));
 assert.equal(auth.hostname,'www.facebook.com');
 assert.equal(auth.searchParams.get('scope'),'public_profile,email');
 assert.equal(auth.searchParams.get('client_id'),'app-123');
 const state=auth.searchParams.get('state'),cookie=start.headers.get('set-cookie').split(';')[0];
 const callback=new Request(base+'/auth/facebook/callback?state='+state+'&code=authorized',{headers:{cookie}});
 const wrong=await socialCallback(new Request(base+'/auth/facebook/callback?state='+state+'&code=authorized'),env,'facebook');
 assert.equal(wrong.status,400,'callback requires matching state cookie');
 const original=globalThis.fetch;let proofSeen=false;
 globalThis.fetch=async(url,opts)=>{
  if(String(url).includes('/oauth/access_token')){
   assert.equal(opts.method,'POST');
   assert.ok(String(opts.body).includes('client_secret=fb-secret'));
   return Response.json({access_token:'meta-short-lived-token'});
  }
  if(String(url).includes('/me')){
   assert.equal(opts.headers.Authorization,'Bearer meta-short-lived-token');
   proofSeen=/^[a-f0-9]{64}$/.test(new URL(url).searchParams.get('appsecret_proof')||'');
   return Response.json({id:'fb123',name:'FB Test',email:'shared@example.test'});
  }
  throw new Error('unexpected provider request '+url);
 };
 try {
  const success=await socialCallback(callback,env,'facebook');
  assert.equal(success.status,303);
  assert.ok(proofSeen);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n,1);
  assert.equal((await DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='facebook' AND provider_user_id='fb123'").first()).user_id.length,36);
  assert.equal((await socialCallback(callback,env,'facebook')).status,400,'state must be single-use');
 }finally{globalThis.fetch=original;DB.raw.close();}
});
test('X: PKCE and Basic token exchange, creates non-email identity without guessing a verified address',async()=>{
 const DB=makeDb(),env={DB,BASE_URL:base,X_CLIENT_ID:'x-id',X_CLIENT_SECRET:'x-secret'};
 const start=await socialStart(env,'x');
 const auth=new URL(start.headers.get('location'));
 assert.equal(auth.origin,'https://x.com');
 assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
 assert.ok(auth.searchParams.get('scope').includes('users.read'));
 const state=auth.searchParams.get('state'),cookie=start.headers.get('set-cookie').split(';')[0];
 const original=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{
  if(String(url).includes('/oauth2/token')){
   assert.equal(opts.headers.Authorization,'Basic '+btoa('x-id:x-secret'));
   assert.ok(String(opts.body).includes('code_verifier='));
   return Response.json({access_token:'x-user-token'});
  }
  if(String(url).includes('/users/me')){
   assert.equal(opts.headers.Authorization,'Bearer x-user-token');
   return Response.json({data:{id:'12345',name:'X Test',username:'tester'}});
  }
  throw new Error('unexpected X endpoint');
 };
 try {
  const r=await socialCallback(new Request(base+'/auth/x/callback?state='+state+'&code=authorized',{headers:{cookie}}),env,'x');
  assert.equal(r.status,303);
  const row=await DB.prepare('SELECT email FROM users').first();
  assert.equal(row.email,'x-12345@no-email.leadpath.invalid');
  assert.equal((await DB.prepare("SELECT provider FROM oauth_identities WHERE provider='x'").first()).provider,'x');
 }finally{globalThis.fetch=original;DB.raw.close();}
});
test('Email: hashed OTP, 60-second send cooldown, wrong-code rejection and single-use login',async()=>{
 const DB=makeDb(),env={DB,BASE_URL:base,ENABLE_EMAIL_OTP:'true',EMAIL_OTP_SECRET:'e'.repeat(64),
  RESEND_API_KEY:'re_test',EMAIL_FROM_ADDRESS:'LeadPath <login@example.test>'};
 let deliveredCode='',calls=0;
 const original=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{
  assert.equal(String(url),'https://api.resend.com/emails');
  assert.equal(opts.headers.Authorization,'Bearer re_test');
  const body=JSON.parse(opts.body);deliveredCode=body.text.match(/(\d{6})/)[1];calls++;
  return Response.json({id:'email-delivered'});
 };
 try {
  const request=post('/auth/email/request',{email:' Test@Example.Test '});
  assert.equal((await emailRequest(request,env)).status,200);
  const stored=await DB.prepare('SELECT * FROM email_login_codes WHERE email=?').bind('test@example.test').first();
  assert.ok(stored);
  assert.notEqual(stored.code_hash,deliveredCode,'code must never be stored in plaintext');
  assert.equal((await emailRequest(post('/auth/email/request',{email:'test@example.test'}),env)).status,200);
  assert.equal(calls,1,'database enforces send cooldown');
  assert.equal((await emailVerify(post('/auth/email/verify',{email:'test@example.test',code:'000000'}),env)).status,400);
  const ok=await emailVerify(post('/auth/email/verify',{email:'test@example.test',code:deliveredCode}),env);
  assert.equal(ok.status,200);
  assert.match(ok.headers.get('set-cookie'),/__Host-lp_session=/);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n,1);
  assert.equal((await DB.prepare("SELECT provider_user_id FROM oauth_identities WHERE provider='email'").first()).provider_user_id,'test@example.test');
  assert.equal((await emailVerify(post('/auth/email/verify',{email:'test@example.test',code:deliveredCode}),env)).status,400,'OTP replay prevented');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM email_login_codes').first()).n,0);
  assert.equal((await emailRequest(post('/auth/email/request',{email:'test@example.test'},'https://untrusted.example'),env)).status,403);
 }finally{globalThis.fetch=original;DB.raw.close();}
});
test('Email: no service credentials means no email login; failed delivery never leaves usable code',async()=>{
 const DB=makeDb(),env={DB,BASE_URL:base,ENABLE_EMAIL_OTP:'true',EMAIL_OTP_SECRET:'a'.repeat(64),
  RESEND_API_KEY:'re_bad',EMAIL_FROM_ADDRESS:'login@example.test'};
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('service error',{status:500});
 try {
  assert.equal((await emailRequest(post('/auth/email/request',{email:'owner@example.test'}),{DB,BASE_URL:base})).status,503);
  assert.equal((await emailRequest(post('/auth/email/request',{email:'owner@example.test'}),env)).status,503);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM email_login_codes').first()).n,0);
 }finally{globalThis.fetch=original;DB.raw.close();}
});
