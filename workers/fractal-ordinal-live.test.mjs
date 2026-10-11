import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './fractal-ordinal-live.js';

const base = 'https://fractal-ordinal-live.servostar23.workers.dev';
const allowedOrigin = 'https://demro-labs.github.io';

function makeRequest(path, { method = 'GET', origin = allowedOrigin, ip = '192.0.2.10', headers: extraHeaders = {}, body } = {}) {
  const headers = new Headers(extraHeaders);
  if (origin) headers.set('Origin', origin);
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Request(base + path, { method, headers, ...(body === undefined ? {} : { body }) });
}

test('responses contain API security headers and allow the site origin', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=invalid'), {});
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('caches successful public market responses at the edge', async () => {
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const previousFetch = globalThis.fetch;
  const entries = new Map();
  const cache = {
    async match(request) { return entries.get(request.url)?.clone() || undefined; },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
  let upstreamCalls = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: cache } });
  globalThis.fetch = async (input) => {
    upstreamCalls += 1;
    const url = String(input);
    if (url.includes('collection_statistic')) return Response.json({ code: 0, data: { name: 'Ordinal Punks', floorPrice: 100000000, listed: 1, total: 10000, btcValue: 0 } });
    if (url.endsWith('/auction/list')) return Response.json({ code: 0, data: { list: [], total: 1 } });
    if (url.endsWith('/auction/actions')) return Response.json({ code: 0, data: { list: [] } });
    if (url.includes('coingecko')) return Response.json({ 'fractal-bitcoin': { usd: 0.4 } });
    if (url.includes('coinpaprika')) return Response.json({ quotes: { USD: { price: 0.4 } } });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const env = { UNISAT_API_KEY: 'test-only' };
    const path = '/api/market?collectionId=opunk&start=0&limit=20';
    const first = await worker.fetch(makeRequest(path, { ip: '192.0.2.90' }), env);
    const second = await worker.fetch(makeRequest(path, { ip: '192.0.2.91' }), env);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-edge-cache'), 'MISS');
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-edge-cache'), 'HIT');
    assert.equal(second.headers.get('cache-control'), 'public, max-age=20, s-maxage=20, stale-while-revalidate=60');
    assert.equal(upstreamCalls, 5);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCaches) Object.defineProperty(globalThis, 'caches', previousCaches);
    else delete globalThis.caches;
  }
});

test('rejects unlisted browser origins', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=opunk', { origin: 'https://attacker.example' }), {});
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('supports CORS preflight only for an allowed origin', async () => {
  const response = await worker.fetch(makeRequest('/api/market', { method: 'OPTIONS' }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.match(response.headers.get('access-control-allow-headers') || '', /X-Human-Proof/i);
});

test('rejects methods other than GET, POST and OPTIONS', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=opunk', { method: 'POST' }), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST, OPTIONS');
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



test('requires a verified Cloudflare session before creating a V5 order and supports file batches', async () => {
  const previousFetch = globalThis.fetch;
  let createUrl = '';
  let upstreamBody;
  let authHeader = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://turnstile-human-verification.servostar23.workers.dev/api/session') {
      const session = JSON.parse(init.body);
      assert.equal(session.action, 'ordinal-punks');
      assert.equal(session.proof, 'signed-session-proof');
      return Response.json({ valid: true });
    }
    createUrl = url;
    authHeader = new Headers(init.headers).get('Authorization') || '';
    upstreamBody = JSON.parse(init.body);
    return Response.json({ code: 0, data: { orderId: 'order-test-123', status: 'pending', payAddress: 'bc1qtestaddress0000000000000000000000000', amount: 12345 } });
  };
  try {
    const body = JSON.stringify({
      receiver: 'bc1qtestaddress0000000000000000000000000',
      refundAddress: 'bc1qtestaddress0000000000000000000000000',
      userAddress: 'bc1qtestaddress0000000000000000000000000',
      userPubkey: '02' + 'a'.repeat(64),
      feeRate: 5,
      outputValue: 546,
      chain: 'FRACTAL_BITCOIN_MAINNET',
      files: [
        { filename: 'one.txt', dataURL: 'data:text/plain;base64,QQ==' },
        { filename: 'two.txt', dataURL: 'data:text/plain;base64,Qg==' },
      ],
    });
    const response = await worker.fetch(makeRequest('/api/inscribe/order', {
      method: 'POST', ip: '192.0.2.221',
      headers: { 'X-Human-Action': 'ordinal-punks', 'X-Human-Proof': 'signed-session-proof' },
      body,
    }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.orderId, 'order-test-123');
    assert.match(createUrl, /^https:\/\/open-api-fractal\.unisat\.io\/v5\/inscribe\/order\/create$/);
    assert.equal(authHeader, 'Bearer test-only');
    assert.equal(upstreamBody.files.length, 2);
    assert.equal(upstreamBody.clientId, 'demro-labs-gallery');
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects an Inscribe request without a valid session before touching the UniSat API', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes('turnstile-human-verification')) return Response.json({ valid: false });
    upstreamCalls += 1;
    return Response.json({ code: 0, data: {} });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/inscribe/order', {
      method: 'POST', ip: '192.0.2.222',
      body: JSON.stringify({}),
    }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 403);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('routes Bitcoin order status to the Bitcoin API rather than Fractal', async () => {
  const previousFetch = globalThis.fetch;
  let statusUrl = '';
  globalThis.fetch = async (input) => {
    statusUrl = String(input);
    return Response.json({ code: 0, data: { orderId: 'order-test-456', status: 'pending', files: [] } });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/inscribe/order?orderId=order-test-456&chain=BITCOIN_MAINNET', { ip: '192.0.2.223' }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 200);
    assert.match(statusUrl, /^https:\/\/open-api\.unisat\.io\/v5\/inscribe\/order\/order-test-456$/);
  } finally { globalThis.fetch = previousFetch; }
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
