import React,{useEffect,useState} from 'react';
import {CheckCircle2,Clock3,ShieldCheck} from 'lucide-react';
type Plan={code:string;display_name:string;currency:string;price_minor_units:number;monitor_limit:number;interval_seconds:number;operationally_available:boolean};
const formatPrice=(plan:Plan)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:plan.currency,maximumFractionDigits:0}).format(plan.price_minor_units/100);
type Details={current:Plan;plans:Plan[];monitor_count:number;usage:{manual_checks:number;scheduled_checks:number};
 subscription:null|{status:string;plan_code:string;current_period_end:number|null;cancel_at_period_end:boolean};
 checkout_enabled:boolean;sandbox_checkout_enabled?:boolean};
export default function BillingPanel({compact=false,csrfToken}:{compact?:boolean;csrfToken?:string}){
 const [details,setDetails]=useState<Details|null>(null);
 const [message,setMessage]=useState('');
 const [sandboxBusy,setSandboxBusy]=useState(false);
 const [sandboxUrl,setSandboxUrl]=useState('');
 async function sandboxAction(path:string,body:unknown={}){
  setSandboxBusy(true);setMessage('');setSandboxUrl('');
  try {
   const response=await fetch(path,{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json','X-CSRF-Token':csrfToken||''},body:JSON.stringify(body)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||'Sandbox request failed');
   if(result.checkout_url){
    const link=new URL(result.checkout_url);
    if(link.protocol!=='https:'||link.hostname!=='rzp.io')throw new Error('Invalid hosted checkout URL');
    setSandboxUrl(link.toString());
    setMessage('Razorpay TEST checkout created; no live payment or paid features enabled.');
   } else setMessage(result.message||'Test cancellation submitted.');
  }catch(error){setMessage(error instanceof Error?error.message:'Sandbox request failed');}
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
  <div className="box-header"><div><span className="eyebrow">SUBSCRIPTIONS</span><h2 id="subscription-heading">Plan & usage</h2></div><span className="subscription-soon">Paid plans coming soon</span></div>
  {message&&<p className="small muted" role="status">{message}</p>}
  {details&&<>
   <div className="subscription-summary">
    <div><span className="small muted">CURRENT PLAN</span><strong>{details.current.display_name}</strong><small>{formatPrice(details.current)}/month · No payment method required</small></div>
    <div><span className="small muted">MONITORS</span><strong>{details.monitor_count} / {details.current.monitor_limit}</strong><small>Saved workflows</small></div>
    <div><span className="small muted">THIS MONTH (UTC)</span><strong>{details.usage.scheduled_checks+details.usage.manual_checks}</strong><small>{details.usage.scheduled_checks} automatic · {details.usage.manual_checks} manual</small></div>
   </div>
   {details.subscription&&<p className="small muted">Billing record: {details.subscription.status}.
    {details.subscription.current_period_end?' Period ends '+new Date(details.subscription.current_period_end).toLocaleDateString()+'.':''}
    {details.subscription.cancel_at_period_end?' Cancellation scheduled.':''}
    No checkout or self-service cancellation is currently enabled.</p>}
   {!compact&&<div className="subscription-comparison">{details.plans.map(p=><div className="subscription-tier" key={p.code}>
    <span className="small muted">{p.code==='free'?'AVAILABLE NOW':'PROPOSED · NOT FOR SALE'}</span>
    <h3>{p.display_name}</h3><strong className="subscription-price">{formatPrice(p)}<small> /month</small></strong>
    <p className="small">{p.monitor_limit} monitor{p.monitor_limit===1?'':'s'} · target every {p.interval_seconds===21600?'6 hours':p.interval_seconds===3600?'hour':'15 minutes'}</p>
    <span className="small muted">{p.code==='free'?<><CheckCircle2 size={14}/> Current service</>:<><Clock3 size={14}/> Frequency, alerts and billing pending validation</>}</span>
   </div>)}</div>}
   {details.sandbox_checkout_enabled&&csrfToken&&<div className="sandbox-controls">
    <p className="small"><strong>Sandbox only:</strong> Razorpay test-mode checkout. No real payments or premium entitlements.</p>
    <div className="row-inline wrap">
     <button type="button" className="btn btn-secondary" disabled={sandboxBusy} onClick={()=>sandboxAction('/api/billing/sandbox/create',{plan_code:'starter'})}>Generate Starter test checkout</button>
     <button type="button" className="btn btn-secondary" disabled={sandboxBusy} onClick={()=>sandboxAction('/api/billing/sandbox/create',{plan_code:'pro'})}>Generate Pro test checkout</button>
     {details.subscription&&<button type="button" className="btn btn-secondary" disabled={sandboxBusy}
      onClick={()=>sandboxAction('/api/billing/sandbox/cancel')}>Request test cancellation</button>}
    </div>
    {sandboxUrl&&<a className="btn btn-secondary" href={sandboxUrl} target="_blank" rel="noopener noreferrer">Open hosted test checkout</a>}
   </div>}
   <p className="small muted subscription-footnote"><ShieldCheck size={15}/> No payment is being collected. Paid tiers are proposals, not purchase offers. External Make and Google limits still apply; schedules are best-effort.</p>
   {compact&&<a className="btn btn-secondary" href="/account">View subscription details</a>}
  </>}
 </section>;
}
