import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
 passwordSignUp,passwordLogin,passwordVerifyEmail,passwordForgot,passwordResend,passwordReset,passwordAuthConfigured
} from '../.test-build/password-auth.js';

const base='https://leadpath.example';
function mockDB(){
 const raw=new DatabaseSync(':memory:');
 for(const name of ['0001_init.sql','0002_webhook_ownership.sql','0003_email_otp.sql','0004_password_auth.sql']){
  raw.exec(fs.readFileSync(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
 }
 return {raw,prepare(sql){return{sql,args:[],bind(...args){this.args=args;return this;},
  async first(){return raw.prepare(this.sql).get(...this.args)||null;},
  async run(){const r=raw.prepare(this.sql).run(...this.args);return{success:true,meta:{changes:Number(r.changes)}};},
  async all(){return{results:raw.prepare(this.sql).all(...this.args),success:true};}
 }},async batch(st){raw.exec('BEGIN');try{const ret=[];for(const x of st)ret.push(await x.run());raw.exec('COMMIT');return ret;}catch(e){raw.exec('ROLLBACK');throw e;}}};
}
const envFor=DB=>({DB,BASE_URL:base,SUPABASE_URL:'https://project-test.supabase.co',SUPABASE_ANON_KEY:'test-publishable-key-example'});
const post=(path,body,origin=base)=>new Request(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const user={id:'supabase-user-123',email:'same@example.test',email_confirmed_at:'2026-11-20T12:00:00Z',user_metadata:{name:'Password User'}};
const verifyToken='a'.repeat(64),recoveryToken='b'.repeat(64);

test('free Workers password sign-up delegates costly hashing to Supabase Auth and creates no premature D1 account',async()=>{
 const DB=mockDB(),env=envFor(DB),original=globalThis.fetch;
 let requests=[];
 globalThis.fetch=async(url,options)=>{
  requests.push({url:String(url),options});
  assert.equal(options.headers.apikey,env.SUPABASE_ANON_KEY);
  return Response.json({user:{...user,email_confirmed_at:null}});
 };
 try{
  assert.equal(passwordAuthConfigured(env),true);
  assert.equal(passwordAuthConfigured({...env,SUPABASE_URL:'https://evil.example'}),false);
  assert.equal(passwordAuthConfigured({...env,SUPABASE_ANON_KEY:''}),false);
  assert.equal((await passwordSignUp(post('/auth/password/signup',{name:'Password User',email:' Same@Example.Test ',password:'secure-test-password-123'}),env)).status,200);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://project-test.supabase.co/auth/v1/signup');
  assert.equal(JSON.parse(requests[0].options.body).email,'same@example.test');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM password_accounts').first()).n,0);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n,0);
  assert.equal((await passwordSignUp(post('/auth/password/signup',{name:'Password User',email:user.email,password:'short'}),env)).status,400);
  assert.equal((await passwordSignUp(post('/auth/password/signup',{name:'Password User',email:user.email,password:'secure-test-password-123'},'https://evil.example'),env)).status,403);
 }finally{globalThis.fetch=original;DB.raw.close();}
});

test('verification -> login -> recovery -> password reset retain secure D1 sessions and OAuth isolation',async()=>{
 const DB=mockDB(),env=envFor(DB),original=globalThis.fetch;
 const t=Date.now(),oauthId=crypto.randomUUID();
 await DB.prepare('INSERT INTO users(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)')
  .bind(oauthId,user.email,'OAuth User',t,t).run();
 await DB.prepare('INSERT INTO oauth_identities(provider,provider_user_id,user_id) VALUES(?,?,?)')
  .bind('google','google-id',oauthId).run();
 let confirmed=false,reset=false,resetUsed=false,verifyUsed=false,logins=0;
 const seen=[];
 globalThis.fetch=async(url,opts)=>{
  const path=String(url).split('/auth/v1/')[1];
  seen.push({path,body:JSON.parse(opts.body),method:opts.method,authorization:opts.headers.Authorization});
  if(path==='verify'){
   if(opts.method!=='POST')throw Error('verify must POST');
   if(JSON.parse(opts.body).type==='email'){
    if(verifyUsed)return Response.json({code:'otp_expired'},{status:400});
    confirmed=true;verifyUsed=true;
    return Response.json({user,access_token:'verify-access'});
   }
   if(JSON.parse(opts.body).type==='recovery'){
    if(resetUsed)return Response.json({code:'otp_expired'},{status:400});
    resetUsed=true;return Response.json({user,access_token:'reset-access'});
   }
  }
  if(path==='token?grant_type=password'){
   const body=JSON.parse(opts.body);
   if(!confirmed||body.password===(reset?'secure-test-password-123':'new-secure-password-123'))
    return Response.json({code:'invalid_credentials'},{status:400});
   logins++;
   return Response.json({user,access_token:'login-access'});
  }
  if(path==='recover'||path==='resend')return Response.json({ok:true});
  if(path==='user'&&opts.method==='PUT'){
   assert.equal(opts.headers.Authorization,'Bearer reset-access');
   assert.equal(JSON.parse(opts.body).password,'new-secure-password-123');
   reset=true;
   return Response.json({user});
  }
  throw Error('Unexpected path '+path);
 };
 try{
  assert.equal((await passwordVerifyEmail(post('/auth/password/verify',{token:verifyToken}),env)).status,200);
  assert.equal((await passwordVerifyEmail(post('/auth/password/verify',{token:verifyToken}),env)).status,400);
  const login=await passwordLogin(post('/auth/password/login',{email:user.email,password:'secure-test-password-123'}),env);
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/__Host-lp_session=/);
  const passwordUserId=(await DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='supabase'").first()).user_id;
  assert.notEqual(passwordUserId,oauthId,'same email must not merge with Google identity');
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n,1);
  assert.equal((await passwordForgot(post('/auth/password/forgot',{email:user.email}),env)).status,200);
  assert.equal((await passwordResend(post('/auth/password/resend',{email:user.email}),env)).status,200);
  assert.equal((await passwordReset(post('/auth/password/reset',{token:recoveryToken,password:'new-secure-password-123'}),env)).status,200);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n,0);
  assert.equal((await passwordReset(post('/auth/password/reset',{token:recoveryToken,password:'new-secure-password-123'}),env)).status,400);
  assert.equal((await passwordLogin(post('/auth/password/login',{email:user.email,password:'new-secure-password-123'}),env)).status,200);
  assert.equal(logins,2);
  assert.equal(seen.filter(x=>x.path==='verify').length,4);
 }finally{globalThis.fetch=original;DB.raw.close();}
});

test('provider errors do not reveal whether a user exists',async()=>{
 const DB=mockDB(),env=envFor(DB),original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({code:'user_already_exists'},{status:400});
 try{
  assert.equal((await passwordSignUp(post('/auth/password/signup',{name:'Example User',email:'x@example.test',password:'long-password-12345'}),env)).status,200);
  assert.equal((await passwordForgot(post('/auth/password/forgot',{email:'x@example.test'}),env)).status,200);
  assert.equal((await passwordLogin(post('/auth/password/login',{email:'x@example.test',password:'long-password-12345'}),env)).status,401);
 }finally{globalThis.fetch=original;DB.raw.close();}
});
