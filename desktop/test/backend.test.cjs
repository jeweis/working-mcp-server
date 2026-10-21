'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Backend } = require('../backend.cjs');

test('each application gets an independent private admin token', () => {
  const a = new Backend(), b = new Backend();
  assert.equal(a.adminToken.length, 64);
  assert.notEqual(a.adminToken, b.adminToken);
});

test('proxy refuses arbitrary endpoints and stopped services', async () => {
  const backend = new Backend();
  await assert.rejects(backend.request('/api/state'), /unavailable/);
  backend.origin = 'http://127.0.0.1:1';
  await assert.rejects(backend.request('/mcp'), /unavailable/);
});

test('shutdown is idempotent before a process is started', async () => {
  const backend = new Backend();
  await backend.stop();
  await backend.stop();
  assert.equal(backend.stopping, true);
});

test('failed backend launch settles and cleans up without hanging', async () => {
  const backend = new Backend();
  await assert.rejects(backend.start('/this-executable-does-not-exist/working-mcp', [], {env: process.env}), /ENOENT/);
  await backend.stop();
});
