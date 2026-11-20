import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
 passwordSignUp,passwordVerifyEmail,passwordLogin,passwordForgot,passwordReset,passwordResend,
 hashPassword,verifyPassword,passwordAuthConfigured
} from '../.test-build/password-auth.js';

function createDatabase(){
 const raw=new DatabaseSync(':memory:');
 for(const migration of ['0001_init.sql','0002_webhook_ownership.sql','0003_email_otp.sql','0004_password_auth.sql']){
  raw.exec(fs.readFileSync(new URL('../db/migrations/'+migration,import.meta.url),'utf8'));
 }
 return {
  raw,
  prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},
   async first(){return raw.prepare(this.sql).get(...this.args)||null;},
   async all(){return{results:raw.prepare(this.sql).all(...this.args),success:true};},
   async run(){const result=raw.prepare(this.sql).run(...this.args);return{success:true,meta:{changes:Number(result.changes)}};}
  };},
  async batch(statements){raw.exec('BEGIN');try{
   const out=[];for(const statement of statements)out.push(await statement.run());
   raw.exec('COMMIT');return out;
  }catch(error){raw.exec('ROLLBACK');throw error;}}
 };
}
const base='https://leadpath.example';
const post=(path,body,origin=base)=>new Request(base+path,{
 method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)
});
const envFor=DB=>({BASE_URL:base,DB,BREVO_API_KEY:'test-api-secret',BREVO_SENDER_EMAIL:'verified@example.test',BREVO_SENDER_NAME:'LeadPath'});
const extractToken=(message,path)=>new URL(message.match(new RegExp('https://leadpath\\.example/'+path+'\\?token=[a-f0-9]{64}'))[0]).searchParams.get('token');

test('PBKDF2 hashes are salted, non-reversible and password-specific',async()=>{
 const one=await hashPassword('this is a secure password');
 const two=await hashPassword('this is a secure password');
 assert.notEqual(one,two);
 assert.match(one,/^pbkdf2_sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
 assert.ok(await verifyPassword('this is a secure password',one));
 assert.equal(await verifyPassword('incorrect password',one),false);
 assert.equal(await verifyPassword('this is a secure password','not-a-hash'),false);
});

test('complete Brevo signup, single-use verification, password login, reset and logout-all',async()=>{
 const DB=createDatabase(),env=envFor(DB);
 const original=globalThis.fetch,mail=[];
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://api.brevo.com/v3/smtp/email');
  assert.equal(options.headers['api-key'],'test-api-secret');
  const body=JSON.parse(options.body);
  assert.equal(body.sender.email,'verified@example.test');
  mail.push(body);
  return Response.json({messageId:'mock-delivery'});
 };
 try{
  assert.equal(passwordAuthConfigured(env),true);
  const signup=await passwordSignUp(post('/auth/password/signup',{name:'Test User',email:' TEST@EXAMPLE.TEST ',password:'secure-test-password-123'}),env);
  assert.equal(signup.status,200);
  const account=await DB.prepare('SELECT * FROM password_accounts').first();
  assert.equal(account.email,'test@example.test');
  assert.equal(account.verified_at,null);
  assert.equal(account.password_hash.includes('secure-test-password-123'),false);
  assert.equal(mail.length,1);
  assert.match(mail[0].subject,/Verify/);
  assert.equal((await passwordLogin(post('/auth/password/login',{email:'test@example.test',password:'secure-test-password-123'}),env)).status,401,'unverified accounts cannot sign in');
  const verifyToken=extractToken(mail[0].textContent,'verify-email');
  assert.equal((await passwordVerifyEmail(post('/auth/password/verify',{token:'a'.repeat(64)}),env)).status,400);
  assert.equal((await passwordVerifyEmail(post('/auth/password/verify',{token:verifyToken}),env)).status,200);
  assert.equal((await passwordVerifyEmail(post('/auth/password/verify',{token:verifyToken}),env)).status,400,'link is single use');
  assert.equal((await DB.prepare('SELECT verified_at FROM password_accounts').first()).verified_at>0,true);
  assert.equal((await passwordLogin(post('/auth/password/login',{email:'test@example.test',password:'not-the-password'}),env)).status,401);
  const login=await passwordLogin(post('/auth/password/login',{email:'test@example.test',password:'secure-test-password-123'}),env);
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/__Host-lp_session=/);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n,1);
  // Avoid the 60-second resend gate in this explicit reset-flow test.
  await DB.prepare('UPDATE password_mail_limits SET last_sent=0').run();
  assert.equal((await passwordForgot(post('/auth/password/forgot',{email:'unknown@example.test'}),env)).status,200);
  assert.equal(mail.length,1,'unknown email must not receive messages');
  assert.equal((await passwordForgot(post('/auth/password/forgot',{email:'test@example.test'}),env)).status,200);
  assert.equal(mail.length,2);
  assert.match(mail[1].subject,/Reset/);
  const resetToken=extractToken(mail[1].textContent,'reset-password');
  assert.equal((await passwordReset(post('/auth/password/reset',{token:resetToken,password:'new-password-example-456'}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n,0,'reset must invalidate old sessions');
  assert.equal((await passwordReset(post('/auth/password/reset',{token:resetToken,password:'replay-password-example'}),env)).status,400);
  assert.equal((await passwordLogin(post('/auth/password/login',{email:'test@example.test',password:'secure-test-password-123'}),env)).status,401);
  assert.equal((await passwordLogin(post('/auth/password/login',{email:'test@example.test',password:'new-password-example-456'}),env)).status,200);
  assert.equal((await passwordSignUp(post('/auth/password/signup',{name:'Another',email:'test@example.test',password:'duplicate-password-123'}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM password_accounts').first()).n,1,'duplicate signup must not create an account');
  assert.equal((await passwordForgot(post('/auth/password/forgot',{email:'test@example.test'},'https://evil.example'),env)).status,403);
 }finally{globalThis.fetch=original;DB.raw.close();}
});

test('resend, email delivery failure and separate identities are handled safely',async()=>{
 const DB=createDatabase(),env=envFor(DB),original=globalThis.fetch;
 let work=false,messages=0;
 globalThis.fetch=async()=>{
  messages++;
  return work?Response.json({messageId:'ok'}):new Response('Sender unverified',{status:400});
 };
 try{
  const p={name:'Example',email:'same@example.test',password:'long-password-12345'};
  const oauthId=crypto.randomUUID(),t=Date.now();
  await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)')
   .bind(oauthId,p.email,'OAuth User',t,t).run();
  await DB.prepare('INSERT INTO oauth_identities(provider,provider_user_id,user_id) VALUES(?,?,?)')
   .bind('google','google-identity',oauthId).run();
  assert.equal((await passwordSignUp(post('/auth/password/signup',p),env)).status,503);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM password_tokens').first()).n,0,'failed mail leaves no usable token');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n,2);
  assert.notEqual((await DB.prepare('SELECT user_id FROM password_accounts').first()).user_id,oauthId,'must not auto-link OAuth identity by email');
  work=true;
  // Same address may request a new verification only after cooldown.
  assert.equal((await passwordResend(post('/auth/password/resend',{email:p.email}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM password_tokens').first()).n,0,'cooldown applies even after failed provider delivery');
  await DB.prepare('UPDATE password_mail_limits SET last_sent=0').run();
  assert.equal((await passwordResend(post('/auth/password/resend',{email:p.email}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM password_tokens').first()).n,1);
  assert.equal(messages,2);
 }finally{globalThis.fetch=original;DB.raw.close();}
});
