import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../.test-build/index.js';

const base = 'https://leadpath.example';
const context = { waitUntil() {} };

test('GitHub OAuth failures are caught and return a safe 500 rather than an uncaught exception', async () => {
  const env = { BASE_URL: base, GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret' };
  const res = await worker.fetch(new Request(base + '/auth/github/start'), env, context);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Unexpected server error/);
});

test('public status distinguishes OAuth configuration from database and schema readiness', async () => {
  const env = { BASE_URL: base, GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret' };
  const noDb = await worker.fetch(new Request(base + '/api/public/status'), env, context);
  const first = await noDb.json();
  assert.equal(first.github_auth_configured, true);
  assert.equal(first.db_binding_configured, false);
  assert.equal(first.db_schema_ready, false);

  const db = {prepare(query) {
    assert.match(query, /oauth_states/);
    return { all: async () => ({results: [], success: true}) };
  }};
  const ready = await worker.fetch(new Request(base + '/api/public/status'), {...env, DB: db}, context);
  const second = await ready.json();
  assert.equal(second.db_binding_configured, true);
  assert.equal(second.db_schema_ready, true);

  const badDb = {prepare() {return { all: async () => {throw new Error('No such table');} }}};
  const broken = await worker.fetch(new Request(base + '/api/public/status'), {...env, DB: badDb}, context);
  const last = await broken.json();
  assert.equal(last.db_binding_configured, true);
  assert.equal(last.db_schema_ready, false);
});

test('public pricing availability is closed by default, opens for one gated Starter pilot, and closes at capacity',async()=>{
 const baseFlags={
  BASE_URL:base,LIVE_PILOT_PLAN:'starter',LIVE_BILLING_ENABLED:'true',
  LIVE_BILLING_WEBHOOKS_ENABLED:'true',RAZORPAY_LIVE_WEBHOOK_SECRET:'signed-test-secret',
  PAID_ENTITLEMENTS_ENABLED:'true',LIVE_CAPACITY_REVIEWED:'true',
  LIVE_MAX_PAID_ACCOUNTS:'1',SCHEDULE_BATCH_LIMIT:'6',
  RAZORPAY_LIVE_KEY_ID:'rzp_live_test_public_api',RAZORPAY_LIVE_KEY_SECRET:'mocked-secret',
  RAZORPAY_LIVE_STARTER_PLAN_ID:'plan_StarterTest123',
  RAZORPAY_LIVE_PRO_PLAN_ID:'plan_ProTest123'
 };
 let occupied=0;
 const DB={prepare(query){
  assert.match(query,/live_billing_slots/);
  return {async first(){return {total:occupied};}};
 }};
 const url=base+'/api/public/billing';
 const closed=await worker.fetch(new Request(url),{...baseFlags,DB,LIVE_BILLING_ENABLED:'false'},context);
 assert.equal(closed.status,200);
 assert.equal((await closed.json()).starter_pilot_available,false);
 assert.match(closed.headers.get('Cache-Control'),/no-store/);
 const opened=await worker.fetch(new Request(url),{...baseFlags,DB},context);
 const available=await opened.json();
 assert.equal(available.starter_pilot_available,true);
 assert.equal(available.pro_available,false);
 assert.equal(available.pilot_plan,'starter');
 assert.equal(JSON.stringify(available).includes('mocked-secret'),false);
 occupied=1;
 const full=await worker.fetch(new Request(url),{...baseFlags,DB},context);
 assert.equal((await full.json()).starter_pilot_available,false);
 const unavailable=await worker.fetch(new Request(url),{...baseFlags,DB:{prepare(){throw Error('D1 down');}}},context);
 assert.equal((await unavailable.json()).starter_pilot_available,false,'billing must fail closed if D1 is unhealthy');
});
