import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './fractal-ordinal-live.js';

const base = 'https://fractal-ordinal-live.servostar23.workers.dev';
const allowedOrigin = 'https://demro-labs.github.io';

function makeRequest(path, { method = 'GET', origin = allowedOrigin, ip = '192.0.2.10' } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (ip) headers['CF-Connecting-IP'] = ip;
  return new Request(base + path, { method, headers });
}

test('responses contain API security headers and allow the site origin', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=invalid'), {});
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('rejects unlisted browser origins', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=opunk', { origin: 'https://attacker.example' }), {});
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('supports CORS preflight only for an allowed origin', async () => {
  const response = await worker.fetch(makeRequest('/api/market', { method: 'OPTIONS' }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

test('rejects methods other than GET and OPTIONS', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=opunk', { method: 'POST' }), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
});

test('rejects unknown collections, invalid offsets, and oversized pages before upstream access', async () => {
  for (const query of [
    'collectionId=unknown',
    'collectionId=opunk&start=-1',
    'collectionId=opunk&start=10001',
    'collectionId=opunk&limit=21',
    'collectionId=opunk&limit=0',
  ]) {
    const response = await worker.fetch(makeRequest('/api/market?' + query), {});
    assert.equal(response.status, 400, query);
  }
});

test('rejects malformed inscription identifiers before upstream access', async () => {
  const response = await worker.fetch(makeRequest('/api/live-inscription?inscriptionId=not-an-id'), {});
  assert.equal(response.status, 400);
});

test('applies the per-isolate request ceiling and a retry hint', async () => {
  const ip = '192.0.2.200';
  for (let i = 0; i < 180; i += 1) {
    const response = await worker.fetch(makeRequest('/api/market?collectionId=invalid', { ip }), {});
    assert.equal(response.status, 400);
  }
  const limited = await worker.fetch(makeRequest('/api/market?collectionId=invalid', { ip }), {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('caps the per-isolate client table under rotating IPs', async () => {
  let blocked = false;
  for (let i = 0; i < 10002; i += 1) {
    const ip = `198.51.${Math.floor(i / 256)}.${i % 256}`;
    const response = await worker.fetch(makeRequest('/api/market?collectionId=invalid', { ip }), {});
    if (response.status === 429) {
      blocked = true;
      break;
    }
    assert.equal(response.status, 400);
  }
  assert.equal(blocked, true);
});
