import type { Env } from './types.js';
import { fail, now } from './util.js';
import { newRandomString, sha256, secureCookie, parseCookies } from './security.mjs';

// These providers create their own identities. Email equality is NOT account linking.
// Doing so could attach an unverified Facebook address or recycled email to an existing account.
type Provider = 'facebook' | 'x';
type Profile = { id: string; name: string; email?: string; picture?: string };
const encoder = new TextEncoder();
const origin = (env: Env) => new URL(env.BASE_URL).origin;
const local = (env: Env) => new URL(env.BASE_URL).protocol === 'http:' && new URL(env.BASE_URL).hostname === 'localhost';
const nameOf = (env: Env, type: 'session' | 'state', provider?: Provider) =>
 (local(env) ? 'lp_' : '__Host-lp_') + (type === 'session' ? 'session' : provider + '_state');
const b64url = (arr: Uint8Array) => btoa(String.fromCharCode(...arr)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const callbackUrl = (env: Env, provider: Provider) => origin(env) + '/auth/' + provider + '/callback';
function client(env: Env, provider: Provider) {
 return provider === 'facebook'
  ? { id: env.FACEBOOK_APP_ID, secret: env.FACEBOOK_APP_SECRET }
  : { id: env.X_CLIENT_ID, secret: env.X_CLIENT_SECRET };
}
function cleanEmail(email: unknown): string | undefined {
 if (typeof email !== 'string') return undefined;
 const e = email.trim().toLowerCase();
 return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
}
function responseRedirect(url: string): Response { return new Response(null, {status:302,headers:{Location:url}}); }
export async function socialStart(env: Env, provider: Provider): Promise<Response> {
 const credentials = client(env,provider);
 if (!credentials.id || !credentials.secret) return fail(503,provider + ' login has not been configured');
 const state = newRandomString(), verifier = newRandomString(), nonce = newRandomString(16);
 const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)));
 await env.DB.prepare('INSERT INTO oauth_states(state_hash,provider,verifier,nonce,expires_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(state),provider,verifier,nonce,now()+600000).run();
 const url = provider === 'facebook'
  ? new URL('https://www.facebook.com/v27.0/dialog/oauth')
  : new URL('https://x.com/i/oauth2/authorize');
 for (const [k,v] of Object.entries({
  client_id: credentials.id, redirect_uri: callbackUrl(env,provider), response_type: 'code',
  scope: provider === 'facebook' ? 'public_profile,email' : 'tweet.read users.read',
  state
 })) url.searchParams.set(k,v);
 if (provider === 'x') {
  url.searchParams.set('code_challenge',b64url(digest));
  url.searchParams.set('code_challenge_method','S256');
 }
 const res = responseRedirect(url.toString());
 res.headers.set('Set-Cookie',secureCookie(nameOf(env,'state',provider),state,600,!local(env)));
 return res;
}

async function metaProof(token: string, secret: string): Promise<string> {
 const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest = new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(token)));
 return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}
async function facebookIdentity(env: Env, code: string): Promise<Profile> {
 const creds=client(env,'facebook');
 const tokenResponse=await fetch('https://graph.facebook.com/v27.0/oauth/access_token',{
  method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:creds.id!,client_secret:creds.secret!,
   redirect_uri:callbackUrl(env,'facebook'),code}),
  signal:AbortSignal.timeout(10000)
 });
 if(!tokenResponse.ok) throw new Error('Facebook token exchange failed');
 const token=await tokenResponse.json() as {access_token?:string};
 if(!token.access_token) throw new Error('Missing Facebook access token');
 const url=new URL('https://graph.facebook.com/v27.0/me');
 url.searchParams.set('fields','id,name,email,picture.type(large)');
 url.searchParams.set('appsecret_proof',await metaProof(token.access_token,creds.secret!));
 const resp=await fetch(url.toString(),{headers:{Authorization:'Bearer '+token.access_token},
  signal:AbortSignal.timeout(7000)});
 if(!resp.ok) throw new Error('Facebook profile unavailable');
 const profile=await resp.json() as {id?:string;name?:string;email?:string;picture?:{data?:{url?:string}}};
 if(!profile.id || typeof profile.id!=='string') throw new Error('Facebook profile missing user ID');
 return {id:profile.id,name:String(profile.name||'Facebook user').slice(0,120),
  email:cleanEmail(profile.email),picture:profile.picture?.data?.url};
}
async function xIdentity(env: Env, code: string, verifier: string): Promise<Profile> {
 const creds=client(env,'x');
 const tokenResponse=await fetch('https://api.x.com/2/oauth2/token',{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',
   Authorization:'Basic '+btoa(creds.id+':'+creds.secret)},
  body:new URLSearchParams({code,grant_type:'authorization_code',
   redirect_uri:callbackUrl(env,'x'),code_verifier:verifier}),
  signal:AbortSignal.timeout(10000)
 });
 if(!tokenResponse.ok) throw new Error('X token exchange failed');
 const token=await tokenResponse.json() as {access_token?:string};
 if(!token.access_token) throw new Error('Missing X access token');
 const resp=await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url',{
  headers:{Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(7000)});
 if(!resp.ok) throw new Error('X profile unavailable; check developer API access');
 const body=await resp.json() as {data?:{id?:string;name?:string;username?:string;profile_image_url?:string}};
 if(!body.data?.id) throw new Error('X profile missing user ID');
 // X OAuth may not supply email. Do not invent a verified email or silently link other identities.
 return {id:body.data.id,name:String(body.data.name||body.data.username||'X user').slice(0,120),
  picture:body.data.profile_image_url};
}
export async function socialCallback(req: Request, env: Env, provider: Provider): Promise<Response> {
 const credentials=client(env,provider);
 if(!credentials.id || !credentials.secret) return fail(503,'Login provider not configured');
 const url=new URL(req.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
 const cookie=parseCookies(req.headers.get('cookie'))[nameOf(env,'state',provider)];
 if(!state||!code||!cookie||state!==cookie) return fail(400,'Authorization state or code missing');
 const stateHash=await sha256(state);
 const stored=await env.DB.prepare('SELECT verifier,expires_at FROM oauth_states WHERE state_hash=? AND provider=?')
  .bind(stateHash,provider).first<{verifier:string;expires_at:number}>();
 if(!stored || stored.expires_at<=now()) return fail(400,'Authorization state has expired');
 const consumed=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? AND provider=?')
  .bind(stateHash,provider).run();
 if(!consumed.meta.changes) return fail(400,'Authorization code replay rejected');
 let profile:Profile;
 try { profile=provider==='facebook'?await facebookIdentity(env,code):await xIdentity(env,code,stored.verifier); }
 catch { return fail(400,provider+' authorization could not be completed. Check provider permissions and API access.'); }
 const current=now();
 const existing=await env.DB.prepare('SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?')
  .bind(provider,profile.id).first<{user_id:string}>();
 const userId=existing?.user_id||crypto.randomUUID();
 const email=profile.email||provider+'-'+profile.id+'@no-email.leadpath.invalid';
 if (!existing) {
  await env.DB.batch([
   env.DB.prepare('INSERT INTO users(id,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .bind(userId,email,profile.name,profile.picture||null,current,current),
   env.DB.prepare('INSERT INTO oauth_identities(provider,provider_user_id,user_id) VALUES(?,?,?)')
    .bind(provider,profile.id,userId)
  ]);
 } else {
  // Never replace a real stored address with a synthetic placeholder if permission is withdrawn.
  await env.DB.prepare('UPDATE users SET name=?,avatar_url=?,updated_at=? WHERE id=?')
   .bind(profile.name,profile.picture||null,current,userId).run();
 }
 const session=newRandomString(),csrf=newRandomString(16);
 await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
  .bind(await sha256(session),userId,csrf,current+7*86400000,current).run();
 const res=new Response(null,{status:303,headers:{Location:origin(env)+'/dashboard'}});
 res.headers.append('Set-Cookie',secureCookie(nameOf(env,'session'),session,7*86400,!local(env)));
 res.headers.append('Set-Cookie',secureCookie(nameOf(env,'state',provider),'',0,!local(env)));
 return res;
}
