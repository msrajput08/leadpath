import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {authStart,authCallback,githubStart,githubCallback} from '../.test-build/auth.js';
const encode=(o)=>btoa(JSON.stringify(o)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const b64=(arr)=>btoa(String.fromCharCode(...arr)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function dbMock(){
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../db/migrations/0001_init.sql',import.meta.url),'utf8'));
 return {raw:db,prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(this.sql).get(...this.args)||null;},async run(){const r=db.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)},success:true};},async all(){return {results:db.prepare(this.sql).all(...this.args),success:true};}};},async batch(statements){db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
test('Google OAuth validates signed identity, nonce, state replay, then creates persistent session',async()=>{
 const DB=dbMock(),env={DB,BASE_URL:'https://leadpath.example',GOOGLE_CLIENT_ID:'example-google-client',GOOGLE_CLIENT_SECRET:'example-secret'};
 const began=await authStart(env),authorize=new URL(began.headers.get('Location'));
 assert.equal(authorize.origin,'https://accounts.google.com');
 assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
 const state=authorize.searchParams.get('state'),nonce=authorize.searchParams.get('nonce'),cookie=began.headers.get('set-cookie').split(';')[0];
 const kp=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',kp.publicKey);jwk.kid='test-key';
 const head=encode({alg:'RS256',typ:'JWT',kid:jwk.kid});
 const body=encode({iss:'https://accounts.google.com',aud:env.GOOGLE_CLIENT_ID,sub:'google-123',email:'verified@example.test',email_verified:true,name:'Verified Person',nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600});
 const sig=b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',kp.privateKey,new TextEncoder().encode(head+'.'+body))));
 const jwt=head+'.'+body+'.'+sig;
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url.includes('oauth2.googleapis.com/token'))return Response.json({id_token:jwt});
  if(url.includes('www.googleapis.com/oauth2/v3/certs'))return Response.json({keys:[jwk]});
  throw new Error('Unexpected request '+url);
 };
 try{
  const callbackUrl=`https://leadpath.example/auth/google/callback?state=${state}&code=mock-code`;
  const ok=await authCallback(new Request(callbackUrl,{headers:{cookie}}),env);
  assert.equal(ok.status,303);
  assert.ok(ok.headers.get('set-cookie').includes('__Host-lp_session='));
  assert.equal((await DB.prepare('SELECT COUNT(*) AS c FROM users').first()).c,1);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS c FROM sessions').first()).c,1);
  const replay=await authCallback(new Request(callbackUrl,{headers:{cookie}}),env);
  assert.equal(replay.status,400,'state cannot be reused');
 }finally{globalThis.fetch=oldFetch;DB.raw.close();}
});
test('GitHub OAuth validates state, verified primary email and creates user without storing access token',async()=>{
 const DB=dbMock(),env={DB,BASE_URL:'https://leadpath.example',GITHUB_CLIENT_ID:'test-gh-client',GITHUB_CLIENT_SECRET:'test-gh-secret'};
 const start=await githubStart(env),authorize=new URL(start.headers.get('Location'));
 assert.equal(authorize.origin,'https://github.com');
 assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
 const state=authorize.searchParams.get('state'),cookie=start.headers.get('set-cookie').split(';')[0];
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url)=>{
  if(String(url).includes('/login/oauth/access_token'))return Response.json({access_token:'TEMP_ACCESS_TOKEN'});
  if(String(url).endsWith('/user'))return Response.json({id:321,name:'GitHub Person',login:'ghperson',avatar_url:'https://avatars.githubusercontent.com/u/321'});
  if(String(url).endsWith('/user/emails'))return Response.json([{email:'gh@example.test',primary:true,verified:true}]);
  throw new Error('unexpected GitHub URL');
 };
 try{
  const req=new Request(`https://leadpath.example/auth/github/callback?state=${state}&code=mock-code`,{headers:{cookie}});
  const res=await githubCallback(req,env);
  assert.equal(res.status,303);
  assert.ok(res.headers.get('set-cookie').includes('__Host-lp_session='));
  assert.equal((await DB.prepare('SELECT email FROM users').first()).email,'gh@example.test');
  assert.equal((await DB.prepare("SELECT provider FROM oauth_identities WHERE provider_user_id='321'").first()).provider,'github');
  const repeat=await githubCallback(req,env);
  assert.equal(repeat.status,400);
 }finally{globalThis.fetch=oldFetch;DB.raw.close();}
});
