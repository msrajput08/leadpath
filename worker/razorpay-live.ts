import type {Env} from './types.js';
import {json,fail,readSmallJson} from './util.js';

type LivePlan='starter'|'pro';
type PlanRow={currency:string;price_minor_units:number;interval_seconds:number};
type RazorpayPlan={id?:string;period?:string;interval?:number;item?:{currency?:string;amount?:number}};
type RazorpaySubscription={id?:string;plan_id?:string;status?:string;short_url?:string;current_start?:number|null;
 current_end?:number|null;cancel_at_cycle_end?:boolean|number;paid_count?:number;customer_id?:string|null;};
type SubscriptionRow={provider_subscription_id:string;plan_code:LivePlan;status:string};
const validPlan=(value:unknown):value is string=>typeof value==='string'&&/^plan_[A-Za-z0-9]{6,80}$/.test(value);
const validSubscription=(value:unknown):value is string=>typeof value==='string'&&/^sub_[A-Za-z0-9]{3,100}$/.test(value);
const validPayment=(value:unknown):value is string=>typeof value==='string'&&/^pay_[A-Za-z0-9]{3,100}$/.test(value);
const validGatewayUrl=(value:unknown):value is string=>{
 try{const u=new URL(String(value));return u.protocol==='https:'&&u.hostname==='rzp.io'&&!u.username&&!u.password;}
 catch{return false;}
};
export function liveApiReady(env:Env):boolean {
 return !!(env.RAZORPAY_LIVE_KEY_ID?.startsWith('rzp_live_')&&
  env.RAZORPAY_LIVE_KEY_SECRET&&validPlan(env.RAZORPAY_LIVE_STARTER_PLAN_ID)&&validPlan(env.RAZORPAY_LIVE_PRO_PLAN_ID));
}
export function liveCheckoutReady(env:Env):boolean {
 // No live charge can be attempted accidentally by deploying the code or configuring keys alone.
 const pilotMax=Number(env.LIVE_MAX_PAID_ACCOUNTS);
 const batch=Number(env.SCHEDULE_BATCH_LIMIT);
 // Initial paid release offers Starter only to one account; Pro requires a separate capacity audit.
 return env.LIVE_PILOT_PLAN==='starter'&&liveApiReady(env)&&env.LIVE_BILLING_ENABLED==='true'&&
  env.LIVE_BILLING_WEBHOOKS_ENABLED==='true'&&!!env.RAZORPAY_LIVE_WEBHOOK_SECRET&&
  env.PAID_ENTITLEMENTS_ENABLED==='true'&&env.LIVE_CAPACITY_REVIEWED==='true'&&
  Number.isInteger(pilotMax)&&pilotMax===1&&
  Number.isInteger(batch)&&batch>=6&&batch<=10;
}

class ProviderError extends Error {
 constructor(readonly status:number){super('Razorpay live provider status '+status);}
}
async function razorpay<T>(env:Env,method:'GET'|'POST',path:string,payload?:unknown):Promise<T>{
 if(!liveApiReady(env))throw new Error('LIVE_KEYS_DISABLED');
 // The path is only constructed from validated plan/subscription IDs, never untrusted URLs.
 const result=await fetch('https://api.razorpay.com/v1/'+path,{
  method,redirect:'manual',signal:AbortSignal.timeout(9000),
  headers:{Authorization:'Basic '+btoa(env.RAZORPAY_LIVE_KEY_ID+':'+env.RAZORPAY_LIVE_KEY_SECRET),
   'content-type':'application/json'},
  body:payload===undefined?undefined:JSON.stringify(payload)
 });
 if(!result.ok)throw new ProviderError(result.status);
 return result.json() as Promise<T>;
}
const providerFailed=(e:unknown)=>fail(502,
 e instanceof ProviderError?'Razorpay live API rejected the request (HTTP '+e.status+').':
 'Razorpay live API unavailable. No access or charge status was changed.');
async function validatedPlan(env:Env,code:LivePlan):Promise<{providerId:string;row:PlanRow}|Response>{
 const row=await env.DB.prepare('SELECT currency,price_minor_units,interval_seconds FROM subscription_plans WHERE code=?')
  .bind(code).first<PlanRow>();
 if(!row||row.currency!=='INR'||row.price_minor_units<=0)return fail(503,'Live INR plan catalog is unavailable.');
 const providerId=code==='starter'?env.RAZORPAY_LIVE_STARTER_PLAN_ID!:env.RAZORPAY_LIVE_PRO_PLAN_ID!;
 let remote:RazorpayPlan;
 try{remote=await razorpay<RazorpayPlan>(env,'GET','plans/'+providerId);}
 catch(e){return providerFailed(e);}
 if(remote.id!==providerId||remote.period!=='monthly'||remote.interval!==1||
    remote.item?.amount!==row.price_minor_units||remote.item?.currency!=='INR')
  return fail(503,'Razorpay Live plan amount/currency/period mismatch. Payments remain disabled for this plan.');
 return {providerId,row};
}
export async function createLiveSubscription(env:Env,userId:string,req:Request):Promise<Response>{
 if(!liveCheckoutReady(env))return fail(503,'Live billing is not enabled or monitoring capacity was not approved.');
 const body=await readSmallJson(req),code=body.plan_code;
 if(code!=='starter'&&code!=='pro')return fail(400,'Choose Starter or Pro.');
 if(code!=='starter')return fail(403,'Pro subscriptions are not available in the limited launch.');
 const existing=await env.DB.prepare(`SELECT id FROM user_subscriptions WHERE user_id=? AND billing_mode='live'
  AND status IN ('pending','active','past_due') LIMIT 1`).bind(userId).first();
 if(existing)return fail(409,'A live subscription is already attached to this account. Cancel or contact support first.');
 const validated=await validatedPlan(env,code);
 if(validated instanceof Response)return validated;
 const time=Date.now(),max=Number(env.LIVE_MAX_PAID_ACCOUNTS),nonce=crypto.randomUUID();
 // Atomic reserve across all accounts; never oversell capacity with two concurrent checkouts.
 const reserved=await env.DB.prepare(`INSERT OR IGNORE INTO live_billing_slots
 (user_id,plan_code,created_at,updated_at)
 SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM live_billing_slots)<?`)
  .bind(userId,code,time,time,max).run();
 if(!reserved.meta.changes)return fail(409,'Live subscription capacity is full, or this account has an in-progress checkout.');
 const lock=await env.DB.prepare(`INSERT INTO billing_creation_locks(user_id,nonce,locked_until,created_at)
 VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET nonce=excluded.nonce,locked_until=excluded.locked_until,
 created_at=excluded.created_at WHERE billing_creation_locks.locked_until<?`)
 .bind(userId,nonce,time+1800000,time,time).run();
 if(!lock.meta.changes)return fail(409,'Another checkout is already running for this account.');
 let created:RazorpaySubscription;
 try{
  created=await razorpay<RazorpaySubscription>(env,'POST','subscriptions',
   {plan_id:validated.providerId,total_count:12,quantity:1,customer_notify:true,
    notes:{app:'LeadPath',checkout_nonce:nonce}});
 }catch(e){
  // Definite 4xx rejection means Razorpay did not create a subscription.
  // Timeouts and 5xx are uncertain, so retain the reservation for safe manual reconciliation.
  if(e instanceof ProviderError&&e.status>=400&&e.status<500&&e.status!==408){
   await env.DB.batch([
    env.DB.prepare('DELETE FROM live_billing_slots WHERE user_id=? AND provider_subscription_id IS NULL').bind(userId),
    env.DB.prepare('DELETE FROM billing_creation_locks WHERE user_id=? AND nonce=?').bind(userId,nonce)
   ]);
  }
  return providerFailed(e);
 }
 if(!validSubscription(created.id)||created.plan_id!==validated.providerId||!validGatewayUrl(created.short_url))
  return fail(502,'Unexpected live subscription response. Contact support before trying another checkout.');
 try{
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO user_subscriptions
    (id,user_id,plan_code,provider,provider_subscription_id,status,created_at,updated_at,billing_mode)
    SELECT ?,?,?,'razorpay',?,'pending',?,?,'live'
    WHERE EXISTS(SELECT 1 FROM billing_creation_locks WHERE user_id=? AND nonce=?)`)
    .bind(crypto.randomUUID(),userId,code,created.id,time,time,userId,nonce),
   env.DB.prepare('UPDATE live_billing_slots SET provider_subscription_id=?,updated_at=? WHERE user_id=? AND provider_subscription_id IS NULL')
    .bind(created.id,time,userId)
  ]);
 }catch{return fail(502,'Provider accepted subscription but local setup requires support reconciliation. Do not retry.');}
 return json({mode:'live',plan_code:code,checkout_url:created.short_url,
  provider_subscription_id:created.id,
  notice:'Live recurring payments. Authorization may charge your chosen payment method monthly, for up to 12 billing cycles. Cancel future renewals from Account.'},201);
}
async function owned(env:Env,userId:string):Promise<SubscriptionRow|null>{
 return env.DB.prepare(`SELECT provider_subscription_id,plan_code,status FROM user_subscriptions WHERE
  user_id=? AND billing_mode='live' ORDER BY updated_at DESC LIMIT 1`)
  .bind(userId).first<SubscriptionRow>();
}
function verifiedStatus(sub:RazorpaySubscription):{status:string;start:number|null;end:number|null;cancel:boolean}{
 const t=Date.now(),end=Number.isSafeInteger(sub.current_end)?Number(sub.current_end)*1000:null,
 start=Number.isSafeInteger(sub.current_start)?Number(sub.current_start)*1000:null;
 const paid=Number.isInteger(sub.paid_count)&&Number(sub.paid_count)>0;
 const within=paid&&end!==null&&end>t;
 const cancel=sub.cancel_at_cycle_end===true||sub.cancel_at_cycle_end===1;
 if(sub.status==='active'&&within)return {status:'active',start,end,cancel};
 if(sub.status==='cancelled'&&cancel&&within)return {status:'active',start,end,cancel:true};
 if(sub.status==='cancelled')return {status:'cancelled',start,end,cancel};
 if(sub.status==='expired'||sub.status==='completed')return {status:'expired',start,end,cancel};
 if(sub.status==='pending'||sub.status==='halted'||sub.status==='paused')return {status:'past_due',start,end,cancel};
 return {status:'pending',start,end,cancel};
}
export async function syncLiveSubscription(env:Env,userId:string):Promise<Response>{
 if(!liveApiReady(env))return fail(503,'Live provider unavailable.');
 const record=await owned(env,userId);
 if(!record||!validSubscription(record.provider_subscription_id))return fail(404,'No live subscription linked to this account.');
 let sub:RazorpaySubscription;
 try{sub=await razorpay<RazorpaySubscription>(env,'GET','subscriptions/'+record.provider_subscription_id);}
 catch(e){return providerFailed(e);}
 const planId=record.plan_code==='starter'?env.RAZORPAY_LIVE_STARTER_PLAN_ID:env.RAZORPAY_LIVE_PRO_PLAN_ID;
 if(sub.id!==record.provider_subscription_id||sub.plan_id!==planId)return fail(502,'Live provider subscription mismatch.');
 const normalized=verifiedStatus(sub),t=Date.now();
 await env.DB.prepare(`UPDATE user_subscriptions SET status=?,current_period_start=?,
  current_period_end=?,cancel_at_period_end=?,updated_at=?,last_event_at=?
  WHERE user_id=? AND provider_subscription_id=? AND billing_mode='live'`)
  .bind(normalized.status,normalized.start,normalized.end,normalized.cancel?1:0,t,t,
   userId,record.provider_subscription_id).run();
 if(normalized.status==='cancelled'||normalized.status==='expired')
  await env.DB.prepare('DELETE FROM live_billing_slots WHERE user_id=? AND provider_subscription_id=?')
   .bind(userId,record.provider_subscription_id).run();
 return json({status:normalized.status,cancel_at_period_end:normalized.cancel,
  current_period_end:normalized.end,paid_access:normalized.status==='active'&&env.PAID_ENTITLEMENTS_ENABLED==='true'});
}
export async function cancelLiveSubscription(env:Env,userId:string):Promise<Response>{
 // Cancellation remains available after disabling new sales.
 if(!liveApiReady(env))return fail(503,'Live cancellations temporarily unavailable; contact support.');
 const record=await owned(env,userId);
 if(!record||!validSubscription(record.provider_subscription_id))return fail(404,'No live subscription to cancel.');
 if(record.status==='cancelled'||record.status==='expired')return json({ok:true,message:'Subscription already ended.'});
 let response:RazorpaySubscription;
 try{
  response=await razorpay<RazorpaySubscription>(env,'POST','subscriptions/'+record.provider_subscription_id+'/cancel',
   {cancel_at_cycle_end:record.status==='active'});
 }catch(e){return providerFailed(e);}
 if(response.id!==record.provider_subscription_id)return fail(502,'Provider cancellation response did not match your subscription.');
 // A confirmed direct provider response can update the local record without waiting for an unreliable webhook.
 return syncLiveSubscription(env,userId);
}
export async function confirmLiveCheckout(env:Env,userId:string,req:Request):Promise<Response>{
 if(!liveApiReady(env))return fail(503,'Live provider unavailable.');
 const input=await readSmallJson(req);
 if(!validSubscription(input.razorpay_subscription_id)||!validPayment(input.razorpay_payment_id)||
    typeof input.razorpay_signature!=='string'||!/^[a-f0-9]{64}$/i.test(input.razorpay_signature))
  return fail(400,'Invalid subscription proof.');
 const record=await owned(env,userId);
 if(!record||record.provider_subscription_id!==input.razorpay_subscription_id)
  return fail(404,'Subscription is not linked to this account.');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.RAZORPAY_LIVE_KEY_SECRET!),
  {name:'HMAC',hash:'SHA-256'},false,['sign']);
 const data=new TextEncoder().encode(input.razorpay_payment_id+'|'+record.provider_subscription_id);
 const sig=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,data)),v=>v.toString(16).padStart(2,'0')).join('');
 const submitted=input.razorpay_signature.toLowerCase(),match=sig.length===submitted.length&&
  [...sig].reduce((delta,c,i)=>delta|(c.charCodeAt(0)^submitted.charCodeAt(i)),0)===0;
 if(!match)return fail(401,'Invalid subscription proof.');
 // Never activate from Checkout fields alone: independently fetch the live subscription from Razorpay.
 return syncLiveSubscription(env,userId);
}
