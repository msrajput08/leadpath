import type { Env } from './types.js';
import { audit, fail, json, mustBeSameOrigin, now, readBoundedJson } from './util.js';
import { newRandomString, secureCookie, sha256 } from './security.mjs';

// Supabase Auth owns the costly password hashing and expiring email tokens.
// Cloudflare Workers Free cannot safely execute the previous 600k-iteration KDF.
type AuthUser={id:string;email?:string;email_confirmed_at?:string|null;user_metadata?:{name?:unknown;full_name?:unknown;avatar_url?:unknown}};
type AuthResult={user?:AuthUser;access_token?:string;code?:string;error?:string;msg?:string};
const encoder=new TextEncoder();
function normalize(v:unknown):string|null{
 if(typeof v!=='string')return null;
 const e=v.trim().toLowerCase();
 return e.length>=3&&e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)?e:null;
}
const passwordValid=(v:unknown):v is string=>typeof v==='string'&&v.length>=12&&v.length<=128&&encoder.encode(v).length<=512;
const tokenValid=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9._-]{20,256}$/.test(v);
const isLocal=(env:Env)=>{const u=new URL(env.BASE_URL);return u.protocol==='http:'&&u.hostname==='localhost';};
export function passwordAuthConfigured(env:Env):boolean{
 if(!env.SUPABASE_URL||!env.SUPABASE_ANON_KEY)return false;
 try {
  const u=new URL(env.SUPABASE_URL);
  return u.protocol==='https:'&&/^[a-z0-9-]+\.supabase\.co$/.test(u.hostname)&&
   u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password&&!u.port&&env.SUPABASE_ANON_KEY.length>=15;
 }catch{return false;}
}
const generic=()=>json({ok:true,message:'If this email is eligible, a secure message will be sent.'});
const invalidLogin=()=>fail(401,'Invalid credentials or email not verified.');
function guard(req:Request,env:Env):Response|null {
 if(!passwordAuthConfigured(env))return fail(503,'Email/password sign-in is not configured.');
 if(!mustBeSameOrigin(req,env))return fail(403,'Invalid origin.');
 return null;
}
async function authRequest(env:Env,path:string,payload:Record<string,unknown>,accessToken?:string,method:'POST'|'PUT'='POST'):Promise<{ok:boolean;status:number;data:AuthResult}>{
 const headers:Record<string,string>={'apikey':env.SUPABASE_ANON_KEY!,'Content-Type':'application/json','Accept':'application/json'};
 if(accessToken)headers.Authorization='Bearer '+accessToken;
 try{
  const response=await fetch(env.SUPABASE_URL!.replace(/\/$/,'')+'/auth/v1/'+path,{
   method,headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)
  });
  const data=await response.json().catch(()=>({})) as AuthResult;
  return {ok:response.ok,status:response.status,data};
 }catch{return {ok:false,status:503,data:{}};}
}
function providerUnavailable(status:number):Response{
 return fail(status===429?429:503,status===429?'Too many attempts. Please try again later.':'Authentication provider is unavailable. Please try again.');
}
async function createLocalSession(env:Env,user:AuthUser):Promise<Response>{
 if(typeof user.id!=='string'||!user.id||!user.email_confirmed_at||!normalize(user.email))return invalidLogin();
 const email=normalize(user.email)!;
 const existing=await env.DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='supabase' AND provider_user_id=?")
  .bind(user.id).first<{user_id:string}>();
 let userId=existing?.user_id;
 const t=now();
 if(!userId){
  userId=crypto.randomUUID();
  const fromMeta=user.user_metadata?.name||user.user_metadata?.full_name;
  const name=typeof fromMeta==='string'&&fromMeta.trim()?fromMeta.trim().slice(0,120):email.split('@')[0].slice(0,120);
  try{
   await env.DB.batch([
    env.DB.prepare('INSERT INTO users(id,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?)')
     .bind(userId,email,name,null,t,t),
    env.DB.prepare('INSERT INTO oauth_identities(provider,provider_user_id,user_id) VALUES(?,?,?)')
     .bind('supabase',user.id,userId)
   ]);
  }catch{
   // Handle a concurrent sign-in that inserted the exact same verified provider ID.
   const concurrent=await env.DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='supabase' AND provider_user_id=?")
    .bind(user.id).first<{user_id:string}>();
   if(!concurrent)throw new Error('Supabase identity provisioning failed');
   userId=concurrent.user_id;
  }
 }
 const token=newRandomString(),csrf=newRandomString(16);
 await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(token),userId,csrf,t+7*86400000,t).run();
 await audit(env,userId,'sign_in_password');
 const result=json({ok:true,redirect:'/dashboard'});
 result.headers.append('Set-Cookie',secureCookie(isLocal(env)?'lp_session':'__Host-lp_session',token,7*86400,!isLocal(env)));
 return result;
}
export async function passwordSignUp(req:Request,env:Env):Promise<Response>{
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,2048),email=normalize(p.email),name=p.name;
 if(!email||!passwordValid(p.password)||typeof name!=='string'||name.trim().length<2||name.trim().length>120)
  return fail(400,'Enter a valid name, email and password of 12–128 characters.');
 const r=await authRequest(env,'signup',{email,password:p.password,data:{name:name.trim()}});
 if(r.status===503||r.status===429||r.status>=500)return providerUnavailable(r.status);
 // Deliberately do not reveal whether the email is already registered.
 return generic();
}
export async function passwordLogin(req:Request,env:Env):Promise<Response>{
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),email=normalize(p.email);
 if(!email||typeof p.password!=='string'||encoder.encode(p.password).length>512)return invalidLogin();
 const r=await authRequest(env,'token?grant_type=password',{email,password:p.password});
 if(r.status===429||r.status===503||r.status>=500)return providerUnavailable(r.status);
 if(!r.ok||!r.data.access_token||!r.data.user)return invalidLogin();
 return createLocalSession(env,r.data.user);
}
export async function passwordResend(req:Request,env:Env):Promise<Response>{
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),email=normalize(p.email);
 if(!email)return fail(400,'Enter a valid email address.');
 const r=await authRequest(env,'resend',{type:'signup',email});
 if(r.status===429||r.status===503||r.status>=500)return providerUnavailable(r.status);
 return generic();
}
export async function passwordVerifyEmail(req:Request,env:Env):Promise<Response>{
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024);
 if(!tokenValid(p.token))return fail(400,'Verification link is invalid or expired.');
 const r=await authRequest(env,'verify',{token_hash:p.token,type:'email'});
 if(r.status===429||r.status===503||r.status>=500)return providerUnavailable(r.status);
 if(!r.ok||!r.data.user?.email_confirmed_at)return fail(400,'Verification link is invalid, expired or already used.');
 return json({ok:true,message:'Email verified. You can now log in.'});
}
export async function passwordForgot(req:Request,env:Env):Promise<Response>{
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024),email=normalize(p.email);
 if(!email)return fail(400,'Enter a valid email address.');
 const r=await authRequest(env,'recover',{email});
 if(r.status===429||r.status===503||r.status>=500)return providerUnavailable(r.status);
 return generic();
}
export async function passwordReset(req:Request,env:Env):Promise<Response>{
 const denied=guard(req,env);if(denied)return denied;
 const p=await readBoundedJson(req,1024);
 if(!tokenValid(p.token)||!passwordValid(p.password))return fail(400,'Invalid recovery link or password. Use at least 12 characters.');
 const verified=await authRequest(env,'verify',{token_hash:p.token,type:'recovery'});
 if(verified.status===429||verified.status===503||verified.status>=500)return providerUnavailable(verified.status);
 if(!verified.ok||!verified.data.access_token||!verified.data.user?.id)
  return fail(400,'Recovery link is invalid, expired or already used.');
 const changed=await authRequest(env,'user',{password:p.password},verified.data.access_token,'PUT');
 if(!changed.ok)return providerUnavailable(changed.status);
 const identity=await env.DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='supabase' AND provider_user_id=?")
  .bind(verified.data.user.id).first<{user_id:string}>();
 if(identity){
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(identity.user_id).run();
  await audit(env,identity.user_id,'password_reset');
 }
 return json({ok:true,message:'Password updated. Sign in with your new password.'});
}
