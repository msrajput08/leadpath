import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../.test-build/index.js';
import { readSmallJson, readBoundedJson, InputError } from '../.test-build/util.js';

const base='https://leadpath.example';
const ctx={waitUntil(p){p.catch(()=>{});}};

test('request bodies are byte-bounded and malformed payloads return client errors',async()=>{
 const invalid=new Request(base+'/api/monitors',{method:'POST',headers:{'content-type':'application/json'},body:'{oops'});
 await assert.rejects(readSmallJson(invalid),e=>e instanceof InputError&&e.status===400);
 const media=new Request(base+'/api/monitors',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'});
 await assert.rejects(readSmallJson(media),e=>e instanceof InputError&&e.status===415);
 const long=new Request(base+'/api/monitors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a:'x'.repeat(8400)})});
 await assert.rejects(readSmallJson(long),e=>e instanceof InputError&&e.status===413);
 const array=new Request(base+'/api/monitors',{method:'POST',headers:{'content-type':'application/json'},body:'[]'});
 await assert.rejects(readSmallJson(array),e=>e instanceof InputError&&e.status===400);
 const normal=new Request(base+'/api/monitors',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"ok"}'});
 assert.equal((await readSmallJson(normal)).name,'ok');
 const smallLimit=new Request(base+'/api/callback/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a:'x'.repeat(2000)})});
 await assert.rejects(readBoundedJson(smallLimit,1024),e=>e instanceof InputError&&e.status===413);
});
test('GitHub/Google OAuth and public status are throttled before provider and database access',async()=>{
 const keys=[];
 const env={BASE_URL:base,GITHUB_CLIENT_ID:'client',GITHUB_CLIENT_SECRET:'secret',RATE_LIMITER:{async limit({key}){keys.push(key);return {success:false};}}};
 const h={'CF-Connecting-IP':'192.0.2.12'};
 for(const path of ['/auth/github/start','/auth/google/start','/auth/github/callback?state=x','/api/public/status']){
  const res=await worker.fetch(new Request(base+path,{headers:h}),env,ctx);
  assert.equal(res.status,429,path);
 }
 assert.equal(keys.length,4);
 assert.equal(keys[0],keys[1],'both OAuth providers share per-IP limits');
 assert.ok(keys[3].startsWith('public-status:'));
});
test('Cron errors remain observable and request errors are contained',async()=>{
 const env={BASE_URL:base,DB:{prepare(){throw new Error('database offline');}}};
 await assert.rejects(worker.scheduled(null,env,ctx),/database offline/);
 const res=await worker.fetch(new Request(base+'/api/alerts'),env,ctx);
 assert.equal(res.status,401,'missing session is rejected without touching D1');
 const secretRes=await worker.fetch(new Request(base+'/auth/github/start'),{BASE_URL:base,GITHUB_CLIENT_ID:'id',GITHUB_CLIENT_SECRET:'secret'},ctx);
 assert.equal(secretRes.status,500,'missing DB is a handled server error, never uncaught Worker 1101');
});
