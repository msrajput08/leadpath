import type {Env} from './types.js';

// An upgraded monitor should not wait for its old six-hour Free schedule.
// A downgrade must not keep running at the shorter paid cadence. Repeated
// provider sync/webhook deliveries leave already-aligned due times unchanged.
export async function alignMonitorCadence(env:Env,userId:string,intervalSeconds:number):Promise<void>{
 if(![900,3600,21600].includes(intervalSeconds))throw new Error('INVALID_MONITOR_CADENCE');
 const current=Date.now(),next=current+intervalSeconds*1000;
 await env.DB.prepare(`UPDATE monitors
  SET schedule_interval_seconds=?,
   next_due=CASE WHEN schedule_interval_seconds>? THEN MIN(next_due,?)
                 ELSE MAX(next_due,?) END,
   updated_at=?
  WHERE user_id=? AND schedule_interval_seconds<>?`)
  .bind(intervalSeconds,intervalSeconds,next,next,current,userId,intervalSeconds).run();
}
