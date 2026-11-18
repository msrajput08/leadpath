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
