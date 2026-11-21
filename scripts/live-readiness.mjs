// Read-only production Live Razorpay preflight. Does not activate payments or mutate Cloudflare.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=process.cwd(), configPath=path.join(root,'wrangler.live.local.jsonc');
const wrangler=path.join(root,'node_modules','wrangler','bin','wrangler.js');
const checks=[];
const record=(name,pass,detail)=>checks.push({name,pass,detail});
function run(args){
 const r=spawnSync(process.execPath,[wrangler,...args],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
 if(r.error||r.status!==0)throw Error('Wrangler '+args.slice(0,2).join(' ')+' failed. Check Cloudflare login and production account.');
 return r.stdout;
}
function jsonOut(args){
 const output=run(args);
 try{return JSON.parse(output.trim());}
 catch{throw Error('Unexpected Wrangler JSON format for '+args.slice(0,2).join(' '));}
}
async function checkHttps(url,options,statusExpected){
 try{
  const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(9000)});
  return {ok:r.status===statusExpected,status:r.status};
 }catch{return {ok:false,status:'unreachable'};}
}
try{
 if(!fs.existsSync(configPath))throw Error('Run npm run live:preflight first (generates ignored production config).');
 if(!fs.existsSync(wrangler))throw Error('Run npm ci first.');
 const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 if(config.name!=='leadpath'||config.d1_databases?.[0]?.database_name!=='leadpath-db'||
  config.vars?.BASE_URL!=='https://leadpath.monty-08-raj.workers.dev')
  throw Error('Wrong Cloudflare target! Aborting before any remote request.');
 record('Production worker and D1 target verified',true,'leadpath / leadpath-db');
 const secretMeta=jsonOut(['secret','list','--format','json','--config',configPath]);
 if(!Array.isArray(secretMeta))throw Error('Unexpected Wrangler secret list output.');
 const found=new Set(secretMeta.map(s=>s.name));
 const required=['RAZORPAY_LIVE_KEY_ID','RAZORPAY_LIVE_KEY_SECRET',
  'RAZORPAY_LIVE_STARTER_PLAN_ID','RAZORPAY_LIVE_PRO_PLAN_ID','RAZORPAY_LIVE_WEBHOOK_SECRET'];
 record('All five Live Razorpay secrets deployed',required.every(n=>found.has(n)),
  required.filter(n=>!found.has(n)).length?'Missing: '+required.filter(n=>!found.has(n)).join(', '):'Five secret names present (values cannot be inspected)');
 record('Live checkout remains disabled',!found.has('LIVE_BILLING_ENABLED'),
  found.has('LIVE_BILLING_ENABLED')?'LIVE_BILLING_ENABLED exists; verify its value and intentionally disable checkout until signed events and capacity validated.':'Final charge-enabling flag is not installed.');
 record('Test billing cannot unlock paid access',!found.has('ALLOW_TEST_BILLING_ENTITLEMENTS'),
  found.has('ALLOW_TEST_BILLING_ENTITLEMENTS')?'REMOVE before production rollout.':'No test-entitlement flag installed.');
 const query=`SELECT
  (SELECT COUNT(*) FROM subscription_plans WHERE (code='starter' AND currency='INR' AND price_minor_units=79900) OR (code='pro' AND currency='INR' AND price_minor_units=249900)) AS matching_plans,
  (SELECT COUNT(*) FROM live_billing_slots) AS reserved_live_slots,
  (SELECT COUNT(*) FROM user_subscriptions WHERE billing_mode='live') AS live_subscriptions,
  (SELECT COUNT(*) FROM monitors WHERE state='active') AS active_monitors,
  (SELECT COUNT(*) FROM monitors WHERE state='active' AND next_due < strftime('%s','now')*1000) AS overdue_monitors`;
 const out=jsonOut(['d1','execute','leadpath-db','--remote','--config',configPath,'--json','--command',query]);
 const first=Array.isArray(out)?out[0]:out;
 const metrics=first?.results?.[0];
 if(!metrics)throw Error('Cloudflare D1 read returned no schema/metrics.');
 record('Production billing schema and INR plan prices',Number(metrics.matching_plans)===2,
  'Expected both INR monthly catalog amounts in D1.');
 record('No unresolved live mandates/slots',Number(metrics.reserved_live_slots)===0&&Number(metrics.live_subscriptions)===0,
  'Live slots '+metrics.reserved_live_slots+', live subscriptions '+metrics.live_subscriptions);
 record('Monitor capacity inventory',true,'Active '+metrics.active_monitors+', overdue '+metrics.overdue_monitors+' (capacity review still required)');
 const site='https://leadpath.monty-08-raj.workers.dev';
 const status=await checkHttps(site+'/api/public/status',{method:'GET'},200);
 record('Deployed public API responds',status.ok,'HTTP '+status.status);
 const invalid=await checkHttps(site+'/api/billing/webhook/razorpay-live',{
  method:'POST',headers:{'content-type':'application/json','x-razorpay-event-id':'readiness2026',
   'x-razorpay-signature':'0'.repeat(64)},body:'{}'
 },401);
 record('Live webhook rejects forged signatures',invalid.ok,'HTTP '+invalid.status+
   (invalid.status===503?' (signed webhook gate is still off; enable webhook only, not checkout)':''));
 console.log('\nLeadPath Live Production Readiness (READ ONLY)\n');
 for(const c of checks)console.log((c.pass?'PASS':'FAIL')+' | '+c.name+' — '+c.detail);
 console.log('\nNo database writes, deployments, payments or changes were made.');
 console.log('This proves neither a successful signed provider delivery nor scheduler load capacity.');
 if(checks.some(c=>!c.pass)){process.exitCode=1;console.log('NOT READY to enable real checkout. Fix FAIL checks first.');}
 else console.log('Basic configuration PASS. Signed Razorpay event delivery and monitoring capacity review are still required.');
}catch(e){
 console.error('Readiness check halted safely: '+(e instanceof Error?e.message:'Unknown error'));
 process.exitCode=1;
}
