import type {Env} from './types.js';
import {json,fail,readSmallJson} from './util.js';

type CheckoutPlan='starter'|'pro';
class RazorpayApiError extends Error {
 constructor(readonly status:number){super('Razorpay API returned HTTP '+status);}
}
function planLookupFailure(error:unknown):Response {
 if(error instanceof RazorpayApiError){
  if(error.status===401||error.status===403)
   return fail(502,'Razorpay TEST API rejected the keys (HTTP '+error.status+'). Recheck Test Key ID and Secret.');
  if(error.status===404)
   return fail(502,'Razorpay TEST plan was not found (HTTP 404). Use a Test Mode plan ID from the same account as the Test API keys.');
  if(error.status===429)
   return fail(503,'Razorpay test API rate limit reached (HTTP 429). Retry later.');
  return fail(502,'Razorpay TEST plan lookup failed (HTTP '+error.status+').');
 }
 return fail(502,'Cannot reach Razorpay TEST plan API. Check provider availability or staging network.');
}
type GatewayPlan={id?:string;period?:string;interval?:number;item?:{amount?:number;currency?:string}};
type GatewaySubscription={id?:string;plan_id?:string;short_url?:string;status?:string;current_end?:number};
const planId=(s:unknown):s is string=>typeof s==='string'&&/^plan_[A-Za-z0-9]{6,80}$/.test(s);
const subscriptionId=(s:unknown):s is string=>typeof s==='string'&&/^sub_[A-Za-z0-9]{3,100}$/.test(s);
const paymentId=(s:unknown):s is string=>typeof s==='string'&&/^pay_[A-Za-z0-9]{3,100}$/.test(s);
const safeHex=(x:string,y:string):boolean=>{
 if(x.length!==y.length)return false;
 let diff=0;for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);
 return diff===0;
};
const hex=(data:ArrayBuffer)=>Array.from(new Uint8Array(data),v=>v.toString(16).padStart(2,'0')).join('');
async function hmac(secret:string,value:string) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value)));
}
export function testConfigReady(env:Env):boolean {
 return env.RAZORPAY_SANDBOX_ENABLED==='true' &&
  !!env.RAZORPAY_TEST_KEY_ID?.startsWith('rzp_test_') &&
  !!env.RAZORPAY_TEST_KEY_SECRET &&
  planId(env.RAZORPAY_TEST_STARTER_PLAN_ID) && planId(env.RAZORPAY_TEST_PRO_PLAN_ID);
}
async function gateway<T>(env:Env,method:'GET'|'POST',path:string,body?:unknown):Promise<T> {
 if(!testConfigReady(env))throw new Error('SANDBOX_DISABLED');
 // Fixed Razorpay API host and TEST-mode Basic credentials only, never a browser URL.
 const response=await fetch('https://api.razorpay.com/v1/'+path,{
  method,headers:{Authorization:'Basic '+btoa(env.RAZORPAY_TEST_KEY_ID+':'+env.RAZORPAY_TEST_KEY_SECRET),
   'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
   signal:AbortSignal.timeout(9000),redirect:'error'
 });
 if(!response.ok)throw new RazorpayApiError(response.status);
 return await response.json() as T;
}
export async function sandboxCreateSubscription(env:Env,userId:string,request:Request):Promise<Response>{
 if(!testConfigReady(env))return fail(503,'Test-mode subscriptions are disabled.');
 const body=await readSmallJson(request),code=body.plan_code;
 if(code!=='starter'&&code!=='pro')return fail(400,'Select Starter or Pro.');
 const planCode=code as CheckoutPlan;
 const plan=await env.DB.prepare('SELECT code,currency,price_minor_units,available_for_purchase FROM subscription_plans WHERE code=?')
  .bind(planCode).first<{code:string;currency:string;price_minor_units:number;available_for_purchase:number}>();
 if(!plan||plan.currency!=='INR'||plan.price_minor_units<=0||plan.available_for_purchase!==0)
  return fail(503,'Test plan is unavailable or inconsistent.');
 const existing=await env.DB.prepare(`SELECT id FROM user_subscriptions WHERE user_id=?
  AND status IN ('pending','active','past_due') LIMIT 1`).bind(userId).first();
 if(existing)return fail(409,'Existing subscription must be resolved before starting another.');
 const timestamp=Date.now(),nonce=crypto.randomUUID();
 const providerPlanId=planCode==='starter'?env.RAZORPAY_TEST_STARTER_PLAN_ID!:env.RAZORPAY_TEST_PRO_PLAN_ID!;
 // Validate the remote plan BEFORE creating the duplicate-prevention lock.
 // A wrong ID, rejected GET or price mismatch must not block the next attempt for 30 minutes.
 let verifiedPlan:GatewayPlan;
 try {verifiedPlan=await gateway<GatewayPlan>(env,'GET','plans/'+providerPlanId);}
 catch(error) {return planLookupFailure(error);}
 if(verifiedPlan.id!==providerPlanId||verifiedPlan.period!=='monthly'||verifiedPlan.interval!==1 ||
    verifiedPlan.item?.currency!=='INR'||verifiedPlan.item.amount!==plan.price_minor_units)
  return fail(503,'Razorpay test plan does not match LeadPath INR price or monthly interval.');
 const lock=await env.DB.prepare(`INSERT INTO billing_creation_locks(user_id,nonce,locked_until,created_at)
 VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET nonce=excluded.nonce,locked_until=excluded.locked_until,
 created_at=excluded.created_at WHERE billing_creation_locks.locked_until<?`)
 .bind(userId,nonce,timestamp+1800000,timestamp,timestamp).run();
 if(!lock.meta.changes)return fail(409,'Subscription setup is already in progress. Check test subscriptions before retrying.');
 try {
  // Sandbox-only subscription; provider returns a hosted test-mode authentication link.
  const created=await gateway<GatewaySubscription>(env,'POST','subscriptions',
   {plan_id:providerPlanId,total_count:12,quantity:1,customer_notify:false,
    notes:{app:'LeadPath sandbox',checkout_nonce:nonce}});
  if(!subscriptionId(created.id)||created.plan_id!==providerPlanId) return fail(502,'Unexpected test subscription response.');
  let url:URL|null=null;
  try {url=new URL(created.short_url||'');}catch {}
  if(!url||url.protocol!=='https:'||url.hostname!=='rzp.io')return fail(502,'Unexpected hosted checkout URL.');
  // The trusted mapping originates ONLY from a server-created subscription.
  const committed=await env.DB.prepare(`INSERT INTO user_subscriptions
   (id,user_id,plan_code,provider,provider_subscription_id,status,created_at,updated_at)
   SELECT ?,?,?,'razorpay',?,'pending',?,? WHERE EXISTS
   (SELECT 1 FROM billing_creation_locks WHERE user_id=? AND nonce=?)`)
   .bind(crypto.randomUUID(),userId,planCode,created.id,timestamp,timestamp,userId,nonce).run();
  if(!committed.meta.changes) return fail(409,'Checkout claim expired; contact support before retrying.');
  return json({mode:'test',plan_code:planCode,provider_subscription_id:created.id,
   checkout_url:url.toString(),message:'Razorpay TEST MODE ONLY. No live charges or paid entitlement.'},201);
 }catch {
  // Do not automatically free a lock after an uncertain upstream create; avoid duplicate mandates.
  return fail(502,'Test provider unavailable or plan not approved. No payment access was activated.');
 }
}
export async function sandboxCancelSubscription(env:Env,userId:string):Promise<Response>{
 if(!testConfigReady(env))return fail(503,'Test-mode subscriptions are disabled.');
 const sub=await env.DB.prepare(`SELECT provider_subscription_id,status FROM user_subscriptions
  WHERE user_id=? AND status IN ('pending','active','past_due') ORDER BY created_at DESC LIMIT 1`)
  .bind(userId).first<{provider_subscription_id:string;status:string}>();
 if(!sub||!subscriptionId(sub.provider_subscription_id))return fail(404,'No cancellable test subscription.');
 try {
  const result=await gateway<GatewaySubscription>(env,'POST',
   'subscriptions/'+sub.provider_subscription_id+'/cancel',{cancel_at_cycle_end:true});
  if(result.id!==sub.provider_subscription_id)return fail(502,'Unexpected provider response.');
  // Do not grant or revoke access based on an unverified browser request. Signed webhooks
  // and provider reconciliation own lifecycle updates.
  return json({ok:true,pending_provider_confirmation:true,
   message:'Test cancellation submitted. Account status updates after provider verification.'});
 }catch{return fail(502,'Provider did not confirm test cancellation.');}
}
export async function sandboxVerifyCheckout(env:Env,userId:string,request:Request):Promise<Response>{
 if(!testConfigReady(env))return fail(503,'Test-mode subscriptions are disabled.');
 const body=await readSmallJson(request);
 if(!paymentId(body.razorpay_payment_id)||!subscriptionId(body.razorpay_subscription_id)||
   typeof body.razorpay_signature!=='string'||!/^[a-f0-9]{64}$/i.test(body.razorpay_signature))
  return fail(400,'Invalid checkout confirmation.');
 const mapped=await env.DB.prepare('SELECT provider_subscription_id FROM user_subscriptions WHERE user_id=? AND provider_subscription_id=?')
  .bind(userId,body.razorpay_subscription_id).first<{provider_subscription_id:string}>();
 if(!mapped)return fail(404,'Subscription does not belong to this account.');
 // Razorpay subscription signature: payment_id|server-stored subscription_id, NEVER browser-trusted ID.
 const expected=await hmac(env.RAZORPAY_TEST_KEY_SECRET!,body.razorpay_payment_id+'|'+mapped.provider_subscription_id);
 if(!safeHex(expected,body.razorpay_signature.toLowerCase()))return fail(401,'Invalid checkout signature.');
 return json({verified:true,mode:'test',entitlements_activated:false,
  message:'Test checkout proof verified. Paid access requires validated provider lifecycle and feature approval.'});
}
