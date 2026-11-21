// LeadPath guarded, single-owner Razorpay Live launch. No user credentials in source.
// 'launch': verifies target, CI-sourced code and D1, deploys, prepares owner-only
// flags with LIVE_BILLING_ENABLED=false, then activates AFTER explicit approval.
// 'pause': immediately disables NEW checkout; existing mandates remain billable.
// Requires the operator's Cloudflare Wrangler login and live merchant configuration.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import readline from 'node:readline/promises';
import process from 'node:process';

const mode=process.argv[2]||'check';
const root=process.cwd(), configPath=path.join(root,'wrangler.live.local.jsonc');
const wrangler=path.join(root,'node_modules','wrangler','bin','wrangler.js');
const origin='https://leadpath.monty-08-raj.workers.dev';
const expectedBranch='feat/subscription-foundation-20261120';
if(!['check','launch','pause'].includes(mode))throw Error('Usage: node scripts/live-pilot-launch.mjs [check|launch|pause]');
function exec(program,args,input){
 const r=spawnSync(program,args,{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024,
  input,stdio:input===undefined?['inherit','pipe','pipe']:['pipe','pipe','pipe']});
 if(r.error||r.status!==0)throw Error('Command failed: '+args.slice(0,4).join(' ')+
  '. Review Wrangler/Git login and permissions. '+(r.stderr||'').slice(0,500));
 return (r.stdout||'').trim();
}
function wr(args,input){return exec(process.execPath,[wrangler,...args,'--config',configPath],input);}
function decodeJson(raw,label){try{return JSON.parse(raw);}catch{throw Error('Unexpected '+label+' JSON response. Aborting safely.');}}
function sql(command){
 const out=decodeJson(wr(['d1','execute','leadpath-db','--remote','--json','--command',command]),'D1');
 const v=Array.isArray(out)?out[0]:out;
 if(!v?.results)return null;
 return v.results[0]||null;
}
function assertSetup({requireReviewedBranch=true}={}){
 if(!fs.existsSync(configPath)||!fs.existsSync(wrangler))throw Error('Run npm ci and npm run live:preflight first.');
 const cfg=decodeJson(fs.readFileSync(configPath,'utf8'),'production config');
 if(cfg.name!=='leadpath'||cfg.vars?.BASE_URL!==origin||
  cfg.d1_databases?.length!==1||cfg.d1_databases[0].database_name!=='leadpath-db'||
  !/^[0-9a-f-]{36}$/i.test(cfg.d1_databases[0].database_id||''))
  throw Error('Unexpected production Worker, URL or D1 binding. No changes made.');
 const producer=cfg.queues?.producers?.[0],consumer=cfg.queues?.consumers?.[0];
 if(cfg.queues?.producers?.length!==1||producer?.binding!=='MONITOR_QUEUE'||
  producer?.queue!=='leadpath-monitor-jobs'||cfg.queues?.consumers?.length!==1||
  consumer?.queue!=='leadpath-monitor-jobs'||consumer?.max_batch_size!==1)
  throw Error('Verified Free Queue producer and single-message consumer bindings are required. No changes made.');
 if(requireReviewedBranch){
  const branch=exec('git',['branch','--show-current']);
  if(branch!==expectedBranch)throw Error('Switch to the reviewed feature branch before launch. Refusing '+branch);
  if(exec('git',['status','--porcelain','--untracked-files=no']))
   throw Error('Uncommitted tracked files exist. Review before production launch.');
 }
 return cfg;
}
async function apiCheck(){
 const status=await fetch(origin+'/api/public/status',{redirect:'manual',signal:AbortSignal.timeout(10000)});
 if(!status.ok)throw Error('Production status API did not return 200.');
 const publicBilling=await fetch(origin+'/api/public/billing',{cache:'no-store',redirect:'manual',
  signal:AbortSignal.timeout(10000)});
 if(!publicBilling.ok)throw Error('Public billing API did not return 200 after deploy.');
 return publicBilling.json();
}
function setFlags(values){
 const v=JSON.stringify(values);
 // Wrangler bulk updates only the named secrets. It does not remove Razorpay keys.
 wr(['secret','bulk'],v+'\n');
}
function setFinal(enabled){wr(['secret','put','LIVE_BILLING_ENABLED'],(enabled?'true':'false')+'\n');}
function checkSecrets(){
 const data=decodeJson(wr(['secret','list','--format','json']),'secret list');
 const names=new Set((Array.isArray(data)?data:[]).map(v=>v.name));
 const required=['RAZORPAY_LIVE_KEY_ID','RAZORPAY_LIVE_KEY_SECRET','RAZORPAY_LIVE_STARTER_PLAN_ID',
  'RAZORPAY_LIVE_PRO_PLAN_ID','RAZORPAY_LIVE_WEBHOOK_SECRET'];
 if(required.some(x=>!names.has(x)))throw Error('Missing Razorpay Live secret name(s): '+required.filter(x=>!names.has(x)).join(', '));
 if(names.has('ALLOW_TEST_BILLING_ENTITLEMENTS'))
  throw Error('REMOVE ALLOW_TEST_BILLING_ENTITLEMENTS before enabling any production charge.');
}
function checkInventory(){
 const row=sql(`SELECT
  (SELECT COUNT(*) FROM subscription_plans WHERE
   (code='starter' AND currency='INR' AND price_minor_units=79900 AND monitor_limit=5 AND interval_seconds=3600)
   OR (code='pro' AND currency='INR' AND price_minor_units=249900)) AS plans,
  (SELECT COUNT(*) FROM live_billing_slots) AS slots,
  (SELECT COUNT(*) FROM user_subscriptions WHERE billing_mode='live') AS subs,
  (SELECT COUNT(*) FROM monitors WHERE state='active' AND verified_at IS NOT NULL) AS active_verified,
  (SELECT COUNT(*) FROM monitors WHERE state='active' AND verified_at IS NOT NULL
   AND next_due<unixepoch('now')*1000-1800000) AS overdue_30m`);
 if(!row||Number(row.plans)!==2)throw Error('Production D1 plan amounts/quotas disagree with fixed ₹799/₹2,499 catalog.');
 if(Number(row.slots)!==0||Number(row.subs)!==0)
  throw Error('Live billing records already exist. Reconcile existing mandates before creating another pilot.');
 if(Number(row.overdue_30m)>0)
  throw Error('Existing monitored workflows are already overdue over 30 minutes. Do not enable paid sales.');
 return row;
}
function checkOwner(email){
 if(!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)||email.length>254)
  throw Error('Enter the email of an existing verified LeadPath account.');
 const safe=email.replaceAll("'", "''").toLowerCase();
 const row=sql(`SELECT id,COUNT(*) AS total FROM users WHERE lower(email)='${safe}'`);
 if(Number(row?.total)!==1||!/^[a-f0-9-]{36}$/i.test(row.id||''))
  throw Error('Exactly one existing LeadPath account must match the entered email.');
 return row.id;
}
const instruction='I VERIFIED CAPACITY AND APPROVE ONE REAL STARTER SUBSCRIPTION';
const rl=process.stdin.isTTY?readline.createInterface({input:process.stdin,output:process.stdout}):null;
try{
 if(mode==='pause'){
  assertSetup({requireReviewedBranch:false});
  setFinal(false);
  console.log('New LeadPath Live checkout PAUSED. Existing Razorpay recurring mandates are NOT cancelled.');
  process.exit(0);
 }
 assertSetup();
 checkSecrets();
 const state=checkInventory();
 console.log('Production target, Queues, Razorpay credential names and D1 catalog checked.');
 console.log('Verified monitors '+state.active_verified+'; overdue >30m '+state.overdue_30m+
  '; live slots '+state.slots+'; live subscriptions '+state.subs+'.');
 if(mode==='check'){
  console.log('READ-ONLY check complete; no production changes or charges.');
  process.exit(0);
 }
 if(!rl)throw Error('Launch requires an interactive terminal for explicit operator approval.');
 const email=(await rl.question('Existing LeadPath account email allowed to perform the FIRST live payment: ')).trim();
 const ownerId=checkOwner(email);
 console.log('\nThis enables REAL recurring ₹799/month charges for ONLY that signed-in user.');
 console.log('All other users will continue seeing paid enrollment closed. Pro is blocked.');
 console.log('Do not proceed unless the authorized 5-workflow Make/Queue capacity and paid support process were verified.');
 const approval=(await rl.question('Type EXACTLY "'+instruction+'" to authorize: ')).trim();
 if(approval!==instruction)throw Error('Activation not authorized. No writes or deployment occurred.');
 console.log('Building and deploying the latest feature-branch code with billing still OFF...');
 exec(process.platform==='win32'?(process.env.ComSpec||'cmd.exe'):'npm',
  process.platform==='win32'?['/d','/s','/c','npm run build']:['run','build']);
 wr(['deploy']);
 await apiCheck();
 console.log('Preparing single-user flags, explicitly holding checkout OFF...');
 setFlags({
  LIVE_PILOT_PLAN:'starter',LIVE_PILOT_USER_ID:ownerId,LIVE_PILOT_OPEN_TO_PUBLIC:'false',
  LIVE_MAX_PAID_ACCOUNTS:'1',SCHEDULE_BATCH_LIMIT:'6',
  LIVE_CAPACITY_REVIEWED:'true',PAID_ENTITLEMENTS_ENABLED:'true',
  LIVE_BILLING_WEBHOOKS_ENABLED:'true',LIVE_BILLING_ENABLED:'false'
 });
 const forged=await fetch(origin+'/api/billing/webhook/razorpay-live',{
  method:'POST',redirect:'manual',
  headers:{'content-type':'application/json','x-razorpay-signature':'0'.repeat(64),
   'x-razorpay-event-id':'pilotlaunch2026'},body:'{}',signal:AbortSignal.timeout(10000)});
 if(forged.status!==401)throw Error('Live endpoint failed signature-forgery rejection. Billing remains OFF.');
 console.log('Activating private paid pilot for approved account only...');
 setFinal(true); // final charge-authorizing operation
 try{
  const state=await apiCheck();
  if(state.starter_pilot_available!==false)
   throw Error('Private pilot was unexpectedly shown as publicly available.');
 }catch(e){
  setFinal(false); // emergency rollback prevents new checkout
  throw Error('Post-launch safety check failed. New checkout was paused. '+(e instanceof Error?e.message:''));
 }
 console.log('Private Starter pilot LIVE. Public purchase remains CLOSED; Pro is BLOCKED.');
 console.log('Sign in to the approved account -> Account -> Subscribe to Starter ₹799/month.');
 console.log('First real payment requires explicit Razorpay authorization. Verify a provider-origin signed live webhook.');
 console.log('To pause new purchases: npm run live:pilot:pause');
}catch(error){
 console.error('LeadPath pilot launch halted: '+(error instanceof Error?error.message:String(error)));
 process.exitCode=1;
}finally{rl?.close();}
