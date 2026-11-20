import React,{useEffect,useState} from 'react';
import {CheckCircle2,Clock3,ShieldCheck} from 'lucide-react';
type Plan={code:string;display_name:string;currency:string;price_minor_units:number;monitor_limit:number;interval_seconds:number;operationally_available:boolean};
const formatPrice=(plan:Plan)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:plan.currency,maximumFractionDigits:0}).format(plan.price_minor_units/100);
type Details={current:Plan;plans:Plan[];monitor_count:number;usage:{manual_checks:number;scheduled_checks:number};
 subscription:null|{status:string;plan_code:string;billing_mode?:string;current_period_end:number|null;cancel_at_period_end:boolean};
 checkout_enabled:boolean;live_pilot_plan?:string|null;sandbox_checkout_enabled?:boolean};
export default function BillingPanel({compact=false,csrfToken}:{compact?:boolean;csrfToken?:string}){
 const [details,setDetails]=useState<Details|null>(null);
 const [message,setMessage]=useState('');
 const [sandboxBusy,setSandboxBusy]=useState(false);
 const [sandboxUrl,setSandboxUrl]=useState('');
 const [sandboxMessage,setSandboxMessage]=useState('');
 const [liveBusy,setLiveBusy]=useState(false);
 const [liveStatus,setLiveStatus]=useState('');
 async function liveAction(path:string,body:unknown={}){
  setLiveBusy(true);setLiveStatus('');
  try{
   const r=await fetch(path,{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json','X-CSRF-Token':csrfToken||''},body:JSON.stringify(body)});
   const result=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(result.error||'Live subscription operation failed.');
   if(result.checkout_url){
    const u=new URL(result.checkout_url);
    if(u.protocol!=='https:'||u.hostname!=='rzp.io')throw new Error('Invalid Razorpay hosted URL.');
    window.location.assign(u.toString());
   } else {
    setLiveStatus(result.message||'Your Razorpay subscription status has been updated.');
    const updated=await fetch('/api/billing',{credentials:'same-origin'});
    if(updated.ok)setDetails(await updated.json());
   }
  }catch(e){setLiveStatus(e instanceof Error?e.message:'Live subscription request failed.');}
  finally{setLiveBusy(false);}
 }
 async function sandboxAction(path:string,body:unknown={}){
  setSandboxBusy(true);setSandboxMessage('Connecting to Razorpay Test Mode…');setSandboxUrl('');
  try {
   const response=await fetch(path,{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json','X-CSRF-Token':csrfToken||''},body:JSON.stringify(body)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||'Sandbox request failed');
   if(result.checkout_url){
    const link=new URL(result.checkout_url);
    if(link.protocol!=='https:'||link.hostname!=='rzp.io')throw new Error('Invalid hosted checkout URL');
    setSandboxUrl(link.toString());
    setSandboxMessage('Test checkout created. Opening Razorpay…');
    window.location.assign(link.toString());
   } else setSandboxMessage(result.message||'Test cancellation submitted.');
  }catch(error){setSandboxMessage(error instanceof Error?error.message:'Sandbox request failed');}
  finally{setSandboxBusy(false);}
 }
 useEffect(()=>{
  let live=true;
  fetch('/api/billing',{credentials:'same-origin'}).then(async res=>{
   if(!res.ok)throw new Error('Billing details are temporarily unavailable.');
   return res.json();
  }).then(data=>{if(live)setDetails(data);}).catch(e=>{if(live)setMessage(e.message);});
  return ()=>{live=false;};
 },[]);
 return <section className="panel dashboard-box subscription-panel" aria-labelledby="subscription-heading">
  <div className="box-header"><div><span className="eyebrow">SUBSCRIPTIONS</span><h2 id="subscription-heading">Plan & usage</h2></div><span className="subscription-soon">{details?.checkout_enabled?'INR subscriptions available':'Paid plans coming soon'}</span></div>
  {message&&<p className="small muted" role="status">{message}</p>}
  {details&&<>
   <div className="subscription-summary">
    <div><span className="small muted">CURRENT PLAN</span><strong>{details.current.display_name}</strong><small>{formatPrice(details.current)}/month{details.current.code==='free'?' · No payment method required':' · Razorpay recurring subscription'}</small></div>
    <div><span className="small muted">MONITORS</span><strong>{details.monitor_count} / {details.current.monitor_limit}</strong><small>Saved workflows</small></div>
    <div><span className="small muted">THIS MONTH (UTC)</span><strong>{details.usage.scheduled_checks+details.usage.manual_checks}</strong><small>{details.usage.scheduled_checks} automatic · {details.usage.manual_checks} manual</small></div>
   </div>
   {details.subscription&&<p className="small muted">Billing record: {details.subscription.status}.
    {details.subscription.current_period_end?' Period ends '+new Date(details.subscription.current_period_end).toLocaleDateString()+'.':''}
    {details.subscription.cancel_at_period_end?' Cancellation scheduled.':''}
    {details.subscription.billing_mode==='live'?' Use the controls below to refresh payment status or cancel future renewals.':' Sandbox authorization does not activate paid monitoring.'}</p>}
   {!compact&&<div className="subscription-comparison">{details.plans.map(p=><div className="subscription-tier" key={p.code}>
    <span className="small muted">{p.code==='free'?'AVAILABLE NOW':details.checkout_enabled&&p.code==='starter'?'LIMITED PAID PILOT · INDIA ONLY':'PROPOSED · NOT FOR SALE'}</span>
    <h3>{p.display_name}</h3><strong className="subscription-price">{formatPrice(p)}<small> /month</small></strong>
    <p className="small">{p.monitor_limit} monitor{p.monitor_limit===1?'':'s'} · target every {p.interval_seconds===21600?'6 hours':p.interval_seconds===3600?'hour':'15 minutes'}</p>
    <span className="small muted">{p.code==='free'?<><CheckCircle2 size={14}/> Current service</>:<><Clock3 size={14}/> {details.checkout_enabled&&p.code==='starter'?'Paid monitoring · best-effort schedules':'Frequency and billing pending validation'}</>}</span>
   </div>)}</div>}
   {(details.checkout_enabled||details.subscription?.billing_mode==='live')&&csrfToken&&<div className="sandbox-controls">
    <h3>{details.subscription?.billing_mode==='live'?'Manage your live subscription':'Choose your monthly subscription'}</h3>
    {details.checkout_enabled&&<p className="small">Starter is available to one approved Indian pilot customer only. Razorpay Live Mode authorizes real monthly recurring payments (up to 12 cycles). Review the price and payment terms before confirming. Pro is not available for purchase yet.</p>}
    <div className="row-inline wrap">
     {details.checkout_enabled&&<button type="button" className="btn btn-primary" disabled={liveBusy||(details.subscription?.billing_mode==='live'&&['pending','active','past_due'].includes(details.subscription.status))}
      onClick={()=>liveAction('/api/billing/live/create',{plan_code:'starter'})}>Subscribe to Starter · ₹799/mo</button>}
     {details.checkout_enabled&&details.live_pilot_plan!=='starter'&&<button type="button" className="btn btn-secondary" disabled={liveBusy||(details.subscription?.billing_mode==='live'&&['pending','active','past_due'].includes(details.subscription.status))}
      onClick={()=>liveAction('/api/billing/live/create',{plan_code:'pro'})}>Subscribe to Pro · ₹2,499/mo</button>}
     {details.subscription?.billing_mode==='live'&&<>
      <button type="button" className="btn btn-secondary" disabled={liveBusy}
       onClick={()=>liveAction('/api/billing/live/sync')}>Refresh payment status</button>
      <button type="button" className="btn btn-secondary" disabled={liveBusy}
       onClick={()=>{if(window.confirm('Cancel future Razorpay renewals for this subscription?'))void liveAction('/api/billing/live/cancel');}}>Cancel future renewals</button>
     </>}
    </div>
    {liveStatus&&<p className="small" role="status" aria-live="polite">{liveStatus}</p>}
    {details.subscription?.billing_mode==='live'&&<p className="small muted">Existing live subscription: {details.subscription.status}. Renewal cancellation: {details.subscription.cancel_at_period_end?'scheduled':'not requested'}.</p>}
   </div>}
   {details.sandbox_checkout_enabled&&csrfToken&&<div className="sandbox-controls">
    <p className="small"><strong>Sandbox only:</strong> Razorpay test-mode checkout. No real payments or premium entitlements.</p>
    <div className="row-inline wrap">
     <button type="button" className="btn btn-secondary" disabled={sandboxBusy} onClick={()=>sandboxAction('/api/billing/sandbox/create',{plan_code:'starter'})}>{sandboxBusy?'Connecting…':'Generate Starter test checkout'}</button>
     <button type="button" className="btn btn-secondary" disabled={sandboxBusy} onClick={()=>sandboxAction('/api/billing/sandbox/create',{plan_code:'pro'})}>{sandboxBusy?'Connecting…':'Generate Pro test checkout'}</button>
     {details.subscription&&<button type="button" className="btn btn-secondary" disabled={sandboxBusy}
      onClick={()=>sandboxAction('/api/billing/sandbox/cancel')}>Request test cancellation</button>}
    </div>
    {sandboxMessage&&<p className="small" role="status" aria-live="polite">{sandboxMessage}</p>}
    {sandboxUrl&&<a className="btn btn-secondary" href={sandboxUrl} target="_blank" rel="noopener noreferrer">Open hosted test checkout</a>}
   </div>}
   <p className="small muted subscription-footnote"><ShieldCheck size={15}/>
    {details.checkout_enabled?'Real recurring payments are processed by Razorpay only after your authorization. Paid capacity is limited during launch.':'No payment is being collected. Paid tiers are proposals, not purchase offers.'}
    {' '}External Make and Google limits still apply; monitoring schedules are best-effort.</p>
   {compact&&<a className="btn btn-secondary" href="/account">View subscription details</a>}
  </>}
 </section>;
}
