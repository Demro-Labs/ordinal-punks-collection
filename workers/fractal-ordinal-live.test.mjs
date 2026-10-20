test('quotes and creates BRC-20, Runes, and Alkanes protocol orders using V5 routes', async () => {
  const previousFetch = globalThis.fetch;
  const protocolCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/v1/indexer/fees/recommended')) return Response.json({ code: 0, data: { halfHourFee: 6 } });
    if (url.origin === 'https://mempool.space' || url.origin === 'https://mempool.fractalbitcoin.io') return Response.json({ halfHourFee: 5 });
    if (!url.pathname.startsWith('/v5/inscribe/')) throw new Error(`Unexpected upstream URL: ${url}`);
    const auth = new Headers(init.headers).get('Authorization');
    const body = init.body ? JSON.parse(init.body) : {};
    protocolCalls.push({ path: url.pathname, body, auth });
    if (url.pathname.includes('/quote/')) return Response.json({ code: 0, data: { payableAmount: 25000 } });
    if (url.pathname === '/v5/inscribe/order/estimate-fee') return Response.json({ code: 0, data: { payableAmount: 25000 } });
    if (url.pathname.includes('/order/create')) return Response.json({ code: 0, data: { orderId: `order-${protocolCalls.length}-test`, status: 'pending', payAddress: 'bc1qtestaddress0000000000000000000000000', amount: 25000 } });
    throw new Error(`Unexpected V5 inscription route: ${url}`);
  };
  const common = {
    receiver: 'bc1qtestaddress0000000000000000000000000',
    refundAddress: 'bc1qtestaddress0000000000000000000000000',
    userAddress: 'bc1qtestaddress0000000000000000000000000',
    userPubkey: '02' + 'a'.repeat(64),
    feeRate: 5,
    outputValue: 546,
  };
  try {
    const orders = [
      { chain: 'BITCOIN_MAINNET', protocol: { type: 'brc20', operation: 'deploy', ticker: 'ordi', max: '21000000', limit: '1000', decimals: 18 } },
      { chain: 'FRACTAL_BITCOIN_MAINNET', protocol: { type: 'runes-etch', spacedRune: 'TEST•RUNE', symbol: 'T', divisibility: 2, premine: '1000', terms: { amount: '1', cap: '100', height: [850000, 850100] } } },
      { chain: 'FRACTAL_BITCOIN_MAINNET', protocol: { type: 'runes-mint', runeid: '840000:3', count: 2 } },
      { chain: 'FRACTAL_BITCOIN_MAINNET', protocol: { type: 'alkanes-deploy' }, files: [{ filename: 'contract.wasm', dataURL: 'data:application/octet-stream;base64,QQ==' }] },
      { chain: 'FRACTAL_BITCOIN_MAINNET', protocol: { type: 'alkanes-mint', alkaneid: '2:1', count: 2 } },
    ];
    for (let index = 0; index < orders.length; index += 1) {
      const order = orders[index];
      const response = await worker.fetch(makeRequest('/api/inscribe/order', { method: 'POST', ip: `192.0.2.${60 - index}`, body: JSON.stringify({ ...common, ...order }) }), {
        UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only',
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.quoteAmount, 25000);
      assert.equal(result.amount, 25000);
    }

    const expectedPaths = [
      '/v5/inscribe/order/estimate-fee', '/v5/inscribe/order/create',
      '/v5/inscribe/order/quote/runes-etch', '/v5/inscribe/order/create/runes-etch',
      '/v5/inscribe/order/quote/runes-mint', '/v5/inscribe/order/create/runes-mint',
      '/v5/inscribe/order/quote/alkanes-deploy', '/v5/inscribe/order/create/alkanes-deploy',
      '/v5/inscribe/order/quote/alkanes-mint', '/v5/inscribe/order/create/alkanes-mint',
    ];
    assert.deepEqual(protocolCalls.map(call => call.path), expectedPaths);
    const brc20Payload = JSON.parse(Buffer.from(protocolCalls[1].body.files[0].dataURL.split(',')[1], 'base64').toString('utf8'));
    assert.deepEqual(brc20Payload, { p: 'brc-20', op: 'deploy', tick: 'ordi', max: '21000000', lim: '1000', dec: '18' });
    assert.equal(protocolCalls[2].body.files[0].runes_etch.etching.spacedRune, 'TEST•RUNE');
    assert.equal(protocolCalls[5].body.runeId, '840000:3');
    assert.equal(protocolCalls[9].body.alkaneid, '2:1');
    assert.deepEqual(protocolCalls.map(call => call.auth), [
      'Bearer bitcoin-test-only', 'Bearer bitcoin-test-only',
      'Bearer fractal-test-only', 'Bearer fractal-test-only',
      'Bearer fractal-test-only', 'Bearer fractal-test-only',
      'Bearer fractal-test-only', 'Bearer fractal-test-only',
      'Bearer fractal-test-only', 'Bearer fractal-test-only',
    ]);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects malformed protocol inscription payloads before upstream calls', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('Unexpected upstream call'); };
  try {
    const common = {
      receiver: 'bc1qtestaddress0000000000000000000000000',
      refundAddress: 'bc1qtestaddress0000000000000000000000000',
      userAddress: 'bc1qtestaddress0000000000000000000000000',
      userPubkey: '02' + 'a'.repeat(64),
      feeRate: 5,
      outputValue: 546,
      chain: 'BITCOIN_MAINNET',
    };
    for (const protocol of [
      { type: 'brc20', operation: 'deploy', ticker: 'ordi', max: '1x', limit: '1', decimals: 18 },
      { type: 'runes-mint', runeid: 'invalid', count: 1 },
      { type: 'alkanes-mint', alkaneid: '2:1', count: 0 },
    ]) {
      const response = await worker.fetch(makeRequest('/api/inscribe/order', { method: 'POST', ip: '192.0.2.50', body: JSON.stringify({ ...common, protocol }) }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
      assert.equal(response.status, 400);
    }
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Signer } from '@exodus/bip322-js';
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

function activationTx({ segwit = false, previousTxid = '11'.repeat(32), previousVout = 3, marker = '6a09425243323050524f47' } = {}) {
  const parts = [Buffer.from('02000000', 'hex')];
  if (segwit) parts.push(Buffer.from('0001', 'hex'));
  parts.push(
    Buffer.from('01', 'hex'), Buffer.from(previousTxid, 'hex').reverse(),
    Buffer.from(previousVout.toString(16).padStart(8, '0').match(/../g).reverse().join(''), 'hex'),
    Buffer.from('00fdffffff', 'hex'), Buffer.from('02', 'hex'),
    Buffer.from('0000000000000000', 'hex'), Buffer.from([Buffer.from(marker, 'hex').length]), Buffer.from(marker, 'hex'),
    Buffer.from('1027000000000000', 'hex'), Buffer.from('16', 'hex'), Buffer.from(`0014${'22'.repeat(20)}`, 'hex'),
  );
  if (segwit) parts.push(Buffer.from('0101ab', 'hex'));
  parts.push(Buffer.from('00000000', 'hex'));
  return Buffer.concat(parts).toString('hex');
}

function txidOfNonWitness(rawHex) {
  const firstHash = createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest();
  return createHash('sha256').update(firstHash).digest().reverse().toString('hex');
}

test('reads and strictly normalizes BRC20-Prog six-character balances', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  let upstreamUrl = '';
  let auth = '';
  globalThis.fetch = async (input, init = {}) => {
    upstreamUrl = String(input);
    auth = new Headers(init.headers).get('Authorization') || '';
    return Response.json({ code: 0, data: { detail: [{ ticker: 'ABC-12', overallBalance: '15', transferableBalance: '2', availableBalance: '13' }] } });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/brc20-prog/balances?address=${address}`, { ip: '192.0.2.250' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.network, 'BITCOIN_MAINNET');
    assert.equal(data.detail[0].ticker, 'ABC-12');
    assert.equal(upstreamUrl, `https://open-api.unisat.io/v1/indexer/address/${address}/brc20-prog/summary?start=0&limit=100`);
    assert.equal(auth, 'Bearer bitcoin-test-only');
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('routes BRC20-Prog balance reads to the Fractal UniSat API when requested', async () => {
  const previousFetch = globalThis.fetch;
  let forwarded = null;
  const address = 'bc1qtestaddress0000000000000000000000000';
  globalThis.fetch = async (input, init = {}) => {
    forwarded = { url: String(input), auth: new Headers(init.headers).get('Authorization') };
    return Response.json({ code: 0, data: { detail: [{ ticker: 'ABC-12', overallBalance: '2', transferableBalance: '1', availableBalance: '1' }] } });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/brc20-prog/balances?address=${address}&chain=FRACTAL_BITCOIN_MAINNET`, { ip: '192.0.2.251' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.network, 'FRACTAL_BITCOIN_MAINNET');
    assert.equal(data.detail[0].ticker, 'ABC-12');
    assert.equal(forwarded.url, `https://open-api-fractal.unisat.io/v1/indexer/address/${address}/brc20-prog/summary?start=0&limit=100`);
    assert.equal(forwarded.auth, 'Bearer fractal-test-only');
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});
test('probes only eth_blockNumber for the configured BRC2.0 RPC and keeps credentials server-side', async () => {
  const previousFetch = globalThis.fetch;
  let forwarded = null;
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), 'https://brc20-prog.example/rpc');
    forwarded = { auth: new Headers(init.headers).get('Authorization'), body: JSON.parse(init.body) };
    return Response.json({ jsonrpc: '2.0', id: 'brc20-prog-health', result: '0x123abc' });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/module/status', { ip: '192.0.2.249' }), {
      BRC20_PROG_RPC_URL: 'https://brc20-prog.example/rpc', BRC20_PROG_RPC_USER: 'worker-user', BRC20_PROG_RPC_PASSWORD: 'worker-secret',
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.blockNumber, '0x123abc');
    assert.equal(forwarded.body.method, 'eth_blockNumber');
    assert.deepEqual(forwarded.body.params, []);
    assert.match(forwarded.auth, /^Basic /);
    assert.equal(JSON.stringify(data).includes('worker-secret'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('reports BRC2.0 RPC as unconfigured without attempting an upstream request', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not call upstream'); };
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/module/status', { ip: '192.0.2.248' }), {});
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
    assert.match((await response.json()).error, /BRC2.0/);
  } finally { globalThis.fetch = previousFetch; }
});

test('reads BRC2.0 module balance using only the canonical controller balanceOf call', async () => {
  const previousFetch = globalThis.fetch;
  let forwarded = null;
  globalThis.fetch = async (input, init = {}) => {
    forwarded = { url: String(input), auth: new Headers(init.headers).get('Authorization'), body: JSON.parse(init.body) };
    return Response.json({ jsonrpc: '2.0', id: 'brc20-prog-balance', result: `0x${123456789n.toString(16).padStart(64, '0')}` });
  };
  try {
    const evmAddress = '0x39280601edee011475789c611568e4e925c2dac4';
    const response = await worker.fetch(makeRequest('/api/brc20-prog/module/balance', {
      method: 'POST', ip: '192.0.2.236', body: JSON.stringify({ ticker: 'ABC-12', evmAddress }),
    }), {
      BRC20_PROG_RPC_URL: 'https://brc20-prog.example/rpc', BRC20_PROG_RPC_USER: 'worker-user', BRC20_PROG_RPC_PASSWORD: 'worker-secret',
    });
    const data = await response.json();
    const word = value => BigInt(value).toString(16).padStart(64, '0');
    const ticker = Buffer.from('ABC-12').toString('hex').padEnd(64, '0');
    assert.equal(response.status, 200);
    assert.equal(data.balance, '123456789');
    assert.equal(data.decimals, 18);
    assert.equal(forwarded.url, 'https://brc20-prog.example/rpc');
    assert.equal(forwarded.body.method, 'eth_call');
    assert.deepEqual(forwarded.body.params, [{
      to: '0xc54dd4581af2dbf18e4d90840226756e9d2b3cdb',
      data: `0xfc124ebd${word(64)}${evmAddress.slice(2).padStart(64, '0')}${word(6)}${ticker}`,
    }, 'latest']);
    assert.match(forwarded.auth, /^Basic /);
    assert.equal(JSON.stringify(data).includes('worker-secret'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects malformed BRC2.0 module balance inputs and untrusted origins before RPC access', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('must not call upstream'); };
  try {
    const env = { BRC20_PROG_RPC_URL: 'https://brc20-prog.example/rpc' };
    const invalid = await worker.fetch(makeRequest('/api/brc20-prog/module/balance', {
      method: 'POST', ip: '192.0.2.235', body: JSON.stringify({ ticker: 'BAD', evmAddress: '0x1234' }),
    }), env);
    assert.equal(invalid.status, 400);
    const denied = await worker.fetch(makeRequest('/api/brc20-prog/module/balance', {
      method: 'POST', origin: 'https://attacker.example', ip: '192.0.2.234', body: JSON.stringify({ ticker: 'ABC-12', evmAddress: `0x${'11'.repeat(20)}` }),
    }), env);
    assert.equal(denied.status, 403);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('broadcasts only a structurally valid BRC2.0 activation and returns the matching Bitcoin TXID', async () => {
  const previousFetch = globalThis.fetch;
  const rawTx = activationTx({ segwit: true });
  const expectedTxid = txidOfNonWitness(activationTx());
  let forwarded = null;
  globalThis.fetch = async (input, init = {}) => {
    forwarded = { url: String(input), method: init.method, body: init.body };
    return new Response(expectedTxid, { status: 200 });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/activation/broadcast', {
      method: 'POST', ip: '192.0.2.247', body: JSON.stringify({ txHex: rawTx, inscriptionOutpoint: `${'11'.repeat(32)}:3` }),
    }), {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(data, { network: 'BITCOIN_MAINNET', txid: expectedTxid, status: 'broadcast' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(forwarded.url, 'https://mempool.space/api/tx');
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.body, rawTx);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects a BRC2.0 broadcast whose declared inscription outpoint is not spent', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('must not broadcast'); };
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/activation/broadcast', {
      method: 'POST', ip: '192.0.2.246', body: JSON.stringify({ txHex: activationTx(), inscriptionOutpoint: `${'22'.repeat(32)}:3` }),
    }), {});
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects transactions without the exact zero-value BRC20PROG output before broadcast', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('must not broadcast'); };
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/activation/broadcast', {
      method: 'POST', ip: '192.0.2.245', body: JSON.stringify({ txHex: activationTx({ marker: '6a03424144' }), inscriptionOutpoint: `${'11'.repeat(32)}:3` }),
    }), {});
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('does not report a successful BRC2.0 broadcast when Mempool returns a different TXID', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ff'.repeat(32), { status: 200 });
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/activation/broadcast', {
      method: 'POST', ip: '192.0.2.243', body: JSON.stringify({ txHex: activationTx(), inscriptionOutpoint: `${'11'.repeat(32)}:3` }),
    }), {});
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /TXID/);
  } finally { globalThis.fetch = previousFetch; }
});

test('does not expose the BRC2.0 broadcast route to non-allowlisted origins', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('must not broadcast'); };
  try {
    const response = await worker.fetch(makeRequest('/api/brc20-prog/activation/broadcast', {
      method: 'POST', origin: 'https://attacker.example', ip: '192.0.2.244', body: '{}',
    }), {});
    assert.equal(response.status, 403);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('responses contain API security headers and allow the site origin', async () => {
  const response = await worker.fetch(makeRequest('/api/market?collectionId=invalid'), {});
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('retries transient Mempool 503 responses for Local Vault read routes', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async input => {
    calls += 1;
    assert.equal(String(input), 'https://mempool.fractalbitcoin.io/api/v1/fees/recommended');
    if (calls < 3) return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
    return Response.json({ halfHourFee: 7, fastestFee: 9 });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/mempool/fees?chain=FRACTAL_BITCOIN_MAINNET', { ip: '192.0.2.79' }), {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { halfHourFee: 7, fastestFee: 9 });
    assert.equal(calls, 3);
  } finally { globalThis.fetch = previousFetch; }
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
    const response = await worker.fetch(makeRequest('/api/fees/recommended?chain=FRACTAL_BITCOIN_MAINNET', { ip: '192.0.2.80' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.feeRate, 7);
    assert.equal(data.strategy, 'maximum-of-mempool-and-unisat');
    assert.equal(data.sources.mempool.feeRate, 7);
    assert.equal(data.sources.unisat.feeRate, 4);
    assert.equal(data.network, 'FRACTAL_BITCOIN_MAINNET');
    assert.equal(unisatAuth, 'Bearer fractal-test-only');
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
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
    const response = await worker.fetch(makeRequest('/api/fees/recommended?chain=BITCOIN_MAINNET', { ip: '192.0.2.81' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.feeRate, 3);
    assert.equal(data.strategy, 'single-provider-fallback');
    assert.equal(data.sources.unisat.available, false);
    assert.equal(data.sources.mempool.available, true);
  } finally { globalThis.fetch = previousFetch; }
});

test('uses the separate Bitcoin UniSat secret for Bitcoin fees without exposing either key', async () => {
  const previousFetch = globalThis.fetch;
  let bitcoinAuth = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://open-api.unisat.io/v1/indexer/fees/recommended') {
      bitcoinAuth = new Headers(init.headers).get('Authorization') || '';
      return Response.json({ code: 0, data: { halfHourFee: 8 } });
    }
    if (url === 'https://mempool.space/api/v1/fees/recommended') return Response.json({ halfHourFee: 5 });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest('/api/fees/recommended?chain=BITCOIN_MAINNET', { ip: '192.0.2.82' }), {
      UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only',
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.network, 'BITCOIN_MAINNET');
    assert.equal(data.feeRate, 8);
    assert.equal(data.sources.unisat.available, true);
    assert.equal(data.sources.mempool.available, true);
    assert.equal(bitcoinAuth, 'Bearer bitcoin-test-only');
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('routes live classic BRC-20 summaries to the selected Bitcoin or Fractal UniSat indexer', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const tickers = ['ABCD', 'ABCDE', 'ABCDEF', 'ABCD123'];
  const rows = tickers.map(ticker => ({ ticker, overallBalance: '100', transferableBalance: '25', availableBalance: '75' }));
  const sources = [
    { chain: 'BITCOIN_MAINNET', base: 'https://open-api.unisat.io', key: 'bitcoin-test-only', ip: '192.0.2.90' },
    { chain: 'FRACTAL_BITCOIN_MAINNET', base: 'https://open-api-fractal.unisat.io', key: 'fractal-test-only', ip: '192.0.2.91' },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const source = sources.find(item => String(input).startsWith(item.base));
    assert.ok(source, `Unexpected upstream URL: ${String(input)}`);
    assert.equal(String(input), `${source.base}/v1/indexer/address/${address}/brc20/summary?start=0&limit=25&exclude_zero=true`);
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${source.key}`);
    return Response.json({ code: 0, data: { detail: rows } });
  };
  try {
    for (const source of sources) {
      const response = await worker.fetch(makeRequest(`/api/brc20/balances?address=${address}&chain=${source.chain}`, { ip: source.ip }), {
        UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only',
      });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(data.network, source.chain);
      assert.equal(data.address, address);
      assert.deepEqual(data.detail.map(item => item.ticker), tickers);
      assert.equal(JSON.stringify(data).includes('test-only'), false);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('requires an explicit network for classic BRC-20 balances and transferable inscriptions', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('must not reach upstream'); };
  try {
    const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const balances = await worker.fetch(makeRequest(`/api/brc20/balances?address=${address}`, { ip: '192.0.2.92' }), {});
    const transferable = await worker.fetch(makeRequest(`/api/brc20/transferable?address=${address}&ticker=ABCDEF`, { ip: '192.0.2.93' }), {});
    assert.equal(balances.status, 400);
    assert.equal(transferable.status, 400);
    assert.equal(upstreamCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('does not turn a malformed classic BRC-20 summary into an empty live balance', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 0, data: { total: 1 } });
  try {
    const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const response = await worker.fetch(makeRequest(`/api/brc20/balances?address=${address}&chain=FRACTAL_BITCOIN_MAINNET`, { ip: '192.0.2.94' }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /BRC-20.*indisponibles/i);
  } finally { globalThis.fetch = previousFetch; }
});

test('returns transferable inscriptions for a six-character classic BRC-20 ticker', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const inscriptionId = `${'a'.repeat(64)}i0`;
  globalThis.fetch = async input => {
    assert.equal(String(input), `https://open-api-fractal.unisat.io/v1/indexer/address/${address}/brc20/ABCDEF/transferable-inscriptions?start=0&limit=100`);
    return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ inscriptionId, data: { amt: '12.5' }, confirmations: 3 }] } });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/brc20/transferable?address=${address}&ticker=ABCDEF&chain=FRACTAL_BITCOIN_MAINNET`, { ip: '192.0.2.95' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ticker, 'ABCDEF');
    assert.equal(data.total, 1);
    assert.equal(data.detail[0].amount, '12.5');
  } finally { globalThis.fetch = previousFetch; }
});
test('falls back to the documented address/ticker info endpoint when transferable-inscriptions fails', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const inscriptionId = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai7`;
  const calls = [];
  globalThis.fetch = async input => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/transferable-inscriptions?start=0&limit=100')) {
      return Response.json({ code: -1, msg: 'endpoint temporarily unavailable' });
    }
    assert.equal(url, `https://open-api-fractal.unisat.io/v1/indexer/address/${address}/brc20/ordi/info`);
    return Response.json({ code: 0, data: { transferableCount: 1, transferableInscriptions: [{ inscriptionId, inscriptionNumber: 7, data: { amt: '2.75' }, confirmations: 4 }] } });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/brc20/transferable?address=${address}&ticker=ordi&chain=FRACTAL_BITCOIN_MAINNET`, { ip: '192.0.2.96' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.total, 1);
    assert.equal(data.detail[0].inscriptionId, inscriptionId);
    assert.equal(data.detail[0].amount, '2.75');
    assert.equal(calls.length, 2);
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
    const response = await worker.fetch(makeRequest(`/api/fractal/balance?address=${address}`, { ip: '192.0.2.79' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.network, 'FRACTAL_BITCOIN_MAINNET');
    assert.equal(data.address, address);
    assert.deepEqual(data.balance, { amount: 12345 });
    assert.equal(unisatAuth, 'Bearer fractal-test-only');
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('returns a validated paginated Fractal Rune balance list without exposing the UniSat API key', async () => {
  const previousFetch = globalThis.fetch;
  let unisatAuth = '';
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), `https://open-api-fractal.unisat.io/v1/indexer/address/${address}/runes/balance-list?start=0&limit=2`);
    unisatAuth = new Headers(init.headers).get('Authorization') || '';
    return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ amount: '123450', runeid: '840000:3', rune: 'EXAMPLE', spacedRune: 'EXAMPLE', symbol: 'E', divisibility: 2 }] } });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/runes/balance-list?address=${address}&start=0&limit=2`, { ip: '192.0.2.78' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(data.network, 'FRACTAL_BITCOIN_MAINNET');
    assert.equal(data.address, address);
    assert.equal(data.total, 1);
    assert.equal(data.detail[0].amount, '123450');
    assert.equal(data.detail[0].divisibility, 2);
    assert.equal(unisatAuth, 'Bearer test-only');
    assert.equal(JSON.stringify(data).includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('returns one current Fractal Rune balance and rejects invalid Rune queries before upstream access', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  let upstreamCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    upstreamCalls += 1;
    assert.equal(String(input), `https://open-api-fractal.unisat.io/v1/indexer/address/${address}/runes/840000%3A3/balance`);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    return Response.json({ code: 0, data: { amount: '123450', runeid: '840000:3', rune: 'EXAMPLE', spacedRune: 'EXAMPLE', symbol: 'E', divisibility: 2 } });
  };
  try {
    const invalid = await worker.fetch(makeRequest(`/api/runes/balance?address=${address}&runeid=bad`, { ip: '192.0.2.77' }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(invalid.status, 400);
    assert.equal(upstreamCalls, 0);
    const invalidRune = await worker.fetch(makeRequest(`/api/runes/utxo-list?chain=FRACTAL_BITCOIN_MAINNET&address=${address}&runeid=bad`, { ip: '192.0.2.66' }), { UNISAT_API_KEY: 'fractal-test-only' });
    assert.equal(invalidRune.status, 400);
    assert.equal(upstreamCalls, 0);
    const response = await worker.fetch(makeRequest(`/api/runes/balance?address=${address}&runeid=840000%3A3`, { ip: '192.0.2.76' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(data.balance.runeid, '840000:3');
    assert.equal(data.balance.amount, '123450');
    assert.equal(JSON.stringify(data).includes('test-only'), false);
    assert.equal(upstreamCalls, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('routes Bitcoin Rune balances through the Bitcoin UniSat secret and rejects unsupported chains', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const authHeaders = [];
  let upstreamCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    upstreamCalls += 1;
    assert.equal(url.origin, 'https://open-api.unisat.io');
    authHeaders.push(new Headers(init.headers).get('Authorization'));
    if (url.pathname.endsWith('/runes/balance-list')) {
      return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ amount: '123450', runeid: '840000:3', rune: 'EXAMPLE', spacedRune: 'EXAMPLE', symbol: 'E', divisibility: 2 }] } });
    }
    if (url.pathname.endsWith('/runes/840000%3A3/balance')) {
      return Response.json({ code: 0, data: { amount: '123450', runeid: '840000:3', rune: 'EXAMPLE', spacedRune: 'EXAMPLE', symbol: 'E', divisibility: 2 } });
    }
    throw new Error(`Unexpected Bitcoin Rune URL: ${url}`);
  };
  try {
    const invalid = await worker.fetch(makeRequest(`/api/runes/balance-list?chain=BITCOIN_TESTNET&address=${address}`, { ip: '192.0.2.75' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    assert.equal(invalid.status, 400);
    assert.equal(upstreamCalls, 0);

    const listResponse = await worker.fetch(makeRequest(`/api/runes/balance-list?chain=BITCOIN_MAINNET&address=${address}&start=0&limit=2`, { ip: '192.0.2.74' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.network, 'BITCOIN_MAINNET');
    assert.equal(list.detail[0].amount, '123450');

    const balanceResponse = await worker.fetch(makeRequest(`/api/runes/balance?chain=BITCOIN_MAINNET&address=${address}&runeid=840000%3A3`, { ip: '192.0.2.73' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const balance = await balanceResponse.json();
    assert.equal(balanceResponse.status, 200);
    assert.equal(balance.network, 'BITCOIN_MAINNET');
    assert.equal(balance.balance.runeid, '840000:3');
    assert.deepEqual(authHeaders, ['Bearer bitcoin-test-only', 'Bearer bitcoin-test-only']);
    assert.equal(JSON.stringify(list).includes('bitcoin-test-only'), false);
    assert.equal(JSON.stringify(balance).includes('bitcoin-test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('routes BRC-20 and Alkanes wallet inventory through the selected network secret', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const authHeaders = [];
  let upstreamCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    upstreamCalls += 1;
    authHeaders.push(new Headers(init.headers).get('Authorization'));
    if (url.pathname.endsWith('/brc20/summary')) {
      assert.equal(url.origin, 'https://open-api.unisat.io');
      assert.equal(url.searchParams.get('exclude_zero'), 'true');
      return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ ticker: 'ordi', overallBalance: '12', transferableBalance: '2', availableBalance: '10' }] } });
    }
    assert.equal(url.origin, 'https://open-api-fractal.unisat.io');
    if (url.pathname.endsWith('/alkanes/token-list')) {
      return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ alkaneid: '2:1', type: 'token', tokenData: { name: 'Example', symbol: 'EX', divisibility: 0, totalSupply: '1000', minted: '10', mintable: true } }] } });
    }
    if (url.pathname.endsWith('/alkanes/collection-list')) {
      return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ alkaneid: '2:2', type: 'collection', collectionData: { name: 'Example Collection', totalSupply: '10', minted: 3, holders: 3 } }] } });
    }
    if (url.pathname.endsWith('/alkanes/2%3A1/utxo')) {
      return Response.json({ code: 0, data: { start: 0, total: 1, utxo: [{ address, txid: 'a'.repeat(64), vout: 0, satoshi: 546, confirmations: 3, alkanes: [{ alkaneid: '2:1', amount: '1500', type: 'token' }] }] } });
    }
    if (url.pathname.endsWith('/runes/1%3A1/utxo')) {
      return Response.json({ code: 0, data: { start: 0, total: 1, utxo: [{ address, txid: 'b'.repeat(64), vout: 1, satoshi: 1200, confirmations: 4, runes: [{ runeid: '1:1', amount: '250' }] }] } });
    }
    if (url.pathname.includes('/runes/utxo/') && url.pathname.endsWith('/1/balance')) {
      return Response.json({ code: 0, data: [{ runeid: '1:1', amount: '250' }] });
    }
    throw new Error(`Unexpected wallet protocol URL: ${url}`);
  };
  try {
    const invalid = await worker.fetch(makeRequest(`/api/alkanes/utxo-list?chain=BITCOIN_TESTNET&address=${address}&alkaneid=2%3A1`, { ip: '192.0.2.71' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    assert.equal(invalid.status, 400);
    assert.equal(upstreamCalls, 0);

    const brc20Response = await worker.fetch(makeRequest(`/api/brc20/balance-list?chain=BITCOIN_MAINNET&address=${address}`, { ip: '192.0.2.70' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const brc20 = await brc20Response.json();
    assert.equal(brc20Response.status, 200);
    assert.equal(brc20.network, 'BITCOIN_MAINNET');
    assert.deepEqual(brc20.detail[0], { ticker: 'ordi', overallBalance: '12', transferableBalance: '2', availableBalance: '10' });

    const tokenResponse = await worker.fetch(makeRequest(`/api/alkanes/token-list?chain=FRACTAL_BITCOIN_MAINNET&address=${address}`, { ip: '192.0.2.69' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const tokens = await tokenResponse.json();
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokens.detail[0].tokenData.symbol, 'EX');
    assert.equal(Object.hasOwn(tokens.detail[0], 'balance'), false);

    const collectionResponse = await worker.fetch(makeRequest(`/api/alkanes/collection-list?chain=FRACTAL_BITCOIN_MAINNET&address=${address}`, { ip: '192.0.2.68' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const collections = await collectionResponse.json();
    assert.equal(collectionResponse.status, 200);
    assert.equal(collections.detail[0].collectionData.name, 'Example Collection');

    const utxoResponse = await worker.fetch(makeRequest(`/api/alkanes/utxo-list?chain=FRACTAL_BITCOIN_MAINNET&address=${address}&alkaneid=2%3A1`, { ip: '192.0.2.67' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const utxos = await utxoResponse.json();
    assert.equal(utxoResponse.status, 200);
    assert.equal(utxos.utxo[0].amount, '1500');
    assert.equal(utxos.utxo[0].confirmations, 3);
    const runeResponse = await worker.fetch(makeRequest(`/api/runes/utxo-list?chain=FRACTAL_BITCOIN_MAINNET&address=${address}&runeid=1%3A1`, { ip: '192.0.2.65' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const runeUtxos = await runeResponse.json();
    assert.equal(runeResponse.status, 200);
    assert.equal(runeUtxos.runeid, '1:1');
    assert.deepEqual(runeUtxos.utxo[0].runes, [{ runeid: '1:1', amount: '250' }]);
    assert.deepEqual(authHeaders, ['Bearer bitcoin-test-only', 'Bearer fractal-test-only', 'Bearer fractal-test-only', 'Bearer fractal-test-only', 'Bearer fractal-test-only', 'Bearer fractal-test-only']);
    for (const result of [brc20, tokens, collections, utxos, runeUtxos]) {
      assert.equal(JSON.stringify(result).includes('test-only'), false);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('routes Bitcoin Alkanes collections through the Bitcoin UniSat API and secret', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  let authorization = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://open-api.unisat.io');
    assert.equal(url.pathname, `/v1/indexer/address/${address}/alkanes/collection-list`);
    authorization = new Headers(init.headers).get('Authorization') || '';
    return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ alkaneid: '2:2', type: 'collection', collectionData: { name: 'Bitcoin Collection', totalSupply: '100', minted: 26 } }] } });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/alkanes/collection-list?chain=BITCOIN_MAINNET&address=${address}`, { ip: '192.0.2.66' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.network, 'BITCOIN_MAINNET');
    assert.equal(result.total, 1);
    assert.equal(result.detail[0].collectionData.name, 'Bitcoin Collection');
    assert.equal(authorization, 'Bearer bitcoin-test-only');
    assert.equal(JSON.stringify(result).includes('test-only'), false);
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
    assert.equal(second.headers.get('cache-control'), 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
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

for (const [browser, origin] of [
  ['Chrome/Edge', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
  ['Firefox', 'moz-extension://12345678-1234-1234-1234-123456789abc'],
]) {
  test(`allows Local Vault ${browser} origins for transaction preflight and protected routes`, async () => {
    const preflight = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'OPTIONS', origin }), {});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);

    const confirmation = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', {
      method: 'POST',
      origin,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }), {});
    assert.notEqual(confirmation.status, 403, 'extension origin must pass the origin gate');
  });
}

test('continues rejecting malformed extension origins and unlisted web origins', async () => {
  for (const origin of [
    'chrome-extension://not-a-valid-extension-id',
    'moz-extension://not-a-uuid',
    'https://attacker.example',
  ]) {
    const response = await worker.fetch(makeRequest('/api/market?collectionId=opunk', { origin }), {});
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null, origin);
  }
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
  const upstreamAuthorization = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calledUrls.push(url);
    upstreamAuthorization.push(new Headers(init.headers).get('Authorization'));
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
    const response = await worker.fetch(makeRequest(`/api/live-inscription?inscriptionId=${inscriptionId}&chain=BITCOIN_MAINNET&refresh=1`, { ip: '192.0.2.240' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.owner, 'bc1qowner');
    assert.equal(data.listing.listed, false);
    assert.equal(data.creator, null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-edge-cache'), 'BYPASS');
    assert.equal(calledUrls.length, 3);
    assert.ok(calledUrls.every(url => url.startsWith('https://open-api.unisat.io/')));
    assert.deepEqual(upstreamAuthorization, Array(3).fill('Bearer bitcoin-test-only'));
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
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
  const upstreamCalls = [];
  let upstreamBody;
  let authHeader = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/indexer/fees/recommended')) return Response.json({ code: 0, data: { halfHourFee: 6 } });
    if (url === 'https://mempool.fractalbitcoin.io/api/v1/fees/recommended') return Response.json({ halfHourFee: 5 });
    upstreamCalls.push(url);
    if (url === 'https://open-api-fractal.unisat.io/v5/inscribe/order/estimate-fee') return Response.json({ code: 0, data: { payableAmount: 12000 } });
    if (url === 'https://open-api-fractal.unisat.io/v5/inscribe/order/create') {
      createUrl = url;
      authHeader = new Headers(init.headers).get('Authorization') || '';
      upstreamBody = JSON.parse(init.body);
      return Response.json({ code: 0, data: { orderId: 'order-test-123', status: 'pending', payAddress: 'bc1qtestaddress0000000000000000000000000', amount: 12345 } });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
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
    assert.equal(data.quoteAmount, 12000);
    assert.equal(data.feeRate, 6);
    assert.equal(data.feeStrategy, 'maximum-of-mempool-and-unisat');
    assert.equal(data.feeSources.mempool.feeRate, 5);
    assert.equal(data.feeSources.unisat.feeRate, 6);
    assert.match(createUrl, /^https:\/\/open-api-fractal\.unisat\.io\/v5\/inscribe\/order\/create$/);
    assert.deepEqual(upstreamCalls, ['https://open-api-fractal.unisat.io/v5/inscribe/order/estimate-fee', createUrl]);
    assert.equal(authHeader, 'Bearer test-only');
    assert.equal(upstreamBody.files.length, 2);
    assert.equal(upstreamBody.clientId, 'demro-labs-gallery');
  } finally { globalThis.fetch = previousFetch; }
});

test('creates Bitcoin V5 orders with the Bitcoin UniSat key and Bitcoin Mempool fees', async () => {
  const previousFetch = globalThis.fetch;
  const upstreamAuth = [];
  let createUrl = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://open-api.unisat.io/v1/indexer/fees/recommended') {
      upstreamAuth.push(new Headers(init.headers).get('Authorization'));
      return Response.json({ code: 0, data: { halfHourFee: 7 } });
    }
    if (url === 'https://mempool.space/api/v1/fees/recommended') return Response.json({ halfHourFee: 5 });
    if (url === 'https://open-api.unisat.io/v5/inscribe/order/estimate-fee') {
      upstreamAuth.push(new Headers(init.headers).get('Authorization'));
      return Response.json({ code: 0, data: { payableAmount: 23000 } });
    }
    if (url === 'https://open-api.unisat.io/v5/inscribe/order/create') {
      createUrl = url;
      upstreamAuth.push(new Headers(init.headers).get('Authorization'));
      return Response.json({ code: 0, data: { orderId: 'btc-order-789', status: 'pending', payAddress: 'bc1qpaymentaddress0000000000000000000000', amount: 23456 } });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const body = JSON.stringify({
      receiver: 'bc1qtestaddress0000000000000000000000000',
      refundAddress: 'bc1qtestaddress0000000000000000000000000',
      userAddress: 'bc1qtestaddress0000000000000000000000000',
      userPubkey: '02' + 'a'.repeat(64),
      feeRate: 5,
      outputValue: 546,
      chain: 'BITCOIN_MAINNET',
      files: [{ filename: 'bitcoin.txt', dataURL: 'data:text/plain;base64,QQ==' }],
    });
    const response = await worker.fetch(makeRequest('/api/inscribe/order', { method: 'POST', ip: '192.0.2.244', body }), {
      UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only',
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.network, 'BITCOIN_MAINNET');
    assert.equal(data.orderId, 'btc-order-789');
    assert.equal(data.feeRate, 7);
    assert.equal(data.quoteAmount, 23000);
    assert.equal(data.feeSources.mempool.feeRate, 5);
    assert.equal(data.feeSources.unisat.feeRate, 7);
    assert.equal(createUrl, 'https://open-api.unisat.io/v5/inscribe/order/create');
    assert.deepEqual(upstreamAuth, ['Bearer bitcoin-test-only', 'Bearer bitcoin-test-only', 'Bearer bitcoin-test-only']);
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
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
  let statusAuth = '';
  globalThis.fetch = async (input, init = {}) => {
    statusUrl = String(input);
    statusAuth = new Headers(init.headers).get('Authorization') || '';
    return Response.json({ code: 0, data: { orderId: 'order-test-456', status: 'pending', files: [] } });
  };
  try {
    const response = await worker.fetch(makeRequest('/api/inscribe/order?orderId=order-test-456&chain=BITCOIN_MAINNET', { ip: '192.0.2.223' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    assert.equal(response.status, 200);
    assert.match(statusUrl, /^https:\/\/open-api\.unisat\.io\/v5\/inscribe\/order\/order-test-456$/);
    assert.equal(statusAuth, 'Bearer bitcoin-test-only');
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
    ...(index === 1 ? { runes: [{ runeid: '1:1', amount: '1' }] } : {}),
    ...(index === 2 ? { alkanes: [{ alkaneid: '2:1', amount: '1' }] } : {}),
    index,
  }));
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) {
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
    assert.equal(data.utxo.some(item => item.txid === records[3].txid), false);
    assert.equal(data.diagnostics.hasRunes, 1);
    assert.equal(data.diagnostics.hasAlkanes, 1);
    assert.equal(data.diagnostics.unconfirmedOrInvalidHeight, 1);
    assert.equal(data.diagnosticsSats.hasRunes, records[1].satoshi);
    assert.equal(data.diagnosticsSats.hasAlkanes, records[2].satoshi);
    assert.equal(data.diagnosticsSats.unconfirmedOrInvalidHeight, records[3].satoshi);
    assert.ok(calls.some(path => path.endsWith('/available-utxo-data')));
    assert.equal(calls.some(path => path.includes('/runes/utxo/') || path.includes('/alkanes/utxo/')), false);
    assert.equal(JSON.stringify(data).includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('desktop and mobile use the available-UTXO API without calling the unsupported Alkanes endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qmobiletestaddress000000000000000000000';
  const record = {
    address, txid: '1'.repeat(64), vout: 0, satoshi: 120000,
    scriptPk: '0014' + '66'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, inscriptions: [],
  };
  const upstreamMobileModes = [];
  const upstreamPaths = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    upstreamPaths.push(url.pathname);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) {
      assert.equal(url.searchParams.get('withLowFee'), 'true');
      upstreamMobileModes.push(url.searchParams.get('mobile'));
      return Response.json({ code: 0, data: { total: 1, utxo: [record] } });
    }
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/0`) return Response.json({ code: 0, data: { ...record, isSpent: false } });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    for (const [mode, query, ip] of [
      ['desktop', '', '192.0.2.241'],
      ['mobile', '&mobile=1', '192.0.2.242'],
    ]) {
      const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25${query}`, { ip }), { UNISAT_API_KEY: 'test-only' });
      const data = await response.json();
      assert.equal(response.status, 200, mode);
      assert.equal(data.utxo.length, 1, mode);
      assert.equal(data.utxo[0].txid, record.txid, mode);
    }
    assert.deepEqual(upstreamMobileModes, [null, null]);
    assert.equal(upstreamPaths.some(path => path.includes('/alkanes/utxo/')), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('reports safe-UTXO rejection reasons without exposing addresses or outpoints', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qdiagnosticstestaddress000000000000000';
  const valid = { address, txid: 'a'.repeat(64), vout: 0, satoshi: 120000, scriptPk: '0014' + '66'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, inscriptions: [] };
  const unconfirmed = { ...valid, txid: 'b'.repeat(64), height: 0 };
  const inscription = { ...valid, txid: 'c'.repeat(64), inscriptions: [{ id: 'redacted-test-inscription' }] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) {
      return Response.json({ code: 0, data: { total: 3, utxo: [valid, unconfirmed, inscription] } });
    }
    if (url.pathname === `/v1/indexer/utxo/${valid.txid}/0`) return Response.json({ code: 0, data: { ...valid, isSpent: false } });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25`, { ip: '192.0.2.244' }), { UNISAT_API_KEY: 'test-only' });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.utxo.length, 1);
    assert.equal(data.diagnostics.unconfirmedOrInvalidHeight, 1);
    assert.equal(data.diagnostics.hasInscriptionOrUnknown, 1);
    assert.equal(data.diagnostics.hasRunes, 0);
    assert.equal(data.diagnostics.hasAlkanes, 0);
    assert.deepEqual(data.diagnosticsSats, {
      unconfirmedOrInvalidHeight: 120000, invalidFlags: 0, hasInscriptionOrUnknown: 120000,
      detailMismatch: 0, spentOrUnknown: 0, hasRunes: 0, hasAlkanes: 0,
    });
    const serialized = JSON.stringify(data);
    const diagnosticJson = JSON.stringify(data.diagnostics);
    assert.equal(serialized.includes(address), true); // the existing response includes the requested address
    assert.equal(serialized.includes(valid.txid), true); // only the accepted safe UTXO is returned
    assert.equal(serialized.includes(unconfirmed.txid), false);
    assert.equal(serialized.includes(inscription.txid), false);
    assert.equal(serialized.includes('redacted-test-inscription'), false);
    assert.equal(diagnosticJson.includes(address), false);
    assert.equal(diagnosticJson.includes(valid.txid), false);
    assert.equal(serialized.includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('Worker attests that exact BTC and FB PSBT inputs cover payment plus fees', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const record = { address, txid: 'e'.repeat(64), vout: 1, satoshi: 50000, scriptPk: '0014' + '44'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, isSpent: false, inscriptions: [] };
  let expectedOrigin = 'https://open-api-fractal.unisat.io';
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, expectedOrigin);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) { const available = { ...record }; delete available.isOpInRBF; return Response.json({ code: 0, data: { cursor: Number(url.searchParams.get('cursor')), total: 1, utxo: [available] } }); }
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/${record.vout}`) { const detail = { ...record }; delete detail.isOpInRBF; return Response.json({ code: 0, data: detail }); }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    for (const [chain, ipSuffix, env, origin] of [
      ['fractal', 238, { UNISAT_API_KEY: 'test-only' }, 'https://open-api-fractal.unisat.io'],
      ['bitcoin', 240, { UNISAT_BITCOIN_API: 'test-only' }, 'https://open-api.unisat.io'],
    ]) {
      expectedOrigin = origin;
      const makeBody = minimumSats => JSON.stringify({ chain, address, minimumSats, utxos: [{ txid: record.txid, vout: record.vout, satoshi: record.satoshi, scriptPk: record.scriptPk }] });
      const sufficientResponse = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'POST', ip: `192.0.2.${ipSuffix}`, body: makeBody(49000) }), env);
      const sufficient = await sufficientResponse.json();
      assert.equal(sufficientResponse.status, 200, chain);
      assert.equal(sufficient.chain, chain);
      assert.equal(sufficient.sufficient, true);
      assert.equal(sufficient.safeSats, 50000);
      assert.equal(sufficient.minimumSats, 49000);
      assert.equal(sufficient.verifiedUtxoCount, 1);
      assert.equal(sufficient.utxo[0].txid, record.txid);
      assert.equal(JSON.stringify(sufficient).includes('test-only'), false);

      const insufficientResponse = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'POST', ip: `192.0.2.${ipSuffix+1}`, body: makeBody(51000) }), env);
      const insufficient = await insufficientResponse.json();
      assert.equal(insufficientResponse.status, 200, chain);
      assert.equal(insufficient.chain, chain);
      assert.equal(insufficient.sufficient, false);
      assert.equal(insufficient.safeSats, 50000);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('Worker refuses an input whose value differs from the current UniSat outpoint', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const record = { address, txid: 'f'.repeat(64), vout: 0, satoshi: 40000, scriptPk: '0014' + '55'.repeat(20), height: 100, isLowFee: false, isOpInRBF: false, isSpent: false, inscriptions: [] };
  let detailLookups = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) return Response.json({ code: 0, data: { cursor: 0, total: 1, utxo: [record] } });
    if (url.pathname === `/v1/indexer/utxo/${record.txid}/0`) { detailLookups += 1; return Response.json({ code: 0, data: record }); }
    throw new Error(`The Worker must reject the changed outpoint before detail lookups: ${url}`);
  };
  try {
    const body = JSON.stringify({ chain: 'fractal', address, minimumSats: 30000, utxos: [{ txid: record.txid, vout: 0, satoshi: 50000, scriptPk: record.scriptPk }] });
    const response = await worker.fetch(makeRequest('/api/spendable-utxos/confirm', { method: 'POST', ip: '192.0.2.237', body }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'UTXO_CONFIRM_NOT_IN_AVAILABLE_SET');
    assert.equal(detailLookups, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('fails closed when the available-UTXO response is missing or malformed', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-only');
    if (url.pathname.endsWith('/available-utxo-data')) return Response.json({ code: 0, data: { cursor: 0, total: 1, utxo: null } });
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=fractal&address=${address}&cursor=0&size=25`, { ip: '192.0.2.231' }), { UNISAT_API_KEY: 'test-only' });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.code, 'UTXO_LIST_INVALID_RESPONSE');
  } finally { globalThis.fetch = previousFetch; }
});

for (const config of [
  { chain: 'bitcoin', origin: 'https://open-api.unisat.io', primary: 'UNISAT_BITCOIN_API', fallback: 'UNISAT_BITCOIN_API_FALLBACK', address: 'bc1qtestaddress0000000000000000000000000' },
  { chain: 'fractal', origin: 'https://open-api-fractal.unisat.io', primary: 'UNISAT_API_KEY', fallback: 'UNISAT_API_KEY_FALLBACK', address: 'bc1qtestaddress0000000000000000000000000' },
]) {
  test(`falls back to the same-network UniSat key after quota exhaustion on ${config.chain}`, async () => {
    const previousFetch = globalThis.fetch;
    const authorizations = [];
    globalThis.fetch = async (input, init = {}) => {
      assert.equal(new URL(String(input)).origin, config.origin);
      const authorization = new Headers(init.headers).get('Authorization');
      authorizations.push(authorization);
      if (authorization === 'Bearer primary-test-only') {
        return Response.json({ code: -2005, msg: 'request limit exceeded' }, { status: 403 });
      }
      assert.equal(authorization, 'Bearer fallback-test-only');
      return Response.json({ code: 0, data: { total: 0, utxo: [] } });
    };
    try {
      const env = {
        [config.primary]: 'primary-test-only',
        [config.fallback]: 'fallback-test-only',
      };
      const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=${config.chain}&address=${config.address}&cursor=0&size=25`, { ip: config.chain === 'bitcoin' ? '192.0.2.214' : '192.0.2.213' }), env);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.chain, config.chain);
      assert.deepEqual(authorizations, ['Bearer primary-test-only', 'Bearer fallback-test-only']);
      assert.equal(JSON.stringify(data).includes('test-only'), false);
    } finally { globalThis.fetch = previousFetch; }
  });
}

test('retries Fractal inscription orders with the same-network fallback key after a non-quota 403', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const auth = new Headers(init.headers).get('Authorization');
    if (url.pathname.endsWith('/v1/indexer/fees/recommended')) return Response.json({ code: 0, data: { halfHourFee: 6 } });
    if (url.origin === 'https://mempool.fractalbitcoin.io') return Response.json({ halfHourFee: 5 });
    if (!url.pathname.startsWith('/v5/inscribe/')) throw new Error(`Unexpected upstream URL: ${url}`);
    calls.push({ path: url.pathname, auth });
    if (auth === 'Bearer fractal-primary-test-only') {
      return Response.json({ code: 1001, msg: 'key access denied' }, { status: 403 });
    }
    assert.equal(auth, 'Bearer fractal-fallback-test-only');
    if (url.pathname === '/v5/inscribe/order/estimate-fee') return Response.json({ code: 0, data: { payableAmount: 25000 } });
    if (url.pathname === '/v5/inscribe/order/create') return Response.json({ code: 0, data: { orderId: 'fallback-order-test', status: 'pending', payAddress: 'bc1qtestaddress0000000000000000000000000', amount: 25000 } });
    throw new Error(`Unexpected V5 inscription route: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest('/api/inscribe/order', {
      method: 'POST',
      ip: '192.0.2.198',
      body: JSON.stringify({
        chain: 'FRACTAL_BITCOIN_MAINNET',
        protocol: { type: 'brc20', operation: 'deploy', ticker: 'test', max: '21000000', limit: '1000', decimals: 18 },
        receiver: 'bc1qtestaddress0000000000000000000000000',
        refundAddress: 'bc1qtestaddress0000000000000000000000000',
        userAddress: 'bc1qtestaddress0000000000000000000000000',
        userPubkey: '02' + 'a'.repeat(64),
        feeRate: 5,
        outputValue: 546,
      }),
    }), {
      UNISAT_API_KEY: 'fractal-primary-test-only',
      UNISAT_API_KEY_FALLBACK: 'fractal-fallback-test-only',
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.orderId, 'fallback-order-test');
    assert.deepEqual(calls.map(call => call.auth), [
      'Bearer fractal-primary-test-only', 'Bearer fractal-fallback-test-only',
      'Bearer fractal-primary-test-only', 'Bearer fractal-fallback-test-only',
    ]);
    assert.equal(JSON.stringify(data).includes('test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('identifies UniSat quota exhaustion returned as HTTP 403 code -2005', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(new URL(String(input)).origin, 'https://open-api.unisat.io');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer bitcoin-test-only');
    return Response.json({ code: -2005, msg: 'request limit exceeded' }, { status: 403 });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=bitcoin&address=${address}&cursor=0&size=25`, { ip: '192.0.2.236' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.code, 'UTXO_LIST_UNISAT_RATE_LIMITED');
    assert.match(data.error, /quota\/rate limit reached/i);
    assert.equal(JSON.stringify(data).includes(address), false);
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('uses the Bitcoin UniSat secret for Bitcoin UTXOs without sending the Fractal key', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qtestaddress0000000000000000000000000';
  const upstreamAuthorization = [];
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(new URL(String(input)).origin, 'https://open-api.unisat.io');
    upstreamAuthorization.push(new Headers(init.headers).get('Authorization'));
    return new Response('upstream unavailable', { status: 429 });
  };
  try {
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=bitcoin&address=${address}&cursor=0&size=25`, { ip: '192.0.2.235' }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.code, 'UTXO_LIST_UNISAT_HTTP_429');
    assert.equal(JSON.stringify(data).includes(address), false);
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
    assert.equal(JSON.stringify(data).includes('bitcoin-test-only'), false);
    assert.deepEqual(upstreamAuthorization, ['Bearer bitcoin-test-only']);
  } finally { globalThis.fetch = previousFetch; }
});

test('fails closed before Bitcoin UniSat access when the Bitcoin secret is missing', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error('Unexpected upstream call'); };
  try {
    const address = 'bc1qtestaddress0000000000000000000000000';
    const response = await worker.fetch(makeRequest(`/api/spendable-utxos?chain=bitcoin&address=${address}&cursor=0&size=25`, { ip: '192.0.2.243' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.code, 'UTXO_LIST_UNISAT_BITCOIN_API_KEY_MISSING');
    assert.equal(JSON.stringify(data).includes('fractal-test-only'), false);
    assert.equal(upstreamCalls, 0);
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

test('cancels an unpaid V5 order through cancel2 on the selected network', async () => {
  const previousFetch = globalThis.fetch;
  let cancelUrl = '';
  let cancelAuth = '';
  let cancelBody = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v5/inscribe/cancel2')) {
      cancelUrl = url;
      cancelAuth = new Headers(init.headers).get('Authorization') || '';
      cancelBody = JSON.parse(init.body);
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
  try {
    const response = await worker.fetch(makeRequest('/api/inscribe/order/cancel', {
      method: 'POST',
      ip: '192.0.2.250',
      body: JSON.stringify({ orderId: 'order-cancel-123', chain: 'BITCOIN_MAINNET' }),
    }), { UNISAT_API_KEY: 'fractal-test-only', UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cancelled: true, orderId: 'order-cancel-123', network: 'BITCOIN_MAINNET' });
    assert.equal(cancelUrl, 'https://open-api.unisat.io/v5/inscribe/cancel2');
    assert.equal(cancelAuth, 'Bearer bitcoin-test-only');
    assert.deepEqual(cancelBody, { orderId: 'order-cancel-123' });
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
    if (url === 'https://open-api-fractal.unisat.io/v5/inscribe/order/estimate-fee') return Response.json({ code: 0, data: { payableAmount: 12345 } });
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
            state.challenge = { idHash: body.idHash, site: body.site, address: body.address, addressHash: body.addressHash, network: body.network, contextHash: body.contextHash || '', origin: body.origin, issuedAt: body.issuedAt, expiresAt: body.expiresAt, usedAt: null };
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
            if (!state.challenge || state.challenge.idHash !== body.idHash || state.challenge.usedAt || state.challenge.expiresAt <= body.now || state.challenge.site !== body.site || state.challenge.address !== body.address || state.challenge.network !== body.network || (state.challenge.contextHash || '') !== (body.contextHash || '')) return Response.json({ created: false }, { status: 409 });
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

test('sign-in challenges support Bitcoin and Fractal for both sites and stay bound to the requested network', async () => {
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  for (const site of ['punks', 'pokedex']) {
    for (const network of ['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET']) {
      const { binding, state } = createAuthStorageMock();
      const response = await worker.fetch(makeRequest('/api/auth/challenge', {
        method: 'POST',
        ip: `192.0.2.${site === 'punks' ? '230' : '231'}`,
        body: JSON.stringify({ site, address, network }),
      }), { AUTH_STORAGE: binding });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.site, site);
      assert.equal(result.network, network);
      assert.match(result.message, new RegExp(`Network: ${network}`));
      assert.match(result.message, new RegExp(`URI: https://demro-labs\\.github\\.io/${site === 'punks' ? 'ordinal-punks-collection' : 'fractal-pokedex-ordinal-ledger'}/`));
      assert.match(result.message, /No payment, transfer, or spending approval is authorized\./);
      assert.equal(state.challenge.network, network);
      assert.equal(state.session, null);
    }
  }
});

test('valid BIP-322/BIP-137 sign-in creates sessions for Legacy, Nested, and Native addresses on both sites and networks', async () => {
  const testOnlyPrivateKey = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k';
  const legacyAddress = '14vV3aCHBeStb5bkenkNHbe2YAFinYdXgc';
  const addresses = [
    { address: legacyAddress, compactEcdsa: true },
    { address: '37qyp7jQAzqb2rCBpMvVtLDuuzKAUCVnJb', compactEcdsa: true },
    { address: 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l', compactEcdsa: false },
  ];
  let ip = 100;
  for (const site of ['punks', 'pokedex']) {
    for (const network of ['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET']) {
      for (const { address, compactEcdsa } of addresses) {
        const { binding, state } = createAuthStorageMock();
        const challengeResponse = await worker.fetch(makeRequest('/api/auth/challenge', {
          method: 'POST', ip: `192.0.2.${ip++}`,
          body: JSON.stringify({ site, address, network }),
        }), { AUTH_STORAGE: binding });
        const challenge = await challengeResponse.json();
        const signed = await Signer.signAsync(testOnlyPrivateKey, compactEcdsa ? legacyAddress : address, challenge.message);
        const signature = Buffer.isBuffer(signed) ? signed.toString('base64') : signed;
        const verifyResponse = await worker.fetch(makeRequest('/api/auth/verify', {
          method: 'POST', ip: `192.0.2.${ip++}`,
          body: JSON.stringify({ site, address, network, challengeId: challenge.challengeId, signature }),
        }), { AUTH_STORAGE: binding });
        const result = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200, `${site}/${network}/${address}: ${JSON.stringify(result)}`);
        assert.equal(result.session.site, site);
        assert.equal(result.session.address, address);
        assert.equal(result.session.network, network);
        assert.equal(state.session.network, network);
        assert.match(verifyResponse.headers.get('set-cookie') || '', new RegExp(site === 'punks' ? '__Host-demro-punks-auth' : '__Host-demro-pokedex-auth'));
      }
    }
  }
});

test('sign-in verification rejects a challenge submitted under a different Bitcoin network', async () => {
  const { binding, state } = createAuthStorageMock();
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const challengeResponse = await worker.fetch(makeRequest('/api/auth/challenge', {
    method: 'POST', ip: '192.0.2.232',
    body: JSON.stringify({ site: 'punks', address, network: 'BITCOIN_MAINNET' }),
  }), { AUTH_STORAGE: binding });
  const challenge = await challengeResponse.json();
  const response = await worker.fetch(makeRequest('/api/auth/verify', {
    method: 'POST', ip: '198.51.100.251',
    body: JSON.stringify({ site: 'punks', challengeId: challenge.challengeId, address, network: 'FRACTAL_BITCOIN_MAINNET', signature: 'ZmFrZV9zaWduYXR1cmU=' }),
  }), { AUTH_STORAGE: binding });
  const result = await response.json();
  assert.equal(response.status, 401);
  assert.equal(result.code, 'AUTH_INVALID_CHALLENGE');
  assert.equal(state.challenge.usedAt, null);
  assert.equal(state.session, null);
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
    assert.match(result.message, /A separate transaction review and signature is required/i);
    assert.equal(state.challenge.network, network);
    assert.equal(state.session, null);
  }
});

test('ownership proof is cryptographically bound to the transaction context hash', async () => {
  const { binding, state } = createAuthStorageMock();
  const address = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
  const network = 'BITCOIN_MAINNET';
  const contextHash = 'a'.repeat(64);
  const challengeResponse = await worker.fetch(makeRequest('/api/auth/ownership/challenge', {
    method: 'POST',
    ip: '192.0.2.245',
    body: JSON.stringify({ site: 'punks', address, network, contextHash }),
  }), { AUTH_STORAGE: binding });
  const challenge = await challengeResponse.json();
  assert.equal(challengeResponse.status, 200);
  assert.equal(challenge.contextHash, contextHash);
  assert.match(challenge.message, new RegExp('Transaction Context SHA-256: ' + contextHash));
  assert.equal(state.challenge.contextHash, contextHash);

  const testOnlyPrivateKey = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k';
  const signed = await Signer.signAsync(testOnlyPrivateKey, address, challenge.message);
  const signature = Buffer.isBuffer(signed) ? signed.toString('base64') : signed;
  const mismatch = await worker.fetch(makeRequest('/api/auth/ownership/verify', {
    method: 'POST',
    ip: '192.0.2.246',
    body: JSON.stringify({ site: 'punks', challengeId: challenge.challengeId, address, network, contextHash: 'b'.repeat(64), signature }),
  }), { AUTH_STORAGE: binding });
  assert.equal(mismatch.status, 401);
  assert.equal((await mismatch.json()).code, 'AUTH_INVALID_CHALLENGE');
  assert.equal(state.challenge.usedAt, null);
  assert.equal(state.session, null);

  const verified = await worker.fetch(makeRequest('/api/auth/ownership/verify', {
    method: 'POST',
    ip: '192.0.2.247',
    body: JSON.stringify({ site: 'punks', challengeId: challenge.challengeId, address, network, contextHash, signature }),
  }), { AUTH_STORAGE: binding });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).contextHash, contextHash);
  assert.notEqual(state.challenge.usedAt, null);
  assert.equal(state.session, null);
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


test('routes paginated live transaction history through the matching Bitcoin and Fractal UniSat keys', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const txid = 'a'.repeat(64);
  const sources = [
    { chain: 'BITCOIN_MAINNET', base: 'https://open-api.unisat.io', key: 'bitcoin-history-test-only', ip: '192.0.2.10' },
    { chain: 'FRACTAL_BITCOIN_MAINNET', base: 'https://open-api-fractal.unisat.io', key: 'fractal-history-test-only', ip: '192.0.2.10' },
  ];
  const auth = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const source = sources.find(item => item.base === url.origin);
    assert.ok(source, `Unexpected history source: ${url.origin}`);
    assert.equal(url.pathname, `/v1/indexer/address/${address}/history`);
    assert.equal(url.searchParams.get('cursor'), '0');
    assert.equal(url.searchParams.get('size'), '10');
    auth.push(new Headers(init.headers).get('Authorization'));
    return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ txid, nIn: 1, nOut: 2, inSatoshi: 1500, outSatoshi: 1200, size: 225, height: 900000, idx: 3, blkid: 'b'.repeat(64), confirmations: 4, timestamp: 1700000000 }] } });
  };
  try {
    for (const source of sources) {
      const response = await worker.fetch(makeRequest(`/api/transactions/history?address=${address}&chain=${source.chain}&cursor=0&size=10`, { ip: source.ip }), {
        UNISAT_API_KEY: 'fractal-history-test-only', UNISAT_BITCOIN_API: 'bitcoin-history-test-only',
      });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(data.network, source.chain);
      assert.equal(data.address, address);
      assert.equal(data.total, 1);
      assert.equal(data.detail[0].txid, txid);
      assert.equal(data.detail[0].inSatoshi, 1500);
      assert.equal(data.detail[0].confirmations, 4);
      assert.equal(JSON.stringify(data).includes('test-only'), false);
    }
    assert.deepEqual(auth, ['Bearer bitcoin-history-test-only', 'Bearer fractal-history-test-only']);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects invalid live transaction history queries and malformed UniSat rows', async () => {
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ code: 0, data: { start: 0, total: 1, detail: [{ txid: 'invalid' }] } });
  };
  try {
    const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const badChain = await worker.fetch(makeRequest(`/api/transactions/history?address=${address}&chain=BITCOIN_TESTNET`), { UNISAT_BITCOIN_API: 'test-only' });
    const badCursor = await worker.fetch(makeRequest(`/api/transactions/history?address=${address}&chain=BITCOIN_MAINNET&cursor=-1`), { UNISAT_BITCOIN_API: 'test-only' });
    assert.equal(badChain.status, 400);
    assert.equal(badCursor.status, 400);
    assert.equal(upstreamCalls, 0);

    const malformed = await worker.fetch(makeRequest(`/api/transactions/history?address=${address}&chain=BITCOIN_MAINNET`), { UNISAT_BITCOIN_API: 'test-only' });
    assert.equal(malformed.status, 503);
    assert.match((await malformed.json()).error, /historique.*indisponible/i);
    assert.equal(upstreamCalls, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('normalizes the documented UniSat inscription-data response for Bitcoin and Fractal local Ordinal transfers', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const txid = 'a'.repeat(64);
  const inscriptionId = `${txid}i0`;
  const sources = [
    { chain: 'BITCOIN_MAINNET', base: 'https://open-api.unisat.io', key: 'bitcoin-test-only', ip: '192.0.2.246' },
    { chain: 'FRACTAL_BITCOIN_MAINNET', base: 'https://open-api-fractal.unisat.io', key: 'fractal-test-only', ip: '192.0.2.247' },
  ];
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const source = sources.find(item => item.base === url.origin);
    assert.ok(source, `Unexpected UniSat host: ${url.origin}`);
    requests.push({ url: url.pathname + url.search, authorization: new Headers(init.headers).get('Authorization') || '' });
    return Response.json({ code: 0, data: {
      cursor: Number(url.searchParams.get('cursor')),
      total: 1,
      inscription: [{
        inscriptionId, inscriptionNumber: 42, address, offset: 17, contentType: 'text/plain',
        utxo: { txid, vout: 2, satoshi: 546, address },
      }],
    } });
  };
  try {
    for (const source of sources) {
      const response = await worker.fetch(makeRequest(`/api/ordinals/address-list?address=${address}&chain=${source.chain}&start=0&limit=50`, { ip: source.ip }), {
        UNISAT_API_KEY: 'fractal-test-only',
        UNISAT_BITCOIN_API: 'bitcoin-test-only',
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.network, source.chain);
      assert.equal(data.address, address);
      assert.equal(data.total, 1);
      assert.deepEqual(data.detail[0], {
        inscriptionId, inscriptionNumber: 42, location: `${txid}:2:17`,
        outputValue: 546, contentType: 'text/plain',
      });
    }
    assert.deepEqual(requests, [
      { url: `/v1/indexer/address/${address}/inscription-data?cursor=0&size=50`, authorization: 'Bearer bitcoin-test-only' },
      { url: `/v1/indexer/address/${address}/inscription-data?cursor=0&size=50`, authorization: 'Bearer fractal-test-only' },
    ]);
  } finally { globalThis.fetch = previousFetch; }
});

test('lists active address UTXOs separately for Bitcoin and Fractal without treating the list as spend authorization', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(url), auth: new Headers(init.headers).get('Authorization') });
    assert.match(url.pathname, /\/v1\/indexer\/address\/.*\/all-utxo-data$/);
    return Response.json({ code: 0, data: { cursor: Number(url.searchParams.get('cursor')), total: 2, utxo: [
      { txid: '11'.repeat(32), vout: 0, satoshi: '1200', height: 100, scriptPk: '0014' + '22'.repeat(20), inscriptions: [], runes: [], alkanes: [], isSpent: false },
      { txid: '33'.repeat(32), vout: 1, satoshi: '546', height: 101, scriptPk: '0014' + '44'.repeat(20), inscriptions: ['inscription-test'], runes: [{ id: '1:1' }], alkanes: [], isSpent: false },
    ] } });
  };
  try {
    const btc = await worker.fetch(makeRequest(`/api/address-utxos?chain=bitcoin&address=${address}&cursor=0&size=25`, { ip: '192.0.2.244' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    const btcData = await btc.json();
    assert.equal(btc.status, 200, JSON.stringify(btcData));
    assert.equal(btcData.total, 2);
    assert.equal(btcData.utxo.length, 2);
    assert.equal(btcData.utxo[0].satoshi, 1200);
    assert.deepEqual(btcData.utxo[1].inscriptions, ['inscription-test']);
    assert.equal(calls[0].auth, 'Bearer bitcoin-test-only');

    const fb = await worker.fetch(makeRequest(`/api/address-utxos?chain=fractal&address=${address}&cursor=0&size=25`, { ip: '192.0.2.245' }), { UNISAT_API_KEY: 'fractal-test-only' });
    const fbData = await fb.json();
    assert.equal(fb.status, 200, JSON.stringify(fbData));
    assert.equal(fbData.chain, 'fractal');
    assert.equal(calls[1].auth, 'Bearer fractal-test-only');
    assert.equal(new URL(calls[0].url).hostname, 'open-api.unisat.io');
    assert.equal(new URL(calls[1].url).hostname, 'open-api-fractal.unisat.io');
  } finally { globalThis.fetch = previousFetch; }
});

test('Alkanes balance route defaults to Bitcoin and rejects unsupported Fractal before UniSat', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.hostname, 'open-api.unisat.io');
    assert.match(url.pathname, /\/alkanes\/token-list$/);
    return Response.json({ code: 0, data: { detail: [] } });
  };
  try {
    const bitcoin = await worker.fetch(makeRequest(`/api/alkanes/balances?address=${address}`, { ip: '192.0.2.246' }), { UNISAT_BITCOIN_API: 'bitcoin-test-only' });
    assert.equal(bitcoin.status, 200);
    assert.equal((await bitcoin.json()).network, 'BITCOIN_MAINNET');
    assert.equal(calls.length, 1);

    const fractal = await worker.fetch(makeRequest(`/api/alkanes/balances?address=${address}&chain=FRACTAL_BITCOIN_MAINNET`, { ip: '192.0.2.247' }), { UNISAT_API_KEY: 'fractal-test-only' });
    assert.equal(fractal.status, 400);
    const unsupported = await fractal.json();
    assert.match(unsupported.error, /only on Bitcoin mainnet/i);
    assert.equal(unsupported.code, 'ALKANES_CHAIN_UNSUPPORTED');
    assert.equal(calls.length, 1, 'unsupported Fractal route must not call UniSat');
  } finally { globalThis.fetch = previousFetch; }
});

test('returns validated total/available UTXO summaries for Bitcoin and Fractal without exposing API keys', async () => {
  const previousFetch = globalThis.fetch;
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), auth: new Headers(init.headers).get('Authorization') });
    return Response.json({ code: 0, data: {
      totalBalance: 9000, totalUtxoCount: 4,
      availableBalance: 3000, availableUtxoCount: 2,
      unavailableBalance: 6000, unavailableUtxoCount: 2,
    } });
  };
  try {
    for (const [chain, host, key] of [
      ['bitcoin', 'https://open-api.unisat.io', 'bitcoin-summary-test-key'],
      ['fractal', 'https://open-api-fractal.unisat.io', 'fractal-summary-test-key'],
    ]) {
      const response = await worker.fetch(makeRequest(`/api/utxo-balance-summary?chain=${chain}&address=${address}`, { ip: chain === 'bitcoin' ? '192.0.2.231' : '192.0.2.232' }), {
        UNISAT_API_KEY: 'fractal-summary-test-key',
        UNISAT_BITCOIN_API: 'bitcoin-summary-test-key',
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.chain, chain);
      assert.equal(data.totalUtxoCount, 4);
      assert.equal(data.availableUtxoCount, 2);
      assert.equal(data.unavailableUtxoCount, 2);
      assert.equal(JSON.stringify(data).includes(key), false);
      assert.equal(calls.at(-1).url, `${host}/v1/indexer/address/${address}/available-balance?withLowFee=true`);
      assert.equal(calls.at(-1).auth, `Bearer ${key}`);
    }
  } finally { globalThis.fetch = previousFetch; }
});

