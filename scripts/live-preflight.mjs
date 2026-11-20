// Read-only Cloudflare preflight for a future reviewed live rollout.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=process.cwd();
const production=path.join(root,'wrangler.jsonc');
const generated=path.join(root,'wrangler.live.local.jsonc');
const wrangler=path.join(root,'node_modules','wrangler','bin','wrangler.js');
if(!fs.existsSync(production)||!fs.existsSync(wrangler))throw Error('Run npm ci in the LeadPath repository first.');
const config=JSON.parse(fs.readFileSync(production,'utf8'));
if(config.name!=='leadpath'||config.d1_databases?.[0]?.database_name!=='leadpath-db'||
 config.vars?.BASE_URL!=='https://leadpath.monty-08-raj.workers.dev')
 throw Error('Production target mismatch; refusing to generate live configuration.');
// Wrangler's D1 list is read-only. No staging or production schema changes occur.
const tmp=path.join(root,'wrangler.live.preflight.tmp.jsonc');
const lookup=structuredClone(config);
lookup.d1_databases=[];
fs.writeFileSync(tmp,JSON.stringify(lookup,null,2)+'\n');
let dbs;
try {
 const result=spawnSync(process.execPath,[wrangler,'d1','list','--json','--config',tmp],{
  encoding:'utf8',maxBuffer:10000000,stdio:['inherit','pipe','inherit']});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error('Cloudflare D1 list failed. Login using npx wrangler login.');
 const parsed=JSON.parse(result.stdout);
 dbs=Array.isArray(parsed)?parsed:parsed.result||[];
}finally{fs.rmSync(tmp,{force:true});}
const db=dbs.find(x=>x.name==='leadpath-db');
const id=db?.uuid||db?.id;
if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))throw Error('Could not verify production D1 database identity.');
lookup.d1_databases=[{binding:'DB',database_name:'leadpath-db',database_id:id,
 migrations_dir:'db/migrations'}];
// A later preflight must not accidentally detach a live Queue binding.
if(fs.existsSync(generated)){
 const old=JSON.parse(fs.readFileSync(generated,'utf8'));
 if(old.name==='leadpath'&&old.d1_databases?.[0]?.database_name==='leadpath-db'&&old.queues){
  const q=old.queues;
  if(q.producers?.length!==1||q.producers[0]?.binding!=='MONITOR_QUEUE'||
     q.producers[0]?.queue!=='leadpath-monitor-jobs'||q.consumers?.length!==1||
     q.consumers[0]?.queue!=='leadpath-monitor-jobs')
    throw Error('Unexpected existing production Queue bindings. No config overwritten.');
  lookup.queues=q;
 }
}
fs.writeFileSync(generated,JSON.stringify(lookup,null,2)+'\n');
console.log('\nVerified production D1 mapping. Generated ignored wrangler.live.local.jsonc.');
console.log('No live changes, billing, charges or deployment have occurred.');
console.log('\nNEXT (after merchant plan IDs + webhook and independent capacity sign-off):');
console.log('1. Backup: npx wrangler d1 export leadpath-db --remote --config wrangler.live.local.jsonc --output backups/leadpath-pre-live.sql');
console.log('2. Migrate: npx wrangler d1 migrations apply leadpath-db --remote --config wrangler.live.local.jsonc');
console.log('3. Deploy: npm run build && npx wrangler deploy --config wrangler.live.local.jsonc');
console.log('4. Set LIVE Razorpay secrets and explicit rollout flags separately; do not enable paid checkout before signed webhook and capacity checks.');
