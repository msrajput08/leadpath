import type {Env} from './types.js';
import {json} from './util.js';

type ProviderUpdate={provider:'razorpay';eventId:string;eventType:string;subscriptionId:string|null;
 status:'pending'|'active'|'past_due'|'cancelled'|'expired'|null;
 periodStart:number|null;periodEnd:number|null;cancelAtPeriodEnd:boolean;createdAt:number};

function hex(bytes:ArrayBuffer):string {
 return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
function safeEquals(a:string,b:string):boolean {
 if(a.length!==b.length)return false;
 let difference=0;
 for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);
 return difference===0;
}
async function verifyRazorpay(secret:string,body:Uint8Array,signature:string):Promise<boolean>{
 if(!/^[a-f0-9]{64}$/i.test(signature))return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const computed=hex(await crypto.subtle.sign('HMAC',key,body as BufferSource));
 return safeEquals(computed,signature.toLowerCase());
}
async function boundedBody(request:Request,max=65536):Promise<Uint8Array>{
 const length=request.headers.get('content-length');
 if(length!==null && (!/^\d+$/.test(length)||Number(length)>max))throw new Error('BODY_TOO_LARGE');
 if(!request.body)throw new Error('BODY_REQUIRED');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];
 let total=0;
 for(;;){
  const {done,value}=await reader.read();
  if(done)break;
  total+=value.byteLength;
  if(total>max){await reader.cancel().catch(()=>undefined);throw new Error('BODY_TOO_LARGE');}
  chunks.push(value);
 }
 const output=new Uint8Array(total);let offset=0;
 for(const part of chunks){output.set(part,offset);offset+=part.length;}
 return output;
}
function asUnixMs(input:unknown):number|null {
 if(typeof input!=='number'||!Number.isSafeInteger(input)||input<=0)return null;
 const ms=input*1000;return Number.isSafeInteger(ms)?ms:null;
}
function parseRazorpay(input:unknown,eventId:string,mode:'test'|'live'):ProviderUpdate|null{
 if(!input||typeof input!=='object')return null;
 const event=input as Record<string,unknown>;
 if(typeof event.event!=='string'||typeof event.created_at!=='number')return null;
 const createdAt=asUnixMs(event.created_at);
 if(!createdAt||createdAt>Date.now()+300000)return null;
 const payload=event.payload as Record<string,unknown>|undefined;
 const sub=payload?.subscription as Record<string,unknown>|undefined;
 const entity=sub?.entity as Record<string,unknown>|undefined;
 const subscriptionId=typeof entity?.id==='string'&&/^sub_[A-Za-z0-9]{3,100}$/.test(entity.id)?entity.id:null;
 const statuses:Record<string,ProviderUpdate['status']>={
  'subscription.activated':'active','subscription.charged':'active','subscription.resumed':'active',
  'subscription.cancelled':'cancelled','subscription.completed':'expired',
  'subscription.halted':'past_due','subscription.paused':'past_due',
  'subscription.pending':'pending'
 };
 const status=statuses[event.event]||null;
 // Only a signed active subscription with a valid future period may renew access.
 const periodEnd=asUnixMs(entity?.current_end);
 const verifiedCharge=mode==='test'||(typeof entity?.paid_count==='number'&&Number.isInteger(entity.paid_count)&&entity.paid_count>0);
 const validActive=status==='active'&&entity?.status==='active'&&periodEnd!==null&&periodEnd>Date.now()&&verifiedCharge;
 const cancelAtPeriodEnd=entity?.cancel_at_cycle_end===1 || entity?.cancel_at_cycle_end===true;
 // A scheduled end-of-cycle cancellation retains prepaid access only through its verified period end.
 const paidThroughCancellation=status==='cancelled'&&cancelAtPeriodEnd&&periodEnd!==null&&periodEnd>Date.now()&&verifiedCharge;
 return {provider:'razorpay',eventId,eventType:event.event,subscriptionId,
  status:paidThroughCancellation?'active':status==='active'&&!validActive?'pending':status,
  periodStart:asUnixMs(entity?.current_start),periodEnd,
  cancelAtPeriodEnd,
  createdAt};
}
// Adapter boundary: a later provider implementation must produce a verified,
// normalized ProviderUpdate and must match a pre-provisioned server-side subscription.
// The public API cannot create billing mappings or grant its own entitlement.
export async function razorpayWebhook(req:Request,env:Env,mode:'test'|'live'='test'):Promise<Response>{
 const enabled=mode==='live'?env.LIVE_BILLING_WEBHOOKS_ENABLED==='true':env.BILLING_WEBHOOKS_ENABLED==='true';
 const secret=mode==='live'?env.RAZORPAY_LIVE_WEBHOOK_SECRET:env.RAZORPAY_WEBHOOK_SECRET;
 if(!enabled||!secret) return json({error:'Billing webhook not enabled'},503);
 const signature=req.headers.get('x-razorpay-signature')||'';
 const eventId=req.headers.get('x-razorpay-event-id')||'';
 if(!/^[A-Za-z0-9_-]{4,128}$/.test(eventId))return json({error:'Missing event identifier'},400);
 let body:Uint8Array;
 try{body=await boundedBody(req);}catch{return json({error:'Invalid event body'},413);}
 if(!(await verifyRazorpay(secret,body,signature)))return json({error:'Invalid signature'},401);
 let parsed:unknown;
 try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}
 catch{return json({error:'Invalid JSON'},400);}
 const update=parseRazorpay(parsed,eventId,mode);
 if(!update)return json({error:'Invalid event'},400);
 // A signed Live webhook must carry the exact approved Live plan ID.
 if(mode==='live'&&update.status){
  const entity=(parsed as {payload?:{subscription?:{entity?:{plan_id?:unknown}}}}).payload?.subscription?.entity;
  if(entity?.plan_id!==env.RAZORPAY_LIVE_STARTER_PLAN_ID&&entity?.plan_id!==env.RAZORPAY_LIVE_PRO_PLAN_ID)
   return json({error:'Unrecognized subscription plan'},400);
 }
 const fingerprint=hex(await crypto.subtle.digest('SHA-256',body as BufferSource));
 const scopedEventId=mode==='live'?'live_'+update.eventId:update.eventId;
 const time=Date.now();
 // D1 batch is atomic. Duplicate and delayed updates never grant additional access.
 // Mapping uses only a prior trusted local subscription ID, NEVER webhook notes/email.
 const batch=[
  env.DB.prepare(`INSERT OR IGNORE INTO payment_events
   (provider,event_id,event_type,provider_subscription_id,body_sha256,received_at)
   VALUES(?,?,?,?,?,?)`)
    .bind(update.provider,scopedEventId,update.eventType,update.subscriptionId,fingerprint,time),
  ...(update.status&&update.subscriptionId?[env.DB.prepare(`UPDATE user_subscriptions
   SET status=?,current_period_start=COALESCE(?,current_period_start),
    current_period_end=COALESCE(?,current_period_end),cancel_at_period_end=?,
    last_event_at=?,updated_at=?
   WHERE provider=? AND provider_subscription_id=? AND billing_mode=? AND last_event_at<?
   AND EXISTS (SELECT 1 FROM payment_events WHERE provider=? AND event_id=? AND body_sha256=?)`)
    .bind(update.status||'pending',update.periodStart,update.periodEnd,update.cancelAtPeriodEnd?1:0,
      update.createdAt,time,update.provider,update.subscriptionId,mode,update.createdAt,
      update.provider,scopedEventId,fingerprint)]:[]),
  ...(mode==='live'&&update.subscriptionId&&(update.status==='cancelled'||update.status==='expired')?
   [env.DB.prepare(`DELETE FROM live_billing_slots WHERE provider_subscription_id=?
    AND EXISTS (SELECT 1 FROM user_subscriptions WHERE provider_subscription_id=?
     AND billing_mode='live' AND status IN ('cancelled','expired'))`)
    .bind(update.subscriptionId,update.subscriptionId)]:[])
 ];
 await env.DB.batch(batch);
 return json({ok:true});
}
