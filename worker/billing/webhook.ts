import type { Env } from '../types.js';
import type { Subscription } from '../entitlements.js';
import { json, InputError } from '../util.js';
import { sha256 } from '../security.mjs';
import { PaddleProvider } from './paddle.js';
import { BillingError, type BillingProvider } from './provider.js';

async function rawBody(req:Request):Promise<string>{
 if(!(req.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))throw new InputError(415,'Expected application/json');
 const reader=req.body?.getReader();if(!reader)throw new InputError(400,'Missing body');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new InputError(413,'Request body too large');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new InputError(400,'Invalid encoding');}
}
export async function processBillingWebhook(req: Request,env: Env,provider: BillingProvider):Promise<Response>{
 const time=Date.now(),raw=await rawBody(req);
 const event=await provider.verify(raw,req.headers.get(provider.signatureHeader)||'',time);
 // Notification IDs may change on provider replay. Hash the verified event identity,
 // not transport metadata/custom_data (neither can grant access).
 const hash=await sha256(JSON.stringify(event)),lease=crypto.randomUUID();
 const key=[provider.name,provider.environment,event.id];
 const claimed=await env.DB.prepare(`INSERT INTO payment_events
  (provider,environment,event_id,event_hash,event_type,subscription_id,occurred_at,status,lease_token,lease_until,received_at)
  VALUES(?,?,?,?,?,?,?,'processing',?,?,?) ON CONFLICT(provider,environment,event_id) DO UPDATE SET
  status='processing',lease_token=excluded.lease_token,lease_until=excluded.lease_until,attempts=payment_events.attempts+1
  WHERE payment_events.event_hash=excluded.event_hash AND payment_events.status IN ('failed','processing')
  AND payment_events.lease_until<=? AND payment_events.attempts<8`)
  .bind(...key,hash,event.type,event.subscriptionId,event.occurredAt,lease,time+30000,time,time).run();
 if(!claimed.meta.changes){
  const existing=await env.DB.prepare('SELECT event_hash,status,attempts FROM payment_events WHERE provider=? AND environment=? AND event_id=?').bind(...key).first<{event_hash:string;status:string;attempts:number}>();
  if(existing?.event_hash!==hash)return json({error:'Event ID conflict'},409);
  if(existing.status==='processed'||existing.status==='ignored')return json({ok:true,duplicate:true});
  return json({error:existing.attempts>=8?'Event requires operator review':'Event processing; retry later'},503,{'Retry-After':'30'});
 }
 try{
  const subscription=event.subscriptionId?await env.DB.prepare('SELECT * FROM subscriptions WHERE provider=? AND provider_environment=? AND provider_subscription_id=?')
   .bind(provider.name,provider.environment,event.subscriptionId).first<Subscription>():null;
  // Never bind by email, custom_data.user_id, customer-supplied plan or checkout redirect.
  // Unknown subscriptions retry; an operator must investigate a missing trusted binding.
  if(!subscription && event.subscriptionId)throw new BillingError('UNKNOWN_SUBSCRIPTION');
  if(!subscription || !/^(subscription\.|transaction\.|adjustment\.)/.test(event.type)){
   await env.DB.prepare("UPDATE payment_events SET status='ignored',processed_at=?,lease_until=0 WHERE provider=? AND environment=? AND event_id=? AND lease_token=?").bind(time,...key,lease).run();
   return json({ok:true,ignored:true});
  }
  const snapshot=await provider.readSubscription(subscription);
  if(snapshot.subscriptionId!==subscription.provider_subscription_id || snapshot.customerId!==subscription.provider_customer_id)throw new BillingError('BINDING_MISMATCH');
  const price=await env.DB.prepare('SELECT plan_id FROM billing_prices WHERE provider=? AND environment=? AND price_id=?').bind(provider.name,provider.environment,snapshot.priceId).first<{plan_id:string}>();
  if(!price)throw new BillingError('UNMAPPED_PRICE');
  const updatedAt=Date.now();
  const result=await env.DB.batch<{meta:{changes:number}}>([
   env.DB.prepare(`UPDATE subscriptions SET plan_id=?,status=?,provider_price_id=?,period_start=?,period_end=?,paid_through=?,
    cancel_at_period_end=?,canceled_at=?,provider_updated_at=?,last_event_at=?,last_verified_at=?,updated_at=?
    WHERE user_id=? AND provider=? AND provider_environment=? AND provider_subscription_id=?
    AND provider_updated_at<=? AND last_event_at<=?
    AND EXISTS(SELECT 1 FROM payment_events WHERE provider=? AND environment=? AND event_id=? AND lease_token=? AND status='processing')`)
    .bind(price.plan_id,snapshot.status,snapshot.priceId,snapshot.periodStart,snapshot.periodEnd,snapshot.paidThrough,
     snapshot.cancelAtPeriodEnd?1:0,snapshot.canceledAt,snapshot.updatedAt,event.occurredAt,updatedAt,updatedAt,
     subscription.user_id,provider.name,provider.environment,snapshot.subscriptionId,snapshot.updatedAt,event.occurredAt,...key,lease),
   env.DB.prepare("UPDATE payment_events SET status='processed',processed_at=?,lease_until=0,error_code=NULL WHERE provider=? AND environment=? AND event_id=? AND lease_token=? AND status='processing'")
    .bind(updatedAt,...key,lease)
  ]);
  if(!result[1]?.meta.changes)return json({error:'Processing lease changed; retry required'},503);
  return json({ok:true,applied:!!result[0]?.meta.changes});
 }catch(error){
  const code=error instanceof BillingError?error.code:'PROCESSING_FAILED';
  await env.DB.prepare("UPDATE payment_events SET status='failed',lease_until=0,error_code=? WHERE provider=? AND environment=? AND event_id=? AND lease_token=? AND status='processing'")
   .bind(code,...key,lease).run();
  return json({error:'Billing event could not be verified; retry required'},503,{'Retry-After':'30'});
 }
}
export async function billingWebhook(req:Request,env:Env):Promise<Response>{
 if(env.BILLING_WEBHOOKS_ENABLED!=='true')return json({error:'Billing is disabled'},503);
 if(env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:'billing-webhook:'+(req.headers.get('CF-Connecting-IP')||'anonymous')})).success)return json({error:'Rate limit exceeded'},429);
 try{return await processBillingWebhook(req,env,new PaddleProvider(env));}
 catch(error){if(error instanceof BillingError)return json({error:error.status===401?'Invalid webhook signature':'Billing verification unavailable'},error.status);throw error;}
}
