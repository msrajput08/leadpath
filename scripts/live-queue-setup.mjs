// Creates one Free-plan Cloudflare Queue (if needed) and prepares an ignored
// production deployment config. NEVER deploys a Worker or enables real billing.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=process.cwd(),file=path.join(root,'wrangler.live.local.jsonc');
const cli=path.join(root,'node_modules','wrangler','bin','wrangler.js');
const queue='leadpath-monitor-jobs';
if(!fs.existsSync(file))throw Error('First run npm run live:preflight.');
if(!fs.existsSync(cli))throw Error('Missing Wrangler; run npm ci.');
const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
if(cfg.name!=='leadpath'||cfg.vars?.BASE_URL!=='https://leadpath.monty-08-raj.workers.dev'||
 cfg.d1_databases?.[0]?.database_name!=='leadpath-db')
 throw Error('Production account/Worker/DB mismatch; no changes made.');
if(cfg.queues&&JSON.stringify(cfg.queues)!==JSON.stringify({
 producers:[{binding:'MONITOR_QUEUE',queue}],
 consumers:[{queue,max_batch_size:1,max_batch_timeout:1,max_retries:5}]
}))throw Error('Unexpected existing Queue config. Review manually; no changes made.');
function wrangler(args){
 const r=spawnSync(process.execPath,[cli,...args,'--config',file],{
  cwd:root,encoding:'utf8',stdio:['inherit','pipe','pipe'],maxBuffer:2e6});
 if(r.error||r.status!==0)throw Error('Wrangler '+args.join(' ')+' failed: '+(r.stderr||'Login required').slice(0,900));
 return r.stdout;
}
const listing=wrangler(['queues','list']);
if(!listing.includes(queue)){
 console.log('Creating only the Free-plan Queue '+queue+'...');
 wrangler(['queues','create',queue]);
}else console.log('Queue already exists: '+queue);
cfg.queues={
 producers:[{binding:'MONITOR_QUEUE',queue}],
 consumers:[{queue,max_batch_size:1,max_batch_timeout:1,max_retries:5}]
};
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+'\n');
console.log('Queue binding staged in ignored wrangler.live.local.jsonc.');
console.log('This command did NOT deploy code, change D1 or enable real checkout.');
console.log('Next: npm run build && npx wrangler deploy --config wrangler.live.local.jsonc');
