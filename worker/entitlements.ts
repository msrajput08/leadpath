import type { Env } from './types.js';

export type PlanCode = 'free' | 'starter' | 'pro';
export interface Entitlements {
 code: PlanCode;
 display_name: string;
 currency: string;
 price_minor_units: number;
 monitor_limit: number;
 interval_seconds: number;
 manual_runs_per_day: number;
 history_days: number;
 alert_level: 'existing' | 'enhanced' | 'advanced';
 available_for_purchase: boolean;
}

type PlanRow = Omit<Entitlements,'available_for_purchase'> & {available_for_purchase:number};
const mapPlan=(p:PlanRow):Entitlements=>({
 code:p.code,display_name:p.display_name,currency:p.currency,price_minor_units:p.price_minor_units,
 monitor_limit:p.monitor_limit,interval_seconds:p.interval_seconds,
 manual_runs_per_day:p.manual_runs_per_day,history_days:p.history_days,
 alert_level:p.alert_level,available_for_purchase:p.available_for_purchase===1
});

// No flag is enabled in wrangler.jsonc. A valid database row alone NEVER grants paid access.
export const paidEntitlementsEnabled=(env:Env)=>env.PAID_ENTITLEMENTS_ENABLED==='true';

export async function getEntitlements(env:Env,userId:string):Promise<Entitlements> {
 const free=await env.DB.prepare('SELECT * FROM subscription_plans WHERE code=?')
  .bind('free').first<PlanRow>();
 if(!free)throw new Error('SUBSCRIPTION_MIGRATION_MISSING');
 if(!paidEntitlementsEnabled(env))return mapPlan(free);
 const paid=await env.DB.prepare(`SELECT p.* FROM user_subscriptions s
 JOIN subscription_plans p ON p.code=s.plan_code
 WHERE s.user_id=? AND s.status='active' AND s.current_period_end>?
 AND p.code IN ('starter','pro')
 ORDER BY s.current_period_end DESC LIMIT 1`)
 .bind(userId,Date.now()).first<PlanRow>();
 return mapPlan(paid||free);
}

// Stable quota selection: a downgrade keeps ALL monitor records and their history,
// but checks are permitted only for the user's oldest N monitors.
export async function withinMonitorLimit(env:Env,monitor:{id:string;user_id:string;created_at:number},max:number):Promise<boolean> {
 const position=await env.DB.prepare(`SELECT COUNT(*) AS total FROM monitors
 WHERE user_id=? AND (created_at<? OR (created_at=? AND id<=?))`)
 .bind(monitor.user_id,monitor.created_at,monitor.created_at,monitor.id).first<{total:number}>();
 return (position?.total||0)>0 && (position?.total||0)<=max;
}
export async function recordUsage(env:Env,userId:string,source:'manual'|'scheduled',timestamp=Date.now()):Promise<void>{
 const month=new Date(timestamp).toISOString().slice(0,7);
 await env.DB.prepare(`INSERT INTO monthly_usage(user_id,period_utc,scheduled_checks,manual_checks,updated_at)
 VALUES(?,?,?,?,?) ON CONFLICT(user_id,period_utc) DO UPDATE SET
 scheduled_checks=scheduled_checks+excluded.scheduled_checks,
 manual_checks=manual_checks+excluded.manual_checks,updated_at=excluded.updated_at`)
 .bind(userId,month,source==='scheduled'?1:0,source==='manual'?1:0,timestamp).run();
}
export async function billingOverview(env:Env,userId:string) {
 const [current,plans,usage,count,subscription]=await Promise.all([
  getEntitlements(env,userId),
  env.DB.prepare('SELECT * FROM subscription_plans ORDER BY price_minor_units').all<PlanRow>(),
  env.DB.prepare('SELECT scheduled_checks,manual_checks FROM monthly_usage WHERE user_id=? AND period_utc=?')
   .bind(userId,new Date().toISOString().slice(0,7)).first<{scheduled_checks:number;manual_checks:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS total FROM monitors WHERE user_id=?').bind(userId).first<{total:number}>(),
  env.DB.prepare(`SELECT s.plan_code,s.status,s.current_period_end,s.cancel_at_period_end
    FROM user_subscriptions s WHERE s.user_id=? ORDER BY s.updated_at DESC LIMIT 1`)
    .bind(userId).first<{plan_code:PlanCode;status:string;current_period_end:number|null;cancel_at_period_end:number}>()
 ]);
 return {current,plans:plans.results.map(mapPlan).map(p=>({
   ...p,available_for_purchase:false, // no checkout implemented or approved
   operationally_available:p.code==='free'
  })),monitor_count:count?.total||0,
  usage:{scheduled_checks:usage?.scheduled_checks||0,manual_checks:usage?.manual_checks||0},
  subscription:subscription?{plan_code:subscription.plan_code,status:subscription.status,
   current_period_end:subscription.current_period_end,cancel_at_period_end:!!subscription.cancel_at_period_end}:null,
  checkout_enabled:false,sandbox_checkout_enabled:env.RAZORPAY_SANDBOX_ENABLED==='true'&&!!env.RAZORPAY_TEST_KEY_ID?.startsWith('rzp_test_')&&!!env.RAZORPAY_TEST_KEY_SECRET&&!!env.RAZORPAY_TEST_STARTER_PLAN_ID&&!!env.RAZORPAY_TEST_PRO_PLAN_ID,
  paid_features_enabled:paidEntitlementsEnabled(env)};
}
