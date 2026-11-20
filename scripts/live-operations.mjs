// Read-only operational check after deploying LeadPath's Cloudflare Queue.
// No payment, enqueue, DB mutation, or deployment is attempted.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=process.cwd(),configPath=path.join(root,'wrangler.live.local.jsonc');
const cli=path.join(root,'node_modules','wrangler','bin','wrangler.js');
const queueName='leadpath-monitor-jobs',workerName='leadpath';
let fail=false;
function result(name,ok,detail){
 console.log((ok?'PASS':'CHECK')+' | '+name+' — '+detail);
 if(!ok)fail=true;
}
function execWrangler(args){
 const r=spawnSync(process.execPath,[cli,...args,'--config',configPath],{
  cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
 if(r.error||r.status!==0)
  throw new Error('Wrangler '+args.slice(0,2).join(' ')+' failed; inspect your Cloudflare login/config.');
 return r.stdout.trim();
}
function jsonWrangler(args){
 const raw=execWrangler(args);
 try{return JSON.parse(raw);}
 catch{throw new Error('Expected Wrangler JSON for '+args.slice(0,2).join(' ')+'.');}
}
try {
 if(!fs.existsSync(configPath)||!fs.existsSync(cli))
  throw new Error('First run npm ci and npm run live:preflight in this repository.');
 const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
 if(cfg.name!==workerName||cfg.d1_databases?.[0]?.database_name!=='leadpath-db'||
  cfg.vars?.BASE_URL!=='https://leadpath.monty-08-raj.workers.dev')
  throw new Error('The config is not the expected LeadPath production target.');
 console.log('\nLeadPath post-deploy operations: read-only\n');
 const producers=cfg.queues?.producers||[],consumers=cfg.queues?.consumers||[];
 result('Production Queue producer binding',producers.some(p=>p.binding==='MONITOR_QUEUE'&&p.queue===queueName),
  'Must bind MONITOR_QUEUE to '+queueName);
 result('Production Queue consumer binding',consumers.some(c=>c.queue===queueName&&c.max_batch_size===1),
  'Expected single-message delivery');
 const remote=jsonWrangler(['queues','consumer','list',queueName,'--json']);
 const list=Array.isArray(remote)?remote:Array.isArray(remote?.result)?remote.result:
  Array.isArray(remote?.consumers)?remote.consumers:[];
 const associated=list.filter(v=>JSON.stringify(v).includes(workerName));
 result('Cloudflare registered Worker consumer',associated.length>0,
  associated.length?'Worker '+workerName+' registered':'No registered leadpath consumer detected');
 const secretMeta=jsonWrangler(['secret','list','--format','json']);
 const names=new Set((Array.isArray(secretMeta)?secretMeta:[]).map(x=>x.name));
 result('Live webhook secret installed',names.has('RAZORPAY_LIVE_WEBHOOK_SECRET'),
  'Checks secret name only; signature and real provider delivery are not verified');
 result('Paid entitlements configuration present',names.has('PAID_ENTITLEMENTS_ENABLED'),
  'Checks name only, not its secret value');
 result('Live checkout final switch remains unset',!names.has('LIVE_BILLING_ENABLED'),
  names.has('LIVE_BILLING_ENABLED')?'Present: confirm value OFF until capacity and webhook delivery verified':'Not installed: safe default OFF');
 const query=`SELECT
  (SELECT COUNT(*) FROM monitors WHERE state='active' AND verified_at IS NOT NULL) AS active_monitors,
  (SELECT COUNT(*) FROM monitors WHERE state='active' AND verified_at IS NOT NULL AND next_due < unixepoch('now')*1000-1800000) AS overdue_over_30m,
  (SELECT COUNT(*) FROM runs WHERE source='scheduled' AND created_at>unixepoch('now')*1000-86400000) AS scheduled_24h,
  (SELECT COUNT(*) FROM runs WHERE source='scheduled' AND created_at>unixepoch('now')*1000-86400000
   AND state IN ('error','unconfirmed')) AS failed_24h,
  (SELECT MAX(created_at) FROM runs WHERE source='scheduled') AS last_scheduled_at,
  (SELECT COUNT(*) FROM payment_events WHERE event_id LIKE 'live_%') AS recorded_live_events,
  (SELECT COUNT(*) FROM user_subscriptions WHERE billing_mode='live') AS live_subscriptions`;
 const sqlResult=jsonWrangler(['d1','execute','leadpath-db','--remote','--json','--command',query]);
 const sqlRow=(Array.isArray(sqlResult)?sqlResult[0]:sqlResult)?.results?.[0];
 if(!sqlRow)throw new Error('D1 query returned no metrics.');
 console.log('\nRead-only production D1 metrics:');
 console.log('Verified active monitors: '+sqlRow.active_monitors);
 console.log('Scheduled runs (24h): '+sqlRow.scheduled_24h);
 console.log('Scheduled run failures/unconfirmed (24h): '+sqlRow.failed_24h);
 console.log('Overdue >30 minutes: '+sqlRow.overdue_over_30m);
 console.log('Last scheduled run: '+(sqlRow.last_scheduled_at?new Date(Number(sqlRow.last_scheduled_at)).toISOString():'none'));
 console.log('Recorded signed Live webhook events: '+sqlRow.recorded_live_events);
 console.log('Live subscriber records: '+sqlRow.live_subscriptions);
 console.log('\nReminder: a registered consumer + zero overdue checks is NOT proof that paid-monitor cadence works.');
 console.log('For actual delivery, inspect Cloudflare Queue analytics and a real scheduled run');
 console.log('and check a signed Razorpay-origin webhook delivery in the Razorpay Live Dashboard.');
 console.log('No changes, synthetic provider events, payments or deployed secrets were made.');
 if(fail){console.log('\nCHECK items need attention before enabling live checkout.');process.exitCode=1;}
}catch(error){
 console.error('Operational verification stopped safely: '+(error instanceof Error?error.message:String(error)));
 process.exitCode=1;
}
