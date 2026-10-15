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

test('returns the higher live Mempool/UniSat half-hour fee without exposing the API key', async () => {
  const previousFetch = globalThis.fetch;
  let unisatAuth = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://open-api-fractal.unisat.io/v1/indexer/fees/recommended') {
      unisatAuth = new Headers(init.headers).get('Authorization') || '';
      return Response.json({ code: 0, data: { halfHourFee: 4, fastestFee: 5 } });
    }
    if (url === 'https://mempool.fractalbitcoin.io/api/v1/fees/recommended') return Response.json({ halfHourFee: 7, fastestFee: 9 });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest('/api/fees/recommended?chain=FRACTAL_BITCOIN_MAINNET', { ip: '192.0.2.80' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.feeRate, 7);
    assert.equal(data.strategy, 'maximum-of-mempool-and-unisat');
    assert.equal(data.sources.mempool.feeRate, 7);
    assert.equal(data.sources.unisat.feeRate, 4);
    assert.equal(data.network, 'FRACTAL_BITCOIN_MAINNET');
    assert.equal(unisatAuth, 'Bearer test-only');
    assert.equal(JSON.stringify(data).includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('uses the remaining live estimator if one fee source is unavailable', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://open-api.unisat.io/v1/indexer/fees/recommended') throw new Error('UniSat temporarily unavailable');
    if (url === 'https://mempool.space/api/v1/fees/recommended') return Response.json({ halfHourFee: 3 });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest('/api/fees/recommended?chain=BITCOIN_MAINNET', { ip: '192.0.2.81' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.feeRate, 3);
    assert.equal(data.strategy, 'single-provider-fallback');
    assert.equal(data.sources.unisat.available, false);
    assert.equal(data.sources.mempool.available, true);
  } finally { globalThis.fetch = previousFetch; }
});

test('returns a live Fractal balance without exposing the UniSat API key', async () => {
  const previousFetch = globalThis.fetch;
  let unisatAuth = '';
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), 'https://open-api-fractal.unisat.io/v1/indexer/address/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh/balance');
    unisatAuth = new Headers(init.headers).get('Authorization') || '';
    return Response.json({ code: 0, data: { amount: 12345 } });
  };
  try {
    const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const response = await worker.fetch(makeRequest(`/api/fractal/balance?address=${address}`, { ip: '192.0.2.79' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.network, 'FRACTAL_BITCOIN_MAINNET');
    assert.equal(data.address, address);
    assert.deepEqual(data.balance, { amount: 12345 });
    assert.equal(unisatAuth, 'Bearer test-only');
    assert.equal(JSON.stringify(data).includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
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
  assert.equal(response.headers.get('access-control-allow-headers'), 'Accept, Content-Type');
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

test('returns a fresh network-specific live receipt when optional UniSat market data fails', async () => {
  const previousFetch = globalThis.fetch;
  const inscriptionId = `${'a'.repeat(64)}i0`;
  const genesisTxid = 'a'.repeat(64);
  const calledUrls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calledUrls.push(url);
    if (url === `https://open-api.unisat.io/v1/indexer/inscription/info/${inscriptionId}`) {
      return Response.json({ code: 0, data: { address: 'bc1qowner' } });
    }
    if (url === 'https://open-api.unisat.io/v3/market/collection/auction/inscription_info') {
      throw new Error('Optional market index temporarily unavailable');
    }
    if (url === `https://open-api.unisat.io/v1/indexer/tx/${genesisTxid}/ins?cursor=0&size=100`) {
      return Response.json({ code: 0, data: [] });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/live-inscription?inscriptionId=${inscriptionId}&chain=BITCOIN_MAINNET&refresh=1`, { ip: '192.0.2.240' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.owner, 'bc1qowner');
    assert.equal(data.listing.listed, false);
    assert.equal(data.creator, null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-edge-cache'), 'BYPASS');
    assert.equal(calledUrls.length, 3);
    assert.ok(calledUrls.every(url => url.startsWith('https://open-api.unisat.io/')));
  } finally { globalThis.fetch = previousFetch; }
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



test('creates a V5 order without a human token and supports file batches', async () => {
  const previousFetch = globalThis.fetch;
  let createUrl = '';
  let upstreamBody;
  let authHeader = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/indexer/fees/recommended')) return Response.json({ code: 0, data: { halfHourFee: 6 } });
    if (url === 'https://mempool.fractalbitcoin.io/api/v1/fees/recommended') return Response.json({ halfHourFee: 5 });
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
      body,
    }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.orderId, 'order-test-123');
    assert.equal(data.feeRate, 6);
    assert.equal(data.feeStrategy, 'maximum-of-mempool-and-unisat');
    assert.equal(data.feeSources.mempool.feeRate, 5);
    assert.equal(data.feeSources.unisat.feeRate, 6);
    assert.match(createUrl, /^https:\/\/open-api-fractal\.unisat\.io\/v5\/inscribe\/order\/create$/);
    assert.equal(authHeader, 'Bearer test-only');
    assert.equal(upstreamBody.files.length, 2);
    assert.equal(upstreamBody.clientId, 'demro-labs-gallery');
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects Inscribe requests from origins outside the allowlist', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ code: 0, data: {} });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/inscribe/order', {
      method: 'POST', ip: '192.0.2.222', origin: 'https://untrusted.example',
      body: JSON.stringify({}),
    }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 403);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('allows the configured Manus site origin to reach normal Inscribe payload validation', async () => {
  const response = await worker.fetch(makeRequest('/api/inscribe/order', {
    method: 'POST', ip: '192.0.2.237', origin: 'https://punksgallery-mlwdpcwl.manus.space', body: JSON.stringify({}),
  }), {});
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.match(data.error, /Adresse de wallet ou clé publique invalide/i);
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

test('attests confirmed asset-free Fractal UTXOs despite a historical RBF flag and rejects unconfirmed outputs', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const scriptPk = '0014' + '11'.repeat(20);
  const records = ['a', 'b', 'c', 'd'].map((marker, index) => ({
    address,
    txid: marker.repeat(64),
    vout: 0,
    satoshi: 10000,
    scriptPk,
    height: index === 3 ? 0 : 100,
    isLowFee: index === 0,
    isOpInRBF: index === 0 || index === 3,
    inscriptions: [],
    index,
  }));
  const calls = [];
  const lowFeeOptions = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) {
      lowFeeOptions.push(url.searchParams.get('withLowFee'));
      return Response.json({ code: 0, data: { total: records.length, utxo: records } });
    }
    const pathParts = url.pathname.split('/');
    const txid = url.pathname.startsWith('/v1/indexer/utxo/') ? pathParts[4] : pathParts[5];
    const record = records.find(item => item.txid === txid);
    if (url.pathname.startsWith('/v1/indexer/utxo/')) {
      return Response.json({ code: 0, data: { ...record, isSpent: false } });
    }
    if (url.pathname.startsWith('/v1/indexer/runes/utxo/')) {
      return Response.json({ code: 0, data: txid === records[1].txid ? [{ runeid: '1:1', amount: '1' }] : [] });
    }
    if (url.pathname.startsWith('/v1/indexer/alkanes/utxo/')) {
      return Response.json({ code: 0, data: txid === records[2].txid ? [{ alkaneid: '2:1', amount: '1' }] : [] });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25`, { ip: '192.0.2.230' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.utxo.length, 1);
    assert.equal(data.utxo[0].txid, records[0].txid);
    assert.equal(data.utxo[0].isOpInRBF, true);
    assert.equal(data.utxo[0].isLowFee, true);
    assert.equal(data.utxo[0].inscriptionsRunesAlkanesChecked, true);
    assert.deepEqual(lowFeeOptions, ['true']);
    assert.equal(data.utxo.some(item => item.txid === records[3].txid), false);
    assert.ok(calls.includes(`/v1/indexer/runes/utxo/${records[0].txid}/0/balance`));
    assert.ok(calls.includes(`/v1/indexer/alkanes/utxo/${records[0].txid}/0/balance`));
    assert.equal(calls.includes(`/v1/indexer/alkanes/utxo/${records[1].txid}/0/balance`), false);
    assert.equal(JSON.stringify(data).includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('mobile UTXO mode accepts UniSat available outputs that omit optional fee flags', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qmobiletestaddress000000000000000000000';
  const record = {
    address, txid: '1'.repeat(64), vout: 0, satoshi: 120000,
    scriptPk: '0014' + '66'.repeat(20), height: 100, inscriptions: [],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) {
      assert.equal(url.searchParams.get('withLowFee'), 'true');
      return Response.json({ code: 0, data: { total: 1, utxo: [record] } });
    }
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/0`) return Response.json({ code: 0, data: { ...record, isSpent: false } });
    if (url.pathname.endsWith(`/runes/utxo/${record.txid}/0/balance`)) return Response.json({ code: 0, data: [] });
    if (url.pathname.endsWith(`/alkanes/utxo/${record.txid}/0/balance`)) return Response.json({ code: 0, data: [] });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25&mobile=1`, { ip: '192.0.2.241' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.utxo.length, 1);
    assert.equal(data.utxo[0].satoshi, 120000);
    assert.equal(data.utxo[0].isLowFee, false);
    assert.equal(data.utxo[0].isOpInRBF, false);
  } finally { globalThis.fetch = previousFetch; }
});

test('Worker attests that the exact Fractal PSBT inputs cover payment plus fees', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const record = { address, txid: 'e'.repeat(64), vout: 1, satoshi: 50000, scriptPk: '0014' + '44'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, isSpent: false, inscriptions: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/${record.vout}`) return Response.json({ code: 0, data: record });
    if (url.pathname === `/v1/indexer/runes/utxo/${record.txid}/${record.vout}/balance`) return Response.json({ code: 0, data: [] });
    if (url.pathname === `/v1/indexer/alkanes/utxo/${record.txid}/${record.vout}/balance`) return Response.json({ code: 0, data: [] });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const makeBody = minimumSats => JSON.stringify({ chain: 'fractal', address, minimumSats, utxos: [{ txid: record.txid, vout: record.vout, satoshi: record.satoshi, scriptPk: record.scriptPk }] });
    const sufficientResponse = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'POST', ip: '192.0.2.238', body: makeBody(49000) }), { UNISAT_API_KEY: 'test-only' });
    const sufficient = await sufficientResponse.json();
    assert.equal(sufficientResponse.status, 200);
    assert.equal(sufficient.sufficient, true);
    assert.equal(sufficient.safeSats, 50000);
    assert.equal(sufficient.minimumSats, 49000);
    assert.equal(sufficient.verifiedUtxoCount, 1);
    assert.equal(sufficient.utxo[0].txid, record.txid);
    assert.equal(JSON.stringify(sufficient).includes('test-only'), false);

    const insufficientResponse = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'POST', ip: '192.0.2.239', body: makeBody(51000) }), { UNISAT_API_KEY: 'test-only' });
    const insufficient = await insufficientResponse.json();
    assert.equal(insufficientResponse.status, 200);
    assert.equal(insufficient.sufficient, false);
    assert.equal(insufficient.safeSats, 50000);
  } finally { globalThis.fetch = previousFetch; }
});

test('Worker refuses an input whose value differs from the current UniSat outpoint', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const record = { address, txid: 'f'.repeat(64), vout: 0, satoshi: 40000, scriptPk: '0014' + '55'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, isSpent: false, inscriptions: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/0`) return Response.json({ code: 0, data: record });
    throw new Error(`The Worker must reject the changed outpoint before asset lookups: ${url}`);
  };
  try {
    const body = JSON.stringify({ chain: 'fractal', address, minimumSats: 30000, utxos: [{ txid: record.txid, vout: 0, satoshi: 50000, scriptPk: record.scriptPk }] });
    const response = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'POST', ip: '192.0.2.237', body }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'UTXO_CONFIRM_NOT_SPENDABLE');
  } finally { globalThis.fetch = previousFetch; }
});

test('fails closed when a protocol balance response is missing or malformed', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const record = { address, txid: 'd'.repeat(64), vout: 0, satoshi: 10000, scriptPk: '0014' + '22'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, inscriptions: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) return Response.json({ code: 0, data: { total: 1, utxo: [record] } });
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/0`) return Response.json({ code: 0, data: { ...record, isSpent: false } });
    if (url.pathname === `/v1/indexer/runes/utxo/${record.txid}/0/balance`) return Response.json({ code: 0, data: null });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25`, { ip: '192.0.2.231' }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.match(data.error, /temporarily unavailable/i);
    assert.equal(data.code, 'RUNES_INVALID_RESPONSE');
  } finally { globalThis.fetch = previousFetch; }
});

test('never sends the Fractal UniSat secret to the Bitcoin API', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const upstreamAuthorization = [];
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(new URL(String(input)).origin, 'https://open-api.unisat.io');
    upstreamAuthorization.push(new Headers(init.headers).get('Authorization'));
    return new Response('upstream unavailable', { status: 429 });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=bitcoin&address=${address}&cursor=0&size=25`, { ip: '192.0.2.235' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.code, 'UTXO_LIST_UNISAT_HTTP_429');
    assert.equal(JSON.stringify(data).includes(address), false);
    assert.equal(JSON.stringify(data).includes('test-only'), false);
    assert.deepEqual(upstreamAuthorization, [null]);
  } finally { globalThis.fetch = previousFetch; }
});

test('returns 400 for an invalid spendable UTXO query without calling UniSat', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('Unexpected upstream call'); };
  try {
    const response = await worker.fetch(makeRequest('/api/spendable-utxos?chain=unknown&address=bc1qtestaddress0000000000000000000000000', { ip: '192.0.2.236' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.code, 'INVALID_QUERY');
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects an oversized UniSat page instead of skipping uninspected outpoints', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  let detailLookups = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) {
      const utxo = Array.from({ length: 26 }, (_, index) => ({
        address,
        txid: index.toString(16).padStart(64, '0'),
        vout: 0,
        satoshi: 10000,
        scriptPk: '0014' + '33'.repeat(20),
        height: 100,
        isLowFee: false,
        isOpInRBF: false,
        inscriptions: [],
      }));
      return Response.json({ code: 0, data: { total: utxo.length, utxo } });
    }
    if (url.pathname.startsWith('/v1/indexer/utxo/')) detailLookups += 1;
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25`, { ip: '192.0.2.232' }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'UTXO_PAGE_OVERSIZED');
    assert.equal(detailLookups, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('preserves the 1000-file Inscribe limit and rejects file 1001 before upstream access', async () => {
  const previousFetch = globalThis.fetch;
  let acceptedFileCount = 0;
  let orderCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/indexer/fees/recommended')) return Response.json({ code: 0, data: { halfHourFee: 6 } });
    if (url === 'https://mempool.fractalbitcoin.io/api/v1/fees/recommended') return Response.json({ halfHourFee: 5 });
    if (url.endsWith('/v5/inscribe/order/create')) {
      orderCalls += 1;
      acceptedFileCount = JSON.parse(init.body).files.length;
      return Response.json({ code: 0, data: { orderId: 'order-1000-test', status: 'pending', payAddress: 'bc1qtestaddress0000000000000000000000000', amount: 12345 } });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  const common = {
    receiver: 'bc1qtestaddress0000000000000000000000000',
    refundAddress: 'bc1qtestaddress0000000000000000000000000',
    userAddress: 'bc1qtestaddress0000000000000000000000000',
    userPubkey: '02' + 'a'.repeat(64),
    feeRate: 5,
    outputValue: 546,
    chain: 'FRACTAL_BITCOIN_MAINNET',
  };
  try {
    const files = count => Array.from({ length: count }, (_, index) => ({ filename: `file-${index}.txt`, dataURL: 'data:text/plain;base64,QQ==' }));
    const accepted = await worker.fetch(makeRequest('/api/inscribe/order', { method: 'POST', ip: '192.0.2.229', body: JSON.stringify({ ...common, files: files(1000) }) }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(accepted.status, 200);
    assert.equal(acceptedFileCount, 1000);
    const rejected = await worker.fetch(makeRequest('/api/inscribe/order', { method: 'POST', ip: '192.0.2.228', body: JSON.stringify({ ...common, files: files(1001) }) }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /1 à 1000 fichiers/i);
    assert.equal(orderCalls, 1);
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


function createAuthStorageMock() {
  const state = { challenge: null, session: null, ipCounts: new Map() };
  const binding = {
    idFromName(name) { assert.equal(name, 'wallet-auth-v1'); return name; },
    get() {
      return {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body = await request.json();
          if (path === '/challenge/create') {
            state.challenge = { idHash: body.idHash, site: body.site, address: body.address, addressHash: body.addressHash, network: body.network, origin: body.origin, issuedAt: body.issuedAt, expiresAt: body.expiresAt, usedAt: null };
            return Response.json({ created: true });
          }
          if (path === '/rate/ip') {
            const key = `${body.ipHash}:${body.action}:${body.windowStart}`;
            const count = state.ipCounts.get(key) || 0;
            if (count >= body.limit) return Response.json({ code: 'AUTH_IP_RATE_LIMITED' }, { status: 429 });
            state.ipCounts.set(key, count + 1);
            return Response.json({ allowed: true });
          }
          if (path === '/challenge/get') {
            if (!state.challenge || state.challenge.idHash !== body.idHash) return Response.json({ code: 'AUTH_CHALLENGE_NOT_FOUND' }, { status: 404 });
            return Response.json(state.challenge);
          }
          if (path === '/challenge/consume') {
            if (!state.challenge || state.challenge.idHash !== body.idHash || state.challenge.usedAt || state.challenge.expiresAt <= body.now) return Response.json({ created: false }, { status: 409 });
            state.challenge.usedAt = body.now;
            state.session = { tokenHash: body.tokenHash, site: body.site, address: body.address, network: body.network, createdAt: body.now, expiresAt: body.expiresAt };
            return Response.json({ created: true });
          }
          if (path === '/challenge/consume-ownership') {
            if (!state.challenge || state.challenge.idHash !== body.idHash || state.challenge.usedAt || state.challenge.expiresAt <= body.now || state.challenge.site !== body.site || state.challenge.address !== body.address || state.challenge.network !== body.network) return Response.json({ created: false }, { status: 409 });
            state.challenge.usedAt = body.now;
            return Response.json({ created: true });
          }
          if (path === '/session/get') {
            const current = state.session;
            if (!current || current.site !== body.site || current.tokenHash !== body.tokenHash || current.expiresAt <= body.now) return Response.json({ session: null });
            return Response.json({ session: { site: current.site, address: current.address, network: current.network, createdAt: new Date(current.createdAt).toISOString(), expiresAt: new Date(current.expiresAt).toISOString() } });
          }
          if (path === '/session/delete') {
            if (state.session?.site === body.site && state.session.tokenHash === body.tokenHash) state.session = null;
            return Response.json({ ok: true });
          }
          return new Response('Not found', { status: 404 });
        },
      };
    },
  };
  return { binding, state };
}

test('BIP-322 challenge is origin-bound, short-lived, uncached, and stores only the challenge hash', async () => {
  const { binding, state } = createAuthStorageMock();
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const response = await worker.fetch(makeRequest('/api/auth/challenge', {
    method: 'POST',
    ip: '192.0.2.250',
    body: JSON.stringify({ site: 'punks', address, network: 'FRACTAL_BITCOIN_MAINNET' }),
  }), { AUTH_STORAGE: binding });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(result.site, 'punks');
  assert.equal(result.network, 'FRACTAL_BITCOIN_MAINNET');
  assert.equal(Date.parse(result.expiresAt) - Date.now() <= 5 * 60 * 1000, true);
  assert.match(result.message, /URI: https:\/\/demro-labs\.github\.io\/ordinal-punks-collection\//);
  assert.match(result.message, /No payment, transfer, or spending approval is authorized\./);
  assert.equal(state.challenge.idHash.length, 64);
  assert.equal(state.challenge.idHash === result.challengeId, false);
  assert.equal(JSON.stringify(state.challenge).includes(result.challengeId), false);
});

test('BIP-322 verify rejects a malformed signature and does not create a session', async () => {
  const { binding, state } = createAuthStorageMock();
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const challengeResponse = await worker.fetch(makeRequest('/api/auth/challenge', {
    method: 'POST',
    ip: '192.0.2.251',
    body: JSON.stringify({ site: 'pokedex', address, network: 'FRACTAL_BITCOIN_MAINNET' }),
  }), { AUTH_STORAGE: binding });
  const challenge = await challengeResponse.json();
  const response = await worker.fetch(makeRequest('/api/auth/verify', {
    method: 'POST',
    ip: '192.0.2.252',
    body: JSON.stringify({ site: 'pokedex', challengeId: challenge.challengeId, address, network: 'FRACTAL_BITCOIN_MAINNET', signature: 'ZmFrZV9zaWduYXR1cmU=' }),
  }), { AUTH_STORAGE: binding });
  const result = await response.json();
  assert.equal(response.status, 401);
  assert.equal(result.code, 'AUTH_SIGNATURE_REJECTED');
  assert.equal(state.challenge.usedAt, null);
  assert.equal(state.session, null);
});

test('ownership challenges support Bitcoin and Fractal without creating an authentication session', async () => {
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  for (const network of ['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET']) {
    const { binding, state } = createAuthStorageMock();
    const response = await worker.fetch(makeRequest('/api/auth/ownership/challenge', {
      method: 'POST',
      ip: `192.0.2.${network === 'BITCOIN_MAINNET' ? '241' : '242'}`,
      body: JSON.stringify({ site: 'pokedex', address, network }),
    }), { AUTH_STORAGE: binding });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(result.action, 'ownership-proof-only');
    assert.equal(result.site, 'pokedex');
    assert.equal(result.network, network);
    assert.match(result.message, new RegExp(`Network: ${network}`));
    assert.match(result.message, /does not authorize, sign, or broadcast a payment or transfer/i);
    assert.match(result.message, /A separate UniSat transaction approval is required/i);
    assert.equal(state.challenge.network, network);
    assert.equal(state.session, null);
  }
});

test('ownership verification rejects an invalid BIP-322 signature without consuming the proof or creating a session', async () => {
  const { binding, state } = createAuthStorageMock();
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const network = 'BITCOIN_MAINNET';
  const challengeResponse = await worker.fetch(makeRequest('/api/auth/ownership/challenge', {
    method: 'POST',
    ip: '192.0.2.243',
    body: JSON.stringify({ site: 'punks', address, network }),
  }), { AUTH_STORAGE: binding });
  const challenge = await challengeResponse.json();
  const response = await worker.fetch(makeRequest('/api/auth/ownership/verify', {
    method: 'POST',
    ip: '192.0.2.244',
    body: JSON.stringify({ site: 'punks', challengeId: challenge.challengeId, address, network, signature: 'ZmFrZV9zaWduYXR1cmU=' }),
  }), { AUTH_STORAGE: binding });
  const result = await response.json();
  assert.equal(response.status, 401);
  assert.equal(result.code, 'AUTH_SIGNATURE_REJECTED');
  assert.equal(state.challenge.usedAt, null);
  assert.equal(state.session, null);
});

test('BIP-322 routes reject other origins and fail closed without the Durable Object binding', async () => {
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const denied = await worker.fetch(makeRequest('/api/auth/challenge', {
    method: 'POST',
    origin: 'https://attacker.example',
    ip: '192.0.2.253',
    body: JSON.stringify({ site: 'punks', address, network: 'FRACTAL_BITCOIN_MAINNET' }),
  }), {});
  assert.equal(denied.status, 403);
  const missingBinding = await worker.fetch(makeRequest('/api/auth/challenge', {
    method: 'POST',
    ip: '192.0.2.254',
    body: JSON.stringify({ site: 'punks', address, network: 'FRACTAL_BITCOIN_MAINNET' }),
  }), {});
  assert.equal(missingBinding.status, 503);
  assert.equal((await missingBinding.json()).code, 'AUTH_STORAGE_UNAVAILABLE');
});
