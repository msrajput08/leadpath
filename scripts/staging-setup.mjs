// One-command setup for a disposable staging Worker. Never modifies production resources.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const production = path.join(root, 'wrangler.jsonc');
const output = path.join(root, 'wrangler.staging.jsonc');
const databaseName = 'leadpath-staging-db';
const workerName = 'leadpath-staging';
const workerUrl = 'https://leadpath-staging.monty-08-raj.workers.dev';
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

if (!fs.existsSync(wrangler)) {
 console.error('Missing dependencies. Run npm ci first.');
 process.exit(1);
}
if (!fs.existsSync(production)) throw new Error('Run inside the LeadPath repository root.');

const config = JSON.parse(fs.readFileSync(production, 'utf8'));
if (config.name !== 'leadpath' || config.d1_databases?.[0]?.database_name !== 'leadpath-db') {
 throw new Error('Unexpected production config. Stopped to avoid modifying the wrong project.');
}
function wranglerRun(args, capture = false) {
 const result = spawnSync(process.execPath, [wrangler, ...args], {
  cwd: root, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  maxBuffer: 10 * 1024 * 1024
 });
 if (result.error) throw result.error;
 if (result.status !== 0) throw new Error('Wrangler command failed: ' + args.join(' '));
 return result.stdout || '';
}
function databases() {
 const value = JSON.parse(wranglerRun(['d1', 'list', '--json'], true));
 return Array.isArray(value) ? value : Array.isArray(value.result) ? value.result : [];
}
console.log('Checking isolated staging database...');
let db = databases().find(x => x.name === databaseName);
if (!db) {
 console.log('Creating ' + databaseName);
 wranglerRun(['d1', 'create', databaseName]);
 db = databases().find(x => x.name === databaseName);
}
const dbId = db?.uuid || db?.id;
if (typeof dbId !== 'string' || !/^[a-f0-9-]{36}$/i.test(dbId))
 throw new Error('Staging database UUID not found. Production was not changed.');

const staging = structuredClone(config);
staging.name = workerName;
staging.vars = { ...staging.vars, BASE_URL: workerUrl };
staging.triggers = { crons: [] }; // No scheduled Make calls from staging.
staging.d1_databases = [{
 binding: 'DB', database_name: databaseName, database_id: dbId,
 migrations_dir: 'db/migrations'
}];
// Dedicated rate-limit namespace to avoid production counter collisions.
if (Array.isArray(staging.ratelimits)) {
 staging.ratelimits = staging.ratelimits.map(x => ({ ...x, namespace_id: '910247' }));
}
delete staging.previews;
fs.writeFileSync(output, JSON.stringify(staging, null, 2) + '\n');
console.log('Generated private staging-only config: wrangler.staging.jsonc');

console.log('Applying migrations ONLY to ' + databaseName);
wranglerRun(['d1', 'migrations', 'apply', databaseName, '--remote', '--config', output]);

console.log('Building frontend...');
const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const npmArgs = process.platform === 'win32' ? ['/d','/s','/c','npm run build'] : ['run', 'build'];
const build = spawnSync(npmCommand, npmArgs, { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) throw new Error('Build failed. Staging was not deployed.');

console.log('Deploying ONLY staging Worker: ' + workerName);
wranglerRun(['deploy', '--config', output]);
console.log('\nStaging deployed: ' + workerUrl);
console.log('Production Worker leadpath and D1 leadpath-db are untouched.');
console.log('Razorpay test credentials and staging authentication secrets are not configured yet.');
