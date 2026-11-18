import type { Env } from './types.js';
import { json, fail } from './util.js';
import { authStart, authCallback, authLogout, githubStart, githubCallback } from './auth.js';
import { handleApi } from './api.js';
import { confirmCallback, scheduled } from './engine.js';

type Ctx = {waitUntil(promise:Promise<unknown>):void};
function hardened(res:Response):Response {
 const headers=new Headers(res.headers);
 headers.set('X-Content-Type-Options','nosniff');
 headers.set('Referrer-Policy','strict-origin-when-cross-origin');
 headers.set('X-Frame-Options','DENY');
 headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
 return new Response(res.body,{status:res.status,statusText:res.statusText,headers});
}
export default {
 async fetch(req:Request,env:Env,ctx:Ctx):Promise<Response> {
  const path=new URL(req.url).pathname;
  try {
   if (!env.BASE_URL) return hardened(fail(503,'BASE_URL not configured'));
   if (path==='/auth/google/start' && req.method==='GET') {
    const key='oauth-start:'+(req.headers.get('CF-Connecting-IP')||'anonymous');
    if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key})).success) return hardened(fail(429,'Too many sign-in attempts.'));
    return authStart(env);
   }
   if (path==='/auth/google/callback' && req.method==='GET') return authCallback(req,env);
   if (path==='/auth/github/start' && req.method==='GET') return githubStart(env);
   if (path==='/auth/github/callback' && req.method==='GET') return githubCallback(req,env);
   if (path==='/auth/logout' && req.method==='POST') return hardened(await authLogout(req,env));
   const cb=path.match(/^\/api\/callback\/([a-f0-9-]{36})$/);
   if (cb && req.method==='POST') return hardened(await confirmCallback(req,env,cb[1],ctx));
   if (path.startsWith('/api/')) return hardened(await handleApi(req,env,ctx));
   return hardened(fail(404,'Not found'));
  } catch (error) {
   // Server-side logging intentionally excludes request URLs and tokens.
   console.error('LeadPath request failure',error instanceof Error?error.name:'UnknownError');
   return hardened(json({error:'Unexpected server error. Please try again.'},500));
  }
 },
 async scheduled(_event:unknown,env:Env,ctx:Ctx):Promise<void> {
  try {await scheduled(env,ctx);} catch (error) {console.error('LeadPath cron failure',error instanceof Error?error.name:'UnknownError');}
 }
};
