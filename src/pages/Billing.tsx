import { ArrowRight, CreditCard, ShieldCheck } from 'lucide-react';
export type BillingData={
 current_plan:string;plan_name:string;checkout_available:boolean;management_available:boolean;
 limits:{monitors:number;interval_seconds:number;history_days:number;history_page_size:number;manual_runs_per_24h:number;manual_cooldown_seconds:number;alerts:string};
 usage:{monitors:number;today:{scheduled_runs:number;manual_runs:number};manual_runs_last_24h:number};
 subscription:{status:string;plan:string;period_start:number|null;period_end:number|null;paid_through:number|null;cancel_at_period_end:boolean;canceled_at:number|null;environment:string|null};
 plans:{id:string;name:string;monitor_limit:number;interval_seconds:number;history:string;alerts:string;available:boolean;price_label:string}[];
};
export const frequency=(seconds:number)=>seconds>=3600?`About every ${seconds/3600} hour${seconds===3600?'':'s'}`:`About every ${seconds/60} minutes`;
const date=(value:number|null)=>value?new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Not applicable';
export function PlanSummary({billing}:{billing:BillingData|null}){
 return <section className="panel dashboard-box plan-summary"><div><span className="eyebrow">YOUR PLAN</span><h2>{billing?`${billing.plan_name} workspace`:'Loading plan…'}</h2>{billing&&<p>{billing.usage.monitors} / {billing.limits.monitors} monitors · {frequency(billing.limits.interval_seconds)}</p>}</div><a className="btn btn-secondary" href="/billing">Plan & billing <ArrowRight size={16}/></a></section>;
}
export default function Billing({billing,error}:{billing:BillingData|null;error:string}){
 return <div className="container dashboard-area">
  <div className="dashboard-heading"><div><span className="eyebrow">WORKSPACE / PLAN & BILLING</span><h1>Room to grow.</h1><p>A clear view of your plan, usage and what comes next.</p></div><a className="btn btn-secondary" href="/account">Account settings</a></div>
  {error&&<div role="alert" className="notice error-banner">{error}</div>}
  {!billing?<p role="status">Loading your plan…</p>:<>
   <div className="notice"><ShieldCheck size={20}/><span><strong>Paid subscriptions are not available yet.</strong> Your Free workspace remains available. No checkout is active and no card details are collected.</span></div>
   <div className="dashboard-columns">
    <section className="panel dashboard-box"><span className="eyebrow">CURRENT ACCESS</span><h2>{billing.plan_name}</h2><div className="billing-usage"><strong>{billing.usage.monitors}<span> / {billing.limits.monitors}</span></strong><span className="muted">monitors configured</span></div><progress aria-label="Monitor usage" max={Math.max(billing.usage.monitors,billing.limits.monitors)} value={billing.usage.monitors}/>
     {billing.usage.monitors>billing.limits.monitors&&<p className="notice">Your saved monitors and history are retained. The oldest {billing.limits.monitors} monitor(s) can run under your current allowance.</p>}
     <dl className="billing-facts"><div><dt>Check target</dt><dd>{frequency(billing.limits.interval_seconds)}</dd></div><div><dt>Manual checks, last 24 hours</dt><dd>{billing.usage.manual_runs_last_24h} / {billing.limits.manual_runs_per_24h}</dd></div><div><dt>Scheduled checks today (UTC)</dt><dd>{billing.usage.today.scheduled_runs}</dd></div><div><dt>History retention</dt><dd>About {billing.limits.history_days} days</dd></div><div><dt>Alerts available</dt><dd>In-app + optional Telegram</dd></div></dl>
    </section>
    <section className="panel dashboard-box"><CreditCard size={22}/><h2>Subscription details</h2><dl className="billing-facts"><div><dt>Billing status</dt><dd>{billing.subscription.status.replaceAll('_',' ')}</dd></div><div><dt>Current period ends</dt><dd>{date(billing.subscription.period_end)}</dd></div><div><dt>Verified paid access through</dt><dd>{date(billing.subscription.paid_through)}</dd></div><div><dt>Renewal</dt><dd>{billing.subscription.status==='free'?'No subscription':billing.subscription.cancel_at_period_end?'Cancellation scheduled':billing.subscription.status==='active'?'Subject to successful payment':'Not active'}</dd></div></dl>
     {billing.subscription.environment==='sandbox'&&<p className="notice">Test subscription — no real payment.</p>}
     {billing.subscription.cancel_at_period_end&&<p>Cancellation takes effect at the end of the current paid period. Your saved monitoring data remains.</p>}
     <div className="row-inline wrap"><button className="btn btn-secondary" disabled>Manage subscription</button><button className="btn btn-secondary" disabled>Cancel subscription</button></div><p className="small muted">Billing controls will appear after launch verification. <a href="mailto:minty.12.shar@gmail.com">Contact support</a> for account questions.</p>
    </section>
   </div>
   <section className="billing-comparison"><span className="eyebrow">LOOKING AHEAD</span><h2>A plan for every stage.</h2><p className="muted">Starter and Pro are proposals under development. Features, limits and pricing may change before launch.</p><div className="billing-plan-grid">{billing.plans.map(plan=><article className={'panel dashboard-box '+(plan.id===billing.current_plan?'billing-current':'')} key={plan.id}><span className="eyebrow">{plan.available?'AVAILABLE':'COMING SOON'}</span><h3>{plan.name}</h3><p className="billing-price">{plan.price_label}</p><ul><li>{plan.monitor_limit} monitor{plan.monitor_limit===1?'':'s'}</li><li>{frequency(plan.interval_seconds)}{!plan.available?' — proposed':''}</li><li>{plan.history}</li><li>{plan.alerts} alerts</li></ul><button className="btn btn-secondary btn-block" disabled>{plan.id===billing.current_plan?'Current plan':'Not available yet'}</button></article>)}</div></section>
  </>}
 </div>;
}
