import type { Env } from '../types.js';
import type { Subscription } from '../entitlements.js';
import { constantTimeEqual } from '../security.mjs';
import { BillingError, type BillingEvent, type BillingProvider, type VerifiedSubscription } from './provider.js';
const encoder=new TextEncoder();
const object=(value: unknown): Record<string,any> => {
 if (!value || typeof value!=='object' || Array.isArray(value)) throw new BillingError('PROVIDER_SCHEMA');
 return value as Record<string,any>;
};
const timestamp=(value: unknown): number | null => {
 if (value===null || value===undefined) return null;
 if (typeof value!=='string' || !Number.isFinite(Date.parse(value))) throw new BillingError('PROVIDER_DATE');
 return Date.parse(value);
};
const idValid=(value:unknown,prefix:string):value is string=>typeof value==='string'&&new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value);
export class PaddleProvider implements BillingProvider {
 readonly name='paddle';
 readonly signatureHeader='Paddle-Signature';
 readonly environment: 'sandbox' | 'live';
 private origin: string;
 constructor(private env: Env) {
  if (env.BILLING_MODE!=='sandbox' && !(env.BILLING_MODE==='live' && env.BILLING_LIVE_APPROVED==='true')) throw new BillingError('BILLING_DISABLED');
  if (!env.PADDLE_API_KEY || !env.PADDLE_WEBHOOK_SECRET) throw new BillingError('BILLING_UNCONFIGURED');
  this.environment=env.BILLING_MODE as 'sandbox'|'live';
  this.origin=this.environment==='sandbox'?'https://sandbox-api.paddle.com':'https://api.paddle.com';
 }
 async verify(raw: string,signature: string,time: number): Promise<BillingEvent> {
  const fields=signature.split(';').map(p=>p.trim().split('='));
  const times=fields.filter(([k])=>k==='ts').map(([,v])=>v);
  const sigs=fields.filter(([k])=>k==='h1').map(([,v])=>v);
  if(times.length!==1 || !/^\d{10}$/.test(times[0]) || sigs.length<1 || sigs.length>2 ||
   !sigs.every(v=>/^[a-f0-9]{64}$/.test(v)) || Math.abs(time-Number(times[0])*1000)>300000) throw new BillingError('INVALID_SIGNATURE',401);
  const key=await crypto.subtle.importKey('raw',encoder.encode(this.env.PADDLE_WEBHOOK_SECRET!),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(`${times[0]}:${raw}`)));
  const expected=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  if(!sigs.some(s=>constantTimeEqual(s,expected))) throw new BillingError('INVALID_SIGNATURE',401);
  let body: Record<string,any>;
  try { body=object(JSON.parse(raw)); } catch { throw new BillingError('INVALID_EVENT',400); }
  if(!idValid(body.event_id,'evt') || typeof body.event_type!=='string' || body.event_type.length>80) throw new BillingError('INVALID_EVENT',400);
  const occurredAt=timestamp(body.occurred_at);
  if(occurredAt===null || occurredAt>time+300000) throw new BillingError('INVALID_EVENT',400);
  const data=object(body.data);
  const subscriptionId=body.event_type.startsWith('subscription.')?data.id:data.subscription_id;
  return {id:body.event_id,type:body.event_type,occurredAt,subscriptionId:idValid(subscriptionId,'sub')?subscriptionId:null};
 }
 private async get(path: string): Promise<any> {
  let res: Response;
  try { res=await fetch(this.origin+path,{headers:{Authorization:`Bearer ${this.env.PADDLE_API_KEY}`,'Paddle-Version':'1'},redirect:'error',signal:AbortSignal.timeout(3500)}); }
  catch { throw new BillingError('PROVIDER_UNAVAILABLE'); }
  if(!res.ok) {await res.body?.cancel();throw new BillingError('PROVIDER_UNAVAILABLE');}
  // Bound provider responses too; never persist raw billing/customer/card payloads.
  const reader=res.body?.getReader();if(!reader)throw new BillingError('PROVIDER_SCHEMA');
  const chunks: Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){await reader.cancel();throw new BillingError('PROVIDER_SIZE');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return object(JSON.parse(new TextDecoder().decode(bytes))).data;}catch{throw new BillingError('PROVIDER_SCHEMA');}
 }
 async readSubscription(binding: Subscription): Promise<VerifiedSubscription> {
  if(!idValid(binding.provider_subscription_id,'sub'))throw new BillingError('UNKNOWN_SUBSCRIPTION');
  const sub=object(await this.get('/subscriptions/'+binding.provider_subscription_id));
  if(sub.id!==binding.provider_subscription_id || sub.customer_id!==binding.provider_customer_id) throw new BillingError('BINDING_MISMATCH');
  if(!Array.isArray(sub.items)||sub.items.length!==1||sub.items[0].quantity!==1) throw new BillingError('UNSUPPORTED_ITEMS');
  const price=object(sub.items[0].price);
  if(!idValid(price.id,'pri') || price.billing_cycle?.interval!=='month' || price.billing_cycle?.frequency!==1) throw new BillingError('UNSUPPORTED_PRICE');
  const states=['active','trialing','past_due','paused','canceled'];
  if(!states.includes(sub.status)) throw new BillingError('UNSUPPORTED_STATE');
  const periodStart=timestamp(sub.current_billing_period?.starts_at),periodEnd=timestamp(sub.current_billing_period?.ends_at),updatedAt=timestamp(sub.updated_at);
  if(updatedAt===null || (periodStart!==null && periodEnd!==null && periodEnd<=periodStart)) throw new BillingError('PROVIDER_DATE');
  let paidThrough: number | null=null;
  // An active subscription is insufficient: independently confirm a completed
  // recurring payment covering this exact period and reject refunded/disputed funds.
  if(sub.status==='active' && periodStart!==null && periodEnd!==null){
   const transactions=await this.get('/transactions?subscription_id='+sub.id+'&status=completed&order_by=id%5BDESC%5D&per_page=5');
   if(!Array.isArray(transactions))throw new BillingError('PROVIDER_SCHEMA');
   for(const t of transactions){
    if(t.subscription_id!==sub.id || t.customer_id!==sub.customer_id || t.status!=='completed' ||
     timestamp(t.billing_period?.starts_at)!==periodStart || timestamp(t.billing_period?.ends_at)!==periodEnd ||
     !Array.isArray(t.items) || t.items.length!==1 || t.items[0].price?.id!==price.id || t.items[0].quantity!==1) continue;
    if(!t.details?.totals || !/^\d+$/.test(t.details.totals.total) || Number(t.details.totals.total)<=0)continue;
    if(!idValid(t.id,'txn'))throw new BillingError('PROVIDER_SCHEMA');
    const adjustments=await this.get('/adjustments?transaction_id='+t.id+'&status=approved&action=refund,credit,chargeback,chargeback_warning&per_page=1');
    if(!Array.isArray(adjustments))throw new BillingError('ADJUSTMENTS_REQUIRED');
    // Even partial refunds suspend access pending policy review; do not fall back
    // to an older payment for the same period after the newest was reversed.
    if(adjustments.length===0)paidThrough=periodEnd;
    break;
   }
  }
  return {subscriptionId:sub.id,customerId:sub.customer_id,priceId:price.id,status:sub.status,
   periodStart,periodEnd,paidThrough,cancelAtPeriodEnd:sub.scheduled_change?.action==='cancel',
   canceledAt:timestamp(sub.canceled_at),updatedAt};
 }
}
