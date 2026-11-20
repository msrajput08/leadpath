import type { Env } from './types.js';

export type PlanId = 'free' | 'starter' | 'pro';
export interface Plan {
 id: PlanId; name: string; monthly_price_cents: number; currency: string;
 monitor_limit: number; interval_seconds: number; history_days: number; history_page_size: number;
 manual_daily_limit: number; manual_cooldown_seconds: number; alert_level: 'existing';
 proposed_alert_level: string; release_ready: number;
}
export interface Subscription {
 user_id: string; plan_id: PlanId; status: string; provider: string | null;
 provider_environment: 'sandbox' | 'live' | null; provider_customer_id: string | null;
 provider_subscription_id: string | null; provider_price_id: string | null;
 period_start: number | null; period_end: number | null; paid_through: number | null;
 cancel_at_period_end: number; canceled_at: number | null; provider_updated_at: number;
 last_verified_at: number | null; grandfathered_monitor_limit: number; updated_at: number;
}
export interface Entitlements extends Plan { effective_interval_seconds: number; subscription: Subscription; }
// Configuration can LOWER safety budgets. Raising these ceilings requires reviewed code.
export function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
 if (!value || !/^\d+$/.test(value)) return fallback;
 const n=Number(value); return Number.isSafeInteger(n) ? Math.max(min,Math.min(max,n)) : fallback;
}
export function resourceLimits(env: Env) {
 return {
  checksPerTick: boundedInt(env.SCHEDULER_BATCH_SIZE,3,1,3),
  scheduledPerDay: boundedInt(env.SCHEDULED_CHECKS_PER_DAY,288,0,288),
  manualPerDay: boundedInt(env.MANUAL_CHECKS_PER_DAY,1000,0,1000),
  minInterval: boundedInt(env.MONITOR_MIN_INTERVAL_SECONDS,21600,900,21600)
 };
}
export function paidAccessAllowed(env: Env, sub: Subscription, plan: Plan, time: number): boolean {
 const environmentAllowed=sub.provider_environment==='live'
  ? env.BILLING_LIVE_APPROVED==='true'
  : sub.provider_environment==='sandbox' && env.BILLING_MODE==='sandbox';
 return env.PAID_ENTITLEMENTS_ENABLED==='true' && environmentAllowed && plan.release_ready===1 &&
  sub.provider!==null && sub.provider_subscription_id!==null && sub.provider_customer_id!==null &&
  sub.provider_price_id!==null && sub.last_verified_at!==null &&
  sub.status==='active' &&
  sub.period_start!==null && sub.period_start<=time && sub.period_end!==null && sub.period_end>time &&
  sub.paid_through!==null && sub.paid_through>time;
}
export async function getEntitlements(env: Env, userId: string, time=Date.now()): Promise<Entitlements> {
 // New users are provisioned by the DB trigger; pre-existing users were backfilled.
 const row=await env.DB.prepare(`SELECT s.*,p.*,
  s.user_id AS subscription_user_id, s.updated_at AS subscription_updated_at
  FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=?`).bind(userId).first<Subscription & Plan>();
 if (!row) throw new Error('Subscription migration required');
 const sub: Subscription={...row};
 let plan: Plan=row;
 if (row.plan_id!=='free' && !paidAccessAllowed(env,sub,plan,time)) {
  const free=await env.DB.prepare("SELECT * FROM plans WHERE id='free'").first<Plan>();
  if (!free) throw new Error('Free plan missing');
  plan=free;
 }
 return {...plan,monitor_limit:Math.max(plan.monitor_limit,sub.grandfathered_monitor_limit),
  effective_interval_seconds:Math.max(plan.interval_seconds,resourceLimits(env).minInterval),subscription:sub};
}
export async function billingSummary(env: Env,userId: string) {
 const entitlement=await getEntitlements(env,userId);
 const [plans,count,usage,manual]=await Promise.all([
  env.DB.prepare('SELECT * FROM plans ORDER BY monthly_price_cents').all<Plan>(),
  env.DB.prepare('SELECT COUNT(*) AS total FROM monitors WHERE user_id=?').bind(userId).first<{total:number}>(),
  env.DB.prepare('SELECT scheduled_runs,manual_runs FROM usage_daily WHERE user_id=? AND day=?').bind(userId,new Date().toISOString().slice(0,10)).first(),
  env.DB.prepare("SELECT COUNT(*) AS total FROM run_usage WHERE user_id=? AND source='manual' AND created_at>=?").bind(userId,Date.now()-86400000).first<{total:number}>()
 ]);
 const s=entitlement.subscription;
 return {
  current_plan:entitlement.id,plan_name:entitlement.name,
  limits:{monitors:entitlement.monitor_limit,interval_seconds:entitlement.effective_interval_seconds,
   history_days:entitlement.history_days,history_page_size:entitlement.history_page_size,
   manual_runs_per_24h:entitlement.manual_daily_limit,manual_cooldown_seconds:entitlement.manual_cooldown_seconds,alerts:entitlement.alert_level},
  usage:{monitors:count?.total||0,today:usage||{scheduled_runs:0,manual_runs:0},manual_runs_last_24h:manual?.total||0},
  subscription:{status:s.status==='active'&&s.period_end!==null&&s.period_end<=Date.now()?'expired':s.status,plan:s.plan_id,period_start:s.period_start,period_end:s.period_end,
   paid_through:s.paid_through,cancel_at_period_end:!!s.cancel_at_period_end,canceled_at:s.canceled_at,
   environment:s.provider_environment},
  checkout_available:false,management_available:false,
  plans:plans.results.map(p=>({id:p.id,name:p.name,monitor_limit:p.monitor_limit,interval_seconds:p.interval_seconds,
   history:p.id==='free'?'Basic history':'Extended history view — planned',alerts:p.proposed_alert_level,
   // Prices are internal proposals, not public commercial offers.
   available:p.id==='free',price_label:p.id==='free'?'$0 / month':'Coming soon'}))
 };
}
