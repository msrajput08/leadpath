import type { Env } from './types.js';
import { fail, json, now, readBoundedJson, mustBeSameOrigin } from './util.js';
import { newRandomString, constantTimeEqual, secureCookie, sha256 } from './security.mjs';

const encoder=new TextEncoder();
const local=(env:Env)=>new URL(env.BASE_URL).protocol==='http:'&&new URL(env.BASE_URL).hostname==='localhost';
const emailReady=(env:Env)=>!!(env.ENABLE_EMAIL_OTP==='true'&&env.RESEND_API_KEY&&env.EMAIL_FROM_ADDRESS&&/^[a-fA-F0-9]{64}$/.test(env.EMAIL_OTP_SECRET||''));
export const emailLoginConfigured=emailReady;
function normalize(value:unknown):string|null {
 if(typeof value!=='string')return null;
 const email=value.trim().toLowerCase();
 if(email.length>254||email.length<3||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return null;
 return email;
}
async function otpHash(email:string,code:string,secret:string):Promise<string> {
 const bytes=Uint8Array.from(secret.match(/../g)!.map(x=>parseInt(x,16)));
 const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const result=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode('leadpath-email-v1:'+email+':'+code)));
 return Array.from(result,b=>b.toString(16).padStart(2,'0')).join('');
}
function makeCode():string {
 // Unbiased six-digit code using rejection sampling.
 const limit=Math.floor(4294967296/900000)*900000;
 let value=0;
 do {value=crypto.getRandomValues(new Uint32Array(1))[0];} while(value>=limit);
 return String(value%900000+100000);
}
const generic=()=>json({ok:true,message:'If email delivery is available, a 6-digit sign-in code has been sent.'});

export async function emailRequest(req:Request,env:Env):Promise<Response> {
 if(!emailReady(env))return fail(503,'Email sign-in is not configured');
 if(!mustBeSameOrigin(req,env))return fail(403,'Invalid origin');
 const payload=await readBoundedJson(req,1024);
 const email=normalize(payload.email);
 if(!email)return fail(400,'Enter a valid email address');
 // Both the edge limiter and the persistent database gate protect sending quotas.
 if(env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:'email-send:'+await sha256(email)})).success) return generic();
 const t=now(),code=makeCode(),hash=await otpHash(email,code,env.EMAIL_OTP_SECRET!);
 const stored=await env.DB.prepare(
  'INSERT INTO email_login_codes(email,code_hash,expires_at,attempts,sent_at,daily_window,daily_count) '+
  'VALUES(?,?,?,0,?,?,1) ON CONFLICT(email) DO UPDATE SET '+
  'code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at,'+
  'daily_window=CASE WHEN email_login_codes.daily_window<? THEN excluded.daily_window ELSE email_login_codes.daily_window END,'+
  'daily_count=CASE WHEN email_login_codes.daily_window<? THEN 1 ELSE email_login_codes.daily_count+1 END '+
  'WHERE email_login_codes.sent_at<=? AND (email_login_codes.daily_window<? OR email_login_codes.daily_count<5)'
 ).bind(email,hash,t+600000,t,t,t-86400000,t-86400000,t-60000,t-86400000).run();
 if(!stored.meta.changes)return generic();
 let sent=false;
 try {
  const delivery=await fetch('https://api.resend.com/emails',{
   method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},
   body:JSON.stringify({
    from:env.EMAIL_FROM_ADDRESS,to:[email],subject:'Your LeadPath sign-in code',
    text:'Your LeadPath sign-in code is '+code+'. It expires in 10 minutes. If you did not request this, ignore this email.'
   }),signal:AbortSignal.timeout(10000)
  });
  sent=delivery.ok;
 } catch {sent=false;}
 if(!sent){
  // Only clear this attempt if another request has not rotated it.
  await env.DB.prepare('DELETE FROM email_login_codes WHERE email=? AND code_hash=?').bind(email,hash).run();
  return fail(503,'Email service is unavailable. Please try another sign-in method.');
 }
 return generic();
}

export async function emailVerify(req:Request,env:Env):Promise<Response> {
 if(!emailReady(env))return fail(503,'Email sign-in is not configured');
 if(!mustBeSameOrigin(req,env))return fail(403,'Invalid origin');
 const payload=await readBoundedJson(req,1024);
 const email=normalize(payload.email),code=payload.code;
 if(!email || typeof code!=='string' || !/^\d{6}$/.test(code))return fail(400,'Enter your email and 6-digit code');
 const t=now();
 const update=await env.DB.prepare(
  'UPDATE email_login_codes SET attempts=attempts+1 WHERE email=? AND expires_at>? AND attempts<5'
 ).bind(email,t).run();
 if(!update.meta.changes)return fail(400,'Code expired or incorrect');
 const row=await env.DB.prepare('SELECT code_hash FROM email_login_codes WHERE email=?').bind(email)
  .first<{code_hash:string}>();
 if(!row || !constantTimeEqual(row.code_hash,await otpHash(email,code,env.EMAIL_OTP_SECRET!)))
  return fail(400,'Code expired or incorrect');
 const consume=await env.DB.prepare('DELETE FROM email_login_codes WHERE email=? AND code_hash=? AND expires_at>?')
  .bind(email,row.code_hash,t).run();
 if(!consume.meta.changes)return fail(400,'Code expired or already used');
 // Only attach to a previously verified email-login identity. Never merge by
 // matching an OAuth profile email: it can merge unrelated accounts.
 const old=await env.DB.prepare(
  "SELECT user_id FROM oauth_identities WHERE provider='email' AND provider_user_id=?"
 ).bind(email).first<{user_id:string}>();
 const userId=old?.user_id||crypto.randomUUID();
 if(!old){
  await env.DB.batch([
   env.DB.prepare('INSERT INTO users(id,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(userId,email,email.split('@')[0].slice(0,120),null,t,t),
   env.DB.prepare('INSERT INTO oauth_identities(provider,provider_user_id,user_id) VALUES(?,?,?)')
    .bind('email',email,userId)
  ]);
 }else{
  await env.DB.prepare('UPDATE users SET email=?,updated_at=? WHERE id=?').bind(email,t,userId).run();
 }
 const token=newRandomString(),csrf=newRandomString(16);
 await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(token),userId,csrf,t+7*86400000,t).run();
 const response=json({ok:true,redirect:'/dashboard'});
 response.headers.append('Set-Cookie',secureCookie(local(env)?'lp_session':'__Host-lp_session',
  token,7*86400,!local(env)));
 return response;
}
