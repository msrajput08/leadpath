import type { Env } from './types.js';
import { getSession, fail, json, now, audit } from './util.js';
import { newRandomString, sha256, secureCookie, parseCookies } from './security.mjs';
const b64url = (arr: Uint8Array) => btoa(String.fromCharCode(...arr)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromB64 = (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const isLocal = (env: Env) => new URL(env.BASE_URL).protocol === 'http:' && new URL(env.BASE_URL).hostname === 'localhost';
const sessionCookieName = (env: Env) => isLocal(env) ? 'lp_session' : '__Host-lp_session';
const stateCookieName = (env: Env) => isLocal(env) ? 'lp_oauth_state' : '__Host-lp_oauth_state';
const mutableRedirect=(url:string,status:302|303=302)=>new Response(null,{status,headers:{Location:url}});

export async function authStart(env: Env): Promise<Response> {
 if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail(503, 'Google OAuth credentials not configured.');
 const state = newRandomString(); const verifier = newRandomString(); const nonce = newRandomString(16);
 const hash = await sha256(state);
 const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
 await env.DB.prepare('INSERT INTO oauth_states (state_hash,verifier,nonce,expires_at) VALUES(?,?,?,?)')
  .bind(hash,verifier,nonce,now()+600000).run();
 const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
 const redirect = new URL('/auth/google/callback', env.BASE_URL).toString();
 for (const [key,val] of Object.entries({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect,
  response_type: 'code', scope: 'openid email profile', state, nonce,
  code_challenge: b64url(new Uint8Array(digest)), code_challenge_method: 'S256', access_type: 'online' })) url.searchParams.set(key,val);
 const res = mutableRedirect(url.toString(),302);
 res.headers.set('Set-Cookie',secureCookie(stateCookieName(env),state,600,!isLocal(env)));
 return res;
}

async function validateGoogleIdToken(idToken: string, clientId: string, nonce: string): Promise<{sub:string;email:string;name:string;picture?:string}> {
 const parts = idToken.split('.');
 if (parts.length!==3) throw new Error('Invalid Google token');
 const header = JSON.parse(new TextDecoder().decode(fromB64(parts[0])));
 if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unexpected Google signing key');
 const jwksResponse = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(7000) });
 if (!jwksResponse.ok) throw new Error('Could not obtain Google verification keys');
 const jwks = await jwksResponse.json() as {keys: Array<JsonWebKey & {kid?:string}>};
 const jwk = jwks.keys.find(k=>k.kid===header.kid && k.kty==='RSA');
 if (!jwk) throw new Error('No matching Google verification key');
 const key = await crypto.subtle.importKey('jwk',jwk,{ name:'RSASSA-PKCS1-v1_5',hash:'SHA-256' },false,['verify']);
 const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,fromB64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
 if (!ok) throw new Error('Invalid Google signature');
 const p = JSON.parse(new TextDecoder().decode(fromB64(parts[1])));
 const timestamp=Math.floor(now()/1000);
 if (!['https://accounts.google.com','accounts.google.com'].includes(p.iss) || p.aud!==clientId || p.exp<=timestamp || p.iat>timestamp+60 || p.nonce!==nonce || p.email_verified!==true || !p.sub || !p.email) throw new Error('Invalid Google identity claims');
 return {sub:p.sub,email:p.email,name:String(p.name||p.email).slice(0,120),picture:typeof p.picture==='string'?p.picture:undefined};
}

export async function authCallback(req: Request, env: Env): Promise<Response> {
 const url=new URL(req.url);
 const cookie=parseCookies(req.headers.get('cookie'))[stateCookieName(env)];
 const state=url.searchParams.get('state'); const code=url.searchParams.get('code');
 if (!state || !code || !cookie || state!==cookie || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return fail(400,'OAuth state, authorization code or configuration missing');
 const hash=await sha256(state);
 const row=await env.DB.prepare("SELECT verifier,nonce,expires_at FROM oauth_states WHERE state_hash=? AND provider='google'").bind(hash).first<{verifier:string;nonce:string;expires_at:number}>();
 if (!row || row.expires_at<now()) return fail(400,'OAuth state expired or already used');
 const consumed=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=?').bind(hash).run();
 if (!consumed.meta.changes) return fail(400,'OAuth replay prevented');
 const tokenResponse=await fetch('https://oauth2.googleapis.com/token', { method:'POST', signal:AbortSignal.timeout(10000),
  headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
   redirect_uri:new URL('/auth/google/callback',env.BASE_URL).toString(), grant_type:'authorization_code',code_verifier:row.verifier}) });
 if (!tokenResponse.ok) return fail(400,'Google authorization could not be completed');
 const tokens=await tokenResponse.json() as {id_token?:string};
 if (!tokens.id_token) return fail(400,'Missing Google identity token');
 const profile=await validateGoogleIdToken(tokens.id_token,env.GOOGLE_CLIENT_ID,row.nonce);
 let existing=await env.DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='google' AND provider_user_id=?").bind(profile.sub).first<{user_id:string}>();
 let userId=existing?.user_id;
 const timestamp=now();
 if (!userId) {
  userId=crypto.randomUUID();
  // Unique Google sub is the only identity join key: never link by unverified email.
  await env.DB.batch([
   env.DB.prepare('INSERT INTO users (id,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(userId,profile.email,profile.name,profile.picture||null,timestamp,timestamp),
   env.DB.prepare('INSERT INTO oauth_identities (provider,provider_user_id,user_id) VALUES(?,?,?)').bind('google',profile.sub,userId)
  ]);
 } else {
  await env.DB.prepare('UPDATE users SET email=?,name=?,avatar_url=?,updated_at=? WHERE id=?').bind(profile.email,profile.name,profile.picture||null,timestamp,userId).run();
 }
 const token=newRandomString(); const csrf=newRandomString(16);
 await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(token),userId,csrf,timestamp+7*86400000,timestamp).run();
 await audit(env,userId,'sign_in');
 const res=mutableRedirect(new URL('/dashboard',env.BASE_URL).toString(),303);
 res.headers.append('Set-Cookie',secureCookie(sessionCookieName(env),token,7*86400,!isLocal(env)));
 res.headers.append('Set-Cookie',secureCookie(stateCookieName(env),'',0,!isLocal(env)));
 return res;
}
export async function authLogout(req: Request, env: Env): Promise<Response> {
 const session=await getSession(req,env);
 if (!session) return fail(401,'Not authenticated');
 if (req.headers.get('Origin')!==new URL(env.BASE_URL).origin || req.headers.get('X-CSRF-Token')!==session.csrf_token) return fail(403,'CSRF check failed');
 const token=parseCookies(req.headers.get('cookie'))[sessionCookieName(env)];
 if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
 const res=json({ok:true});
 res.headers.append('Set-Cookie',secureCookie(sessionCookieName(env),'',0,!isLocal(env)));
 return res;
}


/** Optional GitHub login: compatible with a free workers.dev URL, subject to provider setup. */
export async function githubStart(env:Env):Promise<Response> {
 if(!env.GITHUB_CLIENT_ID||!env.GITHUB_CLIENT_SECRET)return fail(503,'GitHub OAuth credentials not configured.');
 const state=newRandomString(),verifier=newRandomString(),nonce=newRandomString(16);
 const hash=await sha256(state),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
 await env.DB.prepare('INSERT INTO oauth_states(state_hash,provider,verifier,nonce,expires_at) VALUES(?,?,?,?,?)').bind(hash,'github',verifier,nonce,now()+600000).run();
 const authUrl=new URL('https://github.com/login/oauth/authorize');
 for(const [k,v] of Object.entries({client_id:env.GITHUB_CLIENT_ID,redirect_uri:new URL('/auth/github/callback',env.BASE_URL).toString(),scope:'user:email',state,code_challenge:b64url(new Uint8Array(digest)),code_challenge_method:'S256'}))authUrl.searchParams.set(k,v);
 const res=mutableRedirect(authUrl.toString(),302);
 res.headers.set('Set-Cookie',secureCookie(isLocal(env)?'lp_github_state':'__Host-lp_github_state',state,600,!isLocal(env)));
 return res;
}
export async function githubCallback(req:Request,env:Env):Promise<Response> {
 const url=new URL(req.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
 const cookie=parseCookies(req.headers.get('cookie'))[isLocal(env)?'lp_github_state':'__Host-lp_github_state'];
 if(!state||!code||!cookie||state!==cookie||!env.GITHUB_CLIENT_ID||!env.GITHUB_CLIENT_SECRET)return fail(400,'GitHub authorization state mismatch');
 const hash=await sha256(state);
 const record=await env.DB.prepare("SELECT verifier,expires_at FROM oauth_states WHERE state_hash=? AND provider='github'").bind(hash).first<{verifier:string;expires_at:number}>();
 if(!record||record.expires_at<now())return fail(400,'Authorization expired or used');
 const consumed=await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? AND provider='github'").bind(hash).run();
 if(!consumed.meta.changes)return fail(400,'Authorization replay prevented');
 const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded','User-Agent':'LeadPath-MVP'},signal:AbortSignal.timeout(10000),
  body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:new URL('/auth/github/callback',env.BASE_URL).toString(),code_verifier:record.verifier})});
 if(!tokenResponse.ok)return fail(400,'GitHub token exchange failed');
 const tokenData=await tokenResponse.json() as {access_token?:string;error?:string};
 if(!tokenData.access_token||tokenData.error)return fail(400,'GitHub did not issue an access token');
 const headers={Authorization:`Bearer ${tokenData.access_token}`,Accept:'application/vnd.github+json','User-Agent':'LeadPath-MVP','X-GitHub-Api-Version':'2022-11-28'};
 const [userResponse,emailResponse]=await Promise.all([
  fetch('https://api.github.com/user',{headers,signal:AbortSignal.timeout(7000)}),
  fetch('https://api.github.com/user/emails',{headers,signal:AbortSignal.timeout(7000)})
 ]);
 if(!userResponse.ok||!emailResponse.ok)return fail(400,'Could not verify GitHub profile and email');
 const user=await userResponse.json() as {id?:number;login?:string;name?:string;avatar_url?:string};
 const emails=await emailResponse.json() as Array<{email:string;verified:boolean;primary:boolean}>;
 const email=Array.isArray(emails)?emails.find(e=>e.primary&&e.verified)||emails.find(e=>e.verified):null;
 if(!user.id||!email?.email)return fail(400,'GitHub account needs a verified email');
 const sub=String(user.id),ts=now();
 const existing=await env.DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='github' AND provider_user_id=?").bind(sub).first<{user_id:string}>();
 const userId=existing?.user_id||crypto.randomUUID();
 const name=String(user.name||user.login||email.email).slice(0,120);
 if(!existing){
  await env.DB.batch([
   env.DB.prepare('INSERT INTO users(id,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(userId,email.email,name,user.avatar_url||null,ts,ts),
   env.DB.prepare('INSERT INTO oauth_identities(provider,provider_user_id,user_id) VALUES(?,?,?)').bind('github',sub,userId)
  ]);
 } else await env.DB.prepare('UPDATE users SET email=?,name=?,avatar_url=?,updated_at=? WHERE id=?').bind(email.email,name,user.avatar_url||null,ts,userId).run();
 // GitHub's short-lived OAuth token is used once and never stored. LeadPath uses its own session cookie.
 const sessionToken=newRandomString(),csrf=newRandomString(16);
 await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)').bind(await sha256(sessionToken),userId,csrf,ts+7*86400000,ts).run();
 await audit(env,userId,'sign_in_github');
 const res=mutableRedirect(new URL('/dashboard',env.BASE_URL).toString(),303);
 res.headers.append('Set-Cookie',secureCookie(sessionCookieName(env),sessionToken,7*86400,!isLocal(env)));
 res.headers.append('Set-Cookie',secureCookie(isLocal(env)?'lp_github_state':'__Host-lp_github_state','',0,!isLocal(env)));
 return res;
}
