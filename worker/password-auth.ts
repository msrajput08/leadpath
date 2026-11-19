import type { Env } from './types.js';
import { audit, fail, json, mustBeSameOrigin, now, readBoundedJson } from './util.js';
import { constantTimeEqual, newRandomString, secureCookie, sha256 } from './security.mjs';

const encoder = new TextEncoder();
const ITERATIONS = 600000;
const genericMail = () => json({ok:true,message:'If the email is eligible, a secure link will be sent.'});
const authFailed = () => fail(401,'Invalid credentials or email not verified.');
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const local = (env:Env) => {
 const url=new URL(env.BASE_URL);
 return url.protocol==='http:' && url.hostname==='localhost';
};
export const passwordAuthConfigured=(env:Env)=>Boolean(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL);

function normalizeEmail(value:unknown):string|null {
 if(typeof value!=='string') return null;
 const email=value.trim().toLowerCase();
 return email.length>=3 && email.length<=254 && emailPattern.test(email) ? email : null;
}
function validPassword(value:unknown):value is string {
 return typeof value==='string' && value.length>=12 && value.length<=128 && encoder.encode(value).length<=512;
}
function hex(arr:Uint8Array):string {
 return Array.from(arr,b=>b.toString(16).padStart(2,'0')).join('');
}
function fromHex(s:string):Uint8Array {
 return Uint8Array.from(s.match(/../g)!.map(h=>parseInt(h,16)));
}
async function pbkdf(password:string,salt:Uint8Array,iterations:number):Promise<string> {
 const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 const safeSalt=new Uint8Array(new ArrayBuffer(salt.byteLength));
 safeSalt.set(salt);
 const derived=await crypto.subtle.deriveBits({name:'PBKDF2',salt:safeSalt,iterations,hash:'SHA-256'},key,256);
 return hex(new Uint8Array(derived));
}
export async function hashPassword(password:string):Promise<string> {
 if(!validPassword(password)) throw new Error('Invalid password');
 const salt=crypto.getRandomValues(new Uint8Array(16));
 const digest=await pbkdf(password,salt,ITERATIONS);
 return 'pbkdf2_sha256$'+ITERATIONS+'$'+hex(salt)+'$'+digest;
}
export async function verifyPassword(password:string,stored:string):Promise<boolean> {
 if(typeof password!=='string'||encoder.encode(password).length>512) return false;
 const fields=stored.split('$');
 if(fields.length!==4||fields[0]!=='pbkdf2_sha256'||fields[1]!==String(ITERATIONS)||
    !/^[a-f0-9]{32}$/.test(fields[2])||!/^[a-f0-9]{64}$/.test(fields[3]))return false;
 const actual=await pbkdf(password,fromHex(fields[2]),ITERATIONS);
 return constantTimeEqual(actual,fields[3]);
}
async function mailAllowed(env:Env,email:string):Promise<boolean> {
 const t=now(),day=t-86400000,hash=await sha256(email);
 if(env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:'password-mail:'+hash})).success)return false;
 const r=await env.DB.prepare(
  'INSERT INTO password_mail_limits(email_hash,last_sent,window_start,send_count) VALUES(?,?,?,1) '+
  'ON CONFLICT(email_hash) DO UPDATE SET last_sent=excluded.last_sent,'+
  'window_start=CASE WHEN password_mail_limits.window_start<? THEN excluded.window_start ELSE password_mail_limits.window_start END,'+
  'send_count=CASE WHEN password_mail_limits.window_start<? THEN 1 ELSE password_mail_limits.send_count+1 END '+
  'WHERE password_mail_limits.last_sent<=? AND (password_mail_limits.window_start<? OR password_mail_limits.send_count<5)'
 ).bind(hash,t,t,day,day,t-60000,day).run();
 return r.meta.changes>0;
}
async function sendBrevo(env:Env,to:string,kind:'verify'|'reset',token:string):Promise<boolean> {
 const path=kind==='verify'?'/verify-email':'/reset-password';
 const link=new URL(path,env.BASE_URL);
 link.searchParams.set('token',token);
 const subject=kind==='verify'?'Verify your LeadPath email':'Reset your LeadPath password';
 const explanation=kind==='verify'?'Confirm your email to activate your account.':'Use this one-time link to choose a new password.';
 const lifetime=kind==='verify'?'24 hours':'30 minutes';
 try {
  const result=await fetch('https://api.brevo.com/v3/smtp/email',{
   method:'POST',headers:{'api-key':env.BREVO_API_KEY!,'Content-Type':'application/json','Accept':'application/json'},
   body:JSON.stringify({
    sender:{name:env.BREVO_SENDER_NAME||'LeadPath',email:env.BREVO_SENDER_EMAIL},
    to:[{email:to}],
    subject,
    textContent:'LeadPath\n\n'+explanation+'\n\n'+link.toString()+'\n\nThis link expires in '+lifetime+'. If this was not you, ignore this message.'
   }),
   signal:AbortSignal.timeout(10000)
  });
  return result.ok;
 } catch {return false;}
}
async function sendToken(env:Env,userId:string,email:string,kind:'verify'|'reset'):Promise<boolean> {
 if(!await mailAllowed(env,email))return false;
 const token=newRandomString(),digest=await sha256(token),t=now();
 await env.DB.batch([
  env.DB.prepare('DELETE FROM password_tokens WHERE user_id=? AND kind=?').bind(userId,kind),
  env.DB.prepare('INSERT INTO password_tokens(token_hash,user_id,kind,expires_at,created_at) VALUES(?,?,?,?,?)')
   .bind(digest,userId,kind,t+(kind==='verify'?86400000:1800000),t)
 ]);
 const sent=await sendBrevo(env,email,kind,token);
 if(!sent)await env.DB.prepare('DELETE FROM password_tokens WHERE token_hash=?').bind(digest).run();
 return sent;
}
function guard(req:Request,env:Env):Response|null {
 if(!passwordAuthConfigured(env))return fail(503,'Email/password sign-in is not configured.');
 if(!mustBeSameOrigin(req,env))return fail(403,'Invalid origin.');
 return null;
}
export async function passwordSignUp(req:Request,env:Env):Promise<Response> {
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,2048),email=normalizeEmail(p.email);
 if(!email||!validPassword(p.password)||typeof p.name!=='string'||p.name.trim().length<2||p.name.trim().length>120)
  return fail(400,'Enter a valid name, email and password of 12–128 characters.');
 const existing=await env.DB.prepare('SELECT user_id FROM password_accounts WHERE email=?').bind(email).first();
 if(existing)return genericMail(); // Never disclose whether an address already has a password account.
 const t=now(),userId=crypto.randomUUID();
 const hashed=await hashPassword(p.password);
 try{
  await env.DB.batch([
   env.DB.prepare('INSERT INTO users(id,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(userId,email,p.name.trim(),null,t,t),
   env.DB.prepare('INSERT INTO password_accounts(email,user_id,password_hash,verified_at,created_at,updated_at) VALUES(?,?,?,NULL,?,?)')
    .bind(email,userId,hashed,t,t)
  ]);
 }catch{
  // A competing signup may have won the unique email constraint.
  if(await env.DB.prepare('SELECT user_id FROM password_accounts WHERE email=?').bind(email).first())return genericMail();
  throw new Error('Password registration database failure');
 }
 if(!await sendToken(env,userId,email,'verify'))
  return fail(503,'Account created, but email could not be delivered. Use Resend verification after email service is available.');
 return genericMail();
}
export async function passwordResend(req:Request,env:Env):Promise<Response> {
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),email=normalizeEmail(p.email);
 if(!email)return fail(400,'Enter a valid email address.');
 const row=await env.DB.prepare('SELECT user_id,verified_at FROM password_accounts WHERE email=?').bind(email)
  .first<{user_id:string;verified_at:number|null}>();
 if(row&&!row.verified_at)await sendToken(env,row.user_id,email,'verify');
 return genericMail();
}
export async function passwordLogin(req:Request,env:Env):Promise<Response> {
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),email=normalizeEmail(p.email);
 if(!email||typeof p.password!=='string'||encoder.encode(p.password).length>512)return authFailed();
 const row=await env.DB.prepare('SELECT user_id,password_hash,verified_at,login_failures,locked_until FROM password_accounts WHERE email=?')
  .bind(email).first<{user_id:string;password_hash:string;verified_at:number|null;login_failures:number;locked_until:number}>();
 const t=now();
 if(!row||row.locked_until>t)return authFailed();
 const valid=await verifyPassword(p.password,row.password_hash);
 if(!valid){
  const failures=row.locked_until>0 && row.locked_until<t ? 1 : row.login_failures+1;
  await env.DB.prepare('UPDATE password_accounts SET login_failures=?,locked_until=? WHERE user_id=?')
   .bind(failures>=5?0:failures,failures>=5?t+900000:0,row.user_id).run();
  return authFailed();
 }
 if(!row.verified_at)return authFailed();
 await env.DB.prepare('UPDATE password_accounts SET login_failures=0,locked_until=0 WHERE user_id=?').bind(row.user_id).run();
 const token=newRandomString(),csrf=newRandomString(16);
 await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(token),row.user_id,csrf,t+7*86400000,t).run();
 await audit(env,row.user_id,'sign_in_password');
 const res=json({ok:true,redirect:'/dashboard'});
 res.headers.append('Set-Cookie',secureCookie(local(env)?'lp_session':'__Host-lp_session',token,7*86400,!local(env)));
 return res;
}
async function consume(env:Env,token:unknown,kind:'verify'|'reset'):Promise<string|null> {
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
 const digest=await sha256(token),t=now();
 const row=await env.DB.prepare('SELECT user_id FROM password_tokens WHERE token_hash=? AND kind=? AND expires_at>?')
  .bind(digest,kind,t).first<{user_id:string}>();
 if(!row)return null;
 const consumed=await env.DB.prepare('DELETE FROM password_tokens WHERE token_hash=? AND kind=? AND expires_at>?')
  .bind(digest,kind,t).run();
 return consumed.meta.changes?row.user_id:null;
}
export async function passwordVerifyEmail(req:Request,env:Env):Promise<Response> {
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),userId=await consume(env,p.token,'verify');
 if(!userId)return fail(400,'Verification link is invalid, expired or already used.');
 await env.DB.prepare('UPDATE password_accounts SET verified_at=?,updated_at=? WHERE user_id=? AND verified_at IS NULL')
  .bind(now(),now(),userId).run();
 await audit(env,userId,'verify_email');
 return json({ok:true,message:'Email verified. You can now log in.'});
}
export async function passwordForgot(req:Request,env:Env):Promise<Response> {
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),email=normalizeEmail(p.email);
 if(!email)return fail(400,'Enter a valid email address.');
 const row=await env.DB.prepare('SELECT user_id,verified_at FROM password_accounts WHERE email=?').bind(email)
  .first<{user_id:string;verified_at:number|null}>();
 if(row?.verified_at)await sendToken(env,row.user_id,email,'reset');
 return genericMail();
}
export async function passwordReset(req:Request,env:Env):Promise<Response> {
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024);
 if(!validPassword(p.password))return fail(400,'Use a password of 12–128 characters.');
 // Perform the costly derivation before consuming the single-use token.
 const hashed=await hashPassword(p.password);
 const userId=await consume(env,p.token,'reset');
 if(!userId)return fail(400,'Reset link is invalid, expired or already used.');
 const t=now();
 await env.DB.batch([
  env.DB.prepare('UPDATE password_accounts SET password_hash=?,login_failures=0,locked_until=0,updated_at=? WHERE user_id=?')
   .bind(hashed,t,userId),
  env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId)
 ]);
 await audit(env,userId,'password_reset');
 return json({ok:true,message:'Password updated. Sign in with your new password.'});
}
