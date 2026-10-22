import './buffer-polyfill.js';
import { handleWalletAuth } from './auth-bip322.js';
export { AuthStorage } from './auth-bip322.js';

const API_BASE = 'https://open-api-fractal.unisat.io';
const BITCOIN_API_BASE = 'https://open-api.unisat.io';
const ALLOWED_ORIGINS = new Set([
  'https://ordi-labs.github.io',
  'https://punksgallery-mlwdpcwl.manus.space',
  'https://punks-elp.pages.dev',
  'https://pokemon-4nv.pages.dev',
]);

// Browser extensions have a distinct, browser-assigned origin. Accept only canonical
// Chrome/Edge extension IDs and Firefox UUID origins so Local Vault can call the
// protected transaction APIs without opening those routes to arbitrary web origins.
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname) return false;
    if (parsed.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(parsed.hostname)) return true;
    if (parsed.protocol === 'moz-extension:' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}
const ALLOWED_COLLECTION_IDS = new Set(['opunk', 'pokedex']);
const SATS = 100000000;
const MAX_MARKET_OFFSET = 10000;
const MAX_PAGE_SIZE = 20;
const MAX_RUNES_OFFSET = 10000;
const MAX_RUNES_PAGE_SIZE = 25;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_REQUESTS = 180;
const rateBuckets = new Map();
const INSCRIBE_RATE_WINDOW_MS = 60_000;
const INSCRIBE_RATE_LIMIT = 5;
const inscribeBuckets = new Map();
const MAX_INSCRIBE_FILES = 1000;
const MAX_INSCRIBE_FILE_BYTES = 365 * 1024;
const MAX_INSCRIBE_BODY_BYTES = 95_000_000;
const MAX_UTXO_CONFIRM_BODY_BYTES = 20_000;
const MAX_UTXO_CONFIRM_INPUTS = 20;
const MAX_UTXO_CONFIRM_LEGACY_SCAN_PAGES = 20;
const MAX_UTXO_CONFIRM_CURSOR = 1_000_000;
const UTXO_CONFIRM_PAGE_SIZE = 25;
const MAX_BRC20_PROG_ACTIVATION_BODY_BYTES = 100_000;
const MAX_BRC20_PROG_ACTIVATION_INPUTS = 20;
const MAX_BRC20_PROG_BALANCE_BODY_BYTES = 2_048;
const BRC20_PROG_ACTIVATION_SCRIPT_HEX = '6a09425243323050524f47';
const BRC20_PROG_CONTROLLER_ADDRESS = '0xc54dd4581af2dbf18e4d90840226756e9d2b3cdb';
const BRC20_PROG_BALANCE_OF_SELECTOR = 'fc124ebd';
const BRC20_PROG_RPC_ENV_BY_CHAIN = {
  BITCOIN_MAINNET: 'BRC20_PROG_RPC_URL',
  FRACTAL_BITCOIN_MAINNET: 'BRC20_PROG_FRACTAL_RPC_URL',
};
const brc20ProgActivationBuckets = new Map();

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

function cors(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    ...SECURITY_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

// Best-effort per-isolate throttle; use Cloudflare account-level rate rules for a durable global limit.
function isRateLimited(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.expiresAt <= now) {
    if (rateBuckets.size >= 10000) {
      let scanned = 0;
      for (const [key, value] of rateBuckets) {
        if (value.expiresAt <= now) rateBuckets.delete(key);
        scanned += 1;
        if (scanned >= 256) break;
      }
      if (rateBuckets.size >= 10000) return true;
    }
    bucket = { count: 0, expiresAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  if (bucket.count >= RATE_MAX_REQUESTS) return true;
  bucket.count += 1;
  return false;
}

function abiWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function brc20ProgRpcEnvName(chain) {
  return BRC20_PROG_RPC_ENV_BY_CHAIN[chain] || null;
}
function brc20ProgRpcUrl(env, chain) {
  const preferred = brc20ProgRpcEnvName(chain);
  // ETHEREUM_API is accepted as an RPC endpoint alias only when configured with
  // the full HTTPS JSON-RPC URL, not as a bare provider API token.
  const value = preferred === 'BRC20_PROG_RPC_URL'
    ? env.BRC20_PROG_RPC_URL
    : env.BRC20_PROG_FRACTAL_RPC_URL || env.ETHEREUM_API || env.ETH_API || env.BRC20_PROG_RPC_URL;
  if (!value) throw new Error('BRC2.0 RPC is not configured for this network');
  const rpcUrl = new URL(value);
  if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password) throw new Error('Invalid BRC2.0 RPC URL');
  return rpcUrl;
}
function brc20ProgRpcHeaders(env, chain) {
  const headers = new Headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' });
  const user = env.BRC20_PROG_RPC_USER;
  const password = env.BRC20_PROG_RPC_PASSWORD;
  if (user || password) {
    if (!user || !password) throw new Error('Incomplete BRC2.0 RPC credentials');
    headers.set('Authorization', 'Basic ' + btoa(`${user}:${password}`));
  }
  return headers;
}
function encodeBrc20ProgBalanceOf(ticker, evmAddress) {
  const tickerHex = Array.from(new TextEncoder().encode(ticker), byte => byte.toString(16).padStart(2, '0')).join('');
  const paddedTickerHex = tickerHex.padEnd(Math.ceil(tickerHex.length / 64) * 64, '0');
  return `0x${BRC20_PROG_BALANCE_OF_SELECTOR}${abiWord(64)}${evmAddress.slice(2).toLowerCase().padStart(64, '0')}${abiWord(ticker.length)}${paddedTickerHex}`;
}

function isInscribeRateLimited(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let bucket = inscribeBuckets.get(ip);
  if (!bucket || bucket.expiresAt <= now) {
    if (inscribeBuckets.size >= 10000) {
      for (const [key, value] of inscribeBuckets) if (value.expiresAt <= now) inscribeBuckets.delete(key);
      if (inscribeBuckets.size >= 10000) return true;
    }
    bucket = { count: 0, expiresAt: now + INSCRIBE_RATE_WINDOW_MS };
    inscribeBuckets.set(ip, bucket);
  }
  if (bucket.count >= INSCRIBE_RATE_LIMIT) return true;
  bucket.count += 1;
  return false;
}

function normalizeSatoshiValue(item) {
  // UniSat normally returns "satoshi"; some compatible indexer responses expose
  // the same integer as "value". Accept only exact integer sats, never BTC decimals.
  const raw = item?.satoshi !== undefined && item?.satoshi !== null ? item.satoshi : item?.value;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

function parseBoundedInteger(raw, fallback, maximum) {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function isBrc20ProgActivationRateLimited(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let bucket = brc20ProgActivationBuckets.get(ip);
  if (!bucket || bucket.expiresAt <= now) {
    if (brc20ProgActivationBuckets.size >= 10000) {
      for (const [key, value] of brc20ProgActivationBuckets) if (value.expiresAt <= now) brc20ProgActivationBuckets.delete(key);
      if (brc20ProgActivationBuckets.size >= 10000) return true;
    }
    bucket = { count: 0, expiresAt: now + INSCRIBE_RATE_WINDOW_MS };
    brc20ProgActivationBuckets.set(ip, bucket);
  }
  if (bucket.count >= INSCRIBE_RATE_LIMIT) return true;
  bucket.count += 1;
  return false;
}

function activationVarInt(bytes, cursor) {
  const prefix = bytes[cursor.offset++];
  if (prefix === undefined) throw new Error('Truncated transaction');
  if (prefix < 0xfd) return { value: prefix, raw: bytes.slice(cursor.offset - 1, cursor.offset) };
  const width = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8;
  if (cursor.offset + width > bytes.length) throw new Error('Truncated transaction');
  let value = 0n;
  for (let index = 0; index < width; index += 1) value |= BigInt(bytes[cursor.offset + index]) << BigInt(index * 8);
  cursor.offset += width;
  const minimum = width === 2 ? 0xfdn : width === 4 ? 0x10000n : 0x100000000n;
  if (value < minimum || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Non-canonical or oversized transaction varint');
  return { value: Number(value), raw: bytes.slice(cursor.offset - width - 1, cursor.offset) };
}

async function verifyBrc20ProgActivationTransaction(txHex, inscriptionOutpoint) {
  if (typeof txHex !== 'string' || txHex.length < 20 || txHex.length > MAX_BRC20_PROG_ACTIVATION_BODY_BYTES * 2 || !/^(?:[a-f0-9]{2})+$/i.test(txHex)) throw new Error('Invalid transaction hex');
  const outpointMatch = typeof inscriptionOutpoint === 'string' ? inscriptionOutpoint.match(/^([a-f0-9]{64}):(\d+)$/i) : null;
  if (!outpointMatch) throw new Error('Invalid inscription outpoint');
  const expectedTxid = outpointMatch[1].toLowerCase();
  const expectedVout = Number(outpointMatch[2]);
  if (!Number.isSafeInteger(expectedVout) || expectedVout < 0 || expectedVout > 0xffffffff) throw new Error('Invalid inscription outpoint');

  const bytes = Uint8Array.from({ length: txHex.length / 2 }, (_, index) => Number.parseInt(txHex.slice(index * 2, index * 2 + 2), 16));
  const cursor = { offset: 0 };
  const take = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || cursor.offset + length > bytes.length) throw new Error('Truncated transaction');
    const value = bytes.slice(cursor.offset, cursor.offset + length);
    cursor.offset += length;
    return value;
  };
  const readUint32 = () => {
    const value = take(4);
    return (value[0] | (value[1] << 8) | (value[2] << 16) | (value[3] << 24)) >>> 0;
  };
  const version = take(4);
  const isSegwit = bytes[cursor.offset] === 0 && bytes[cursor.offset + 1] !== 0;
  if (isSegwit && take(2)[1] !== 1) throw new Error('Unsupported transaction witness flag');
  const inputCountStart = cursor.offset;
  const inputCountResult = activationVarInt(bytes, cursor);
  const inputCount = inputCountResult.value;
  if (inputCount < 1 || inputCount > MAX_BRC20_PROG_ACTIVATION_INPUTS) throw new Error('Invalid activation input count');
  const inputBytes = [];
  let inscriptionInputCount = 0;
  for (let index = 0; index < inputCount; index += 1) {
    const start = cursor.offset;
    const previousHash = take(32);
    const previousTxid = Array.from(previousHash).reverse().map(byte => byte.toString(16).padStart(2, '0')).join('');
    const previousVout = readUint32();
    const scriptLength = activationVarInt(bytes, cursor).value;
    take(scriptLength);
    take(4);
    if (previousTxid === expectedTxid && previousVout === expectedVout) inscriptionInputCount += 1;
    inputBytes.push(bytes.slice(start, cursor.offset));
  }
  const inputCountBytes = bytes.slice(inputCountStart, inputCountStart + inputCountResult.raw.length);
  const outputCountStart = cursor.offset;
  const outputCount = activationVarInt(bytes, cursor);
  if (outputCount.value < 1 || outputCount.value > 1000) throw new Error('Invalid activation output count');
  const outputCountBytes = bytes.slice(outputCountStart, cursor.offset);
  const outputBytes = [];
  let activationMarkerCount = 0;
  let activationMarkerOutputIndex = -1;
  let changeOutputValue = 0n;
  let changeScriptFirstByte = -1;
  for (let index = 0; index < outputCount.value; index += 1) {
    const start = cursor.offset;
    const valueBytes = take(8);
    let valueSats = 0n;
    for (let byteIndex = 0; byteIndex < valueBytes.length; byteIndex += 1) valueSats |= BigInt(valueBytes[byteIndex]) << BigInt(byteIndex * 8);
    if (valueSats > 2_100_000_000_000_000n) throw new Error('Invalid output value');
    const scriptLength = activationVarInt(bytes, cursor).value;
    const script = take(scriptLength);
    if (Array.from(script, byte => byte.toString(16).padStart(2, '0')).join('') === BRC20_PROG_ACTIVATION_SCRIPT_HEX) {
      activationMarkerCount += 1;
      activationMarkerOutputIndex = index;
      if (valueSats !== 0n) throw new Error('BRC2.0 activation output must have zero value');
    }
    if (index === 1) { changeOutputValue = valueSats; changeScriptFirstByte = script[0] ?? -1; }
    outputBytes.push(bytes.slice(start, cursor.offset));
  }
  if (isSegwit) {
    for (let index = 0; index < inputCount; index += 1) {
      const witnessItems = activationVarInt(bytes, cursor).value;
      if (witnessItems > 1000) throw new Error('Oversized transaction witness');
      for (let item = 0; item < witnessItems; item += 1) take(activationVarInt(bytes, cursor).value);
    }
  }
  const locktime = take(4);
  if (cursor.offset !== bytes.length || inscriptionInputCount !== 1 || activationMarkerCount !== 1 || outputCount.value !== 2 || activationMarkerOutputIndex !== 0 || changeOutputValue < 600n || changeScriptFirstByte === 0x6a) throw new Error('Transaction is not a valid BRC2.0 activation');

  const stripped = new Uint8Array(version.length + inputCountBytes.length + inputBytes.reduce((size, input) => size + input.length, 0) + outputCountBytes.length + outputBytes.reduce((size, output) => size + output.length, 0) + locktime.length);
  let position = 0;
  for (const part of [version, inputCountBytes, ...inputBytes, outputCountBytes, ...outputBytes, locktime]) { stripped.set(part, position); position += part.length; }
  const firstHash = new Uint8Array(await crypto.subtle.digest('SHA-256', stripped));
  const secondHash = new Uint8Array(await crypto.subtle.digest('SHA-256', firstHash));
  const txid = Array.from(secondHash.reverse(), byte => byte.toString(16).padStart(2, '0')).join('');
  return txid;
}

async function broadcastBrc20ProgActivation(request, corsHeaders) {
  const noStore = { ...corsHeaders, 'Cache-Control': 'no-store' };
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return Response.json({ error: 'Content-Type JSON requis.' }, { status: 415, headers: noStore });
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BRC20_PROG_ACTIVATION_BODY_BYTES) return Response.json({ error: 'La transaction d’activation dépasse la taille maximale autorisée.' }, { status: 413, headers: noStore });
  let bodyText;
  try { bodyText = await request.text(); } catch { return Response.json({ error: 'Corps JSON invalide.' }, { status: 400, headers: noStore }); }
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BRC20_PROG_ACTIVATION_BODY_BYTES) return Response.json({ error: 'La transaction d’activation dépasse la taille maximale autorisée.' }, { status: 413, headers: noStore });
  let body;
  try { body = JSON.parse(bodyText); } catch { return Response.json({ error: 'Corps JSON invalide.' }, { status: 400, headers: noStore }); }
  let expectedTxid;
  try { expectedTxid = await verifyBrc20ProgActivationTransaction(body?.txHex, body?.inscriptionOutpoint); }
  catch { return Response.json({ error: 'La transaction ne correspond pas à une activation BRC2.0 valide.' }, { status: 400, headers: noStore }); }
  try {
    const upstream = await fetch('https://mempool.space/api/tx', {
      method: 'POST', headers: { Accept: 'text/plain', 'Content-Type': 'text/plain' },
      body: body.txHex.toLowerCase(), signal: AbortSignal.timeout(8000),
    });
    const returnedTxid = (await upstream.text()).trim().toLowerCase();
    if (!upstream.ok || returnedTxid !== expectedTxid) throw new Error('Broadcast was not confirmed');
    return Response.json({ network: 'BITCOIN_MAINNET', txid: expectedTxid, status: 'broadcast' }, { headers: noStore });
  } catch {
    return Response.json({ error: 'Mempool n’a pas confirmé la diffusion de l’activation. Vérifiez le TXID dans Mempool avant toute nouvelle tentative.' }, { status: 502, headers: noStore });
  }
}

async function uni(path, env, init = {}) {
  const fractalApiKey = env.FRACTAL_BITCOIN_API || env.UNISAT_API_KEY;
  if (!fractalApiKey) throw new Error('UniSat server binding is missing');
  // Inscription/order routes use this helper rather than uniNetwork. Keep quota
  // fallback consistent, but retry only UniSat's documented quota code (-2005)
  // and only with a separately configured Fractal key. Never retry arbitrary 403s.
  const keys = [fractalApiKey, env.UNISAT_API_KEY_FALLBACK]
    .filter((key, index, values) => typeof key === 'string' && key.length > 0 && values.indexOf(key) === index);
  for (let index = 0; index < keys.length; index += 1) {
    const response = await fetch(API_BASE + path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: 'Bearer ' + keys[index],
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    let payload = null;
    if (!response.ok || index + 1 < keys.length) {
      try { payload = await response.clone().json(); } catch {}
    }
    const upstreamCode = payload && (typeof payload.code === 'number' || typeof payload.code === 'string')
      ? String(payload.code) : null;
    const quotaExceeded = upstreamCode === '-2005';
    if (quotaExceeded && index + 1 < keys.length) {
      console.warn('UniSat API quota exceeded; trying configured Fractal fallback key', {
        path,
        requestId: response.headers.get('x-request-id') || response.headers.get('cf-ray') || null,
      });
      continue;
    }
    if (!response.ok) {
      if (path.startsWith('/v3/market/collection/auction/')) {
        let upstreamBody = '';
        try { upstreamBody = await response.clone().text(); } catch {}
        // Diagnostic only: never log authorization headers; redact long token-like values and bound output.
        console.warn('UniSat market upstream error', {
          path,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          body: upstreamBody.slice(0, 300)
            .replace(/Bearer\\s+\\S+/gi, 'Bearer [redacted]')
            .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]'),
        });
      }
      if (response.status === 403 && quotaExceeded) throw new Error('UniSat API quota exceeded');
      throw new Error('UniSat upstream returned ' + response.status);
    }
    if (payload === null) {
      try { payload = await response.json(); }
      catch { throw new Error('UniSat upstream returned invalid JSON'); }
    }
    if (payload?.code === 0) return payload.data;
    if (String(payload?.code) === '-2005') throw new Error('UniSat API quota exceeded');
    throw new Error('UniSat upstream rejected the request');
  }
  throw new Error('UniSat API quota exceeded');
}

async function uniNetwork(base, path, env, init = {}) {
  const isFractalApi = new URL(base).origin === new URL(API_BASE).origin;
  const isBitcoinApi = new URL(base).origin === new URL(BITCOIN_API_BASE).origin;
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');

  const primaryKey = isFractalApi
    ? (env.FRACTAL_BITCOIN_API || env.UNISAT_API_KEY)
    : isBitcoinApi
      ? (env.BITCOIN_API || env.UNISAT_BITCOIN_API)
      : null;
  const fallbackKey = isFractalApi ? env.UNISAT_API_KEY_FALLBACK : isBitcoinApi ? env.UNISAT_BITCOIN_API_FALLBACK : null;
  const apiKeys = isFractalApi || isBitcoinApi
    ? [primaryKey, fallbackKey].filter((key, index, values) => typeof key === 'string' && key.length > 0 && values.indexOf(key) === index)
    : [null];
  if ((isFractalApi || isBitcoinApi) && apiKeys.length === 0) {
    throw new Error(isFractalApi ? 'UniSat server binding is missing' : 'Bitcoin UniSat server binding is missing');
  }
  if (!isFractalApi && !isBitcoinApi) headers.delete('Authorization');

  const network = isBitcoinApi ? 'bitcoin' : isFractalApi ? 'fractal' : 'other';
  // Cache only successful, read-only indexer lookups at the edge to conserve UniSat quotas.
  // Never cache UTXO/spend-state, fee estimates, transaction data, or inscription-order routes:
  // transaction inputs and signing flows must always use fresh upstream verification.
  const method = (init.method || 'GET').toUpperCase();
  const cacheableRead = method === 'GET' &&
    !['all-utxo-data', 'available-utxo-data', 'available-balance', 'utxo-data', '/utxo/', '/tx/', '/rawtx/', '/fees/', '/v2/inscribe/', '/v3/inscribe/', '/v5/inscribe/'].some((segment) => path.includes(segment));
  const edgeCache = cacheableRead ? globalThis.caches?.default : null;
  const cacheKey = edgeCache ? new Request(base + path, { method: 'GET' }) : null;
  if (edgeCache && cacheKey) {
    try {
      const cached = await edgeCache.match(cacheKey);
      if (cached) {
        const cachedPayload = await cached.json();
        if (String(cachedPayload?.code) === '0' && Object.prototype.hasOwnProperty.call(cachedPayload, 'data')) {
          return cachedPayload.data;
        }
      }
    } catch {
      // Cache is an optimization only; continue with the live provider on any cache failure.
    }
  }

  let payload;
  let response;
  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex += 1) {
    const requestHeaders = new Headers(headers);
    if (apiKeys[keyIndex]) requestHeaders.set('Authorization', 'Bearer ' + apiKeys[keyIndex]);
    let currentResponse;
    try {
      currentResponse = await fetch(base + path, { ...init, headers: requestHeaders });
    } catch (error) {
      console.warn('UniSat network fetch failed', {
        network,
        path,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new Error('UniSat network request failed');
    }

    let upstreamCode = null;
    if (!currentResponse.ok) {
      try {
        const errorPayload = await currentResponse.clone().json();
        if (typeof errorPayload?.code === 'number' || typeof errorPayload?.code === 'string') {
          upstreamCode = String(errorPayload.code).slice(0, 32);
        }
      } catch {}
    }

    if (currentResponse.status === 403 && keyIndex + 1 < apiKeys.length) {
      // UniSat can return 403 for quota exhaustion or key-specific access denial.
      // Retry only with a configured key for this exact same network.
      // Never cross-use Bitcoin and Fractal credentials, or expose either key to clients.
      console.warn('UniSat API returned 403; trying configured same-network fallback key', {
        network,
        path,
        upstreamCode,
        requestId: currentResponse.headers.get('x-request-id') || currentResponse.headers.get('cf-ray') || null,
      });
      continue;
    }

    if (!currentResponse.ok) {
      console.warn('UniSat network upstream HTTP error', {
        network,
        path,
        status: currentResponse.status,
        upstreamCode,
        requestId: currentResponse.headers.get('x-request-id') || currentResponse.headers.get('cf-ray') || null,
      });
      if (currentResponse.status === 403 && upstreamCode === '-2005') {
        throw new Error('UniSat API quota exceeded');
      }
      throw new Error('UniSat upstream returned ' + currentResponse.status);
    }

    try {
      payload = await currentResponse.json();
    } catch {
      console.warn('UniSat network returned invalid JSON', { network, path, status: currentResponse.status });
      throw new Error('UniSat upstream returned invalid JSON');
    }
    const payloadCode = typeof payload?.code === 'number' || typeof payload?.code === 'string' ? String(payload.code) : 'missing';
    if (payloadCode === '-2005' && keyIndex + 1 < apiKeys.length) {
      console.warn('UniSat API quota exceeded; trying configured same-network fallback key', { network, path });
      continue;
    }
    if (String(payload?.code) !== '0') {
      console.warn('UniSat network API rejected request', { network, path, code: payloadCode.slice(0, 32) });
      if (payloadCode === '-2005') throw new Error('UniSat API quota exceeded');
      throw new Error('UniSat upstream rejected the request');
    }
    response = currentResponse;
    break;
  }
  if (!response || !payload || String(payload.code) !== '0') {
    throw new Error('UniSat API quota exceeded');
  }
  if (edgeCache && cacheKey) {
    try {
      await edgeCache.put(cacheKey, new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=180' },
      }));
    } catch {
      // A cache write failure must never turn a successful provider response into a failed request.
    }
  }
  return payload.data;
}

function selectedFeeRate(fees) {
  const value = Number(fees?.halfHourFee ?? fees?.fastestFee ?? fees?.hourFee ?? fees?.economyFee ?? fees?.minimumFee);
  if (!Number.isFinite(value) || value <= 0 || value > 10000) return null;
  return Math.max(1, Math.ceil(value));
}

/** Retry transient Mempool read outages without retrying transaction broadcasts. */
async function fetchMempoolReadWithRetry(url, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (![502, 503, 504].includes(response.status) || attempt === attempts - 1) return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw lastError || new Error('Mempool read request failed.');
}

async function recommendedFeeEstimate(chain, env) {
  const unisatBase = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  const mempoolBase = chain === 'BITCOIN_MAINNET' ? 'https://mempool.space' : 'https://mempool.fractalbitcoin.io';
  const [unisatResult, mempoolResult] = await Promise.allSettled([
    uniNetwork(unisatBase, '/v1/indexer/fees/recommended', env, { signal: AbortSignal.timeout(8000) }),
    fetch(mempoolBase + '/api/v1/fees/recommended', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }).then(async response => {
      if (!response.ok) throw new Error('Mempool returned HTTP ' + response.status);
      return response.json();
    }),
  ]);
  const unisatFeeRate = unisatResult.status === 'fulfilled' ? selectedFeeRate(unisatResult.value) : null;
  const mempoolFeeRate = mempoolResult.status === 'fulfilled' ? selectedFeeRate(mempoolResult.value) : null;
  const availableRates = [unisatFeeRate, mempoolFeeRate].filter(value => value !== null);
  if (!availableRates.length) throw new Error('Both fee estimators are unavailable or returned invalid data.');
  return {
    network: chain,
    target: 'halfHour',
    feeRate: Math.max(...availableRates),
    strategy: availableRates.length === 2 ? 'maximum-of-mempool-and-unisat' : 'single-provider-fallback',
    sources: {
      mempool: { feeRate: mempoolFeeRate, available: mempoolFeeRate !== null },
      unisat: { feeRate: unisatFeeRate, available: unisatFeeRate !== null },
    },
    sampledAt: new Date().toISOString(),
  };
}

function validWalletAddress(value) {
  return typeof value === 'string' && value.length >= 14 && value.length <= 100 && /^[A-Za-z0-9]+$/.test(value);
}

function validRuneId(value) {
  return typeof value === 'string' && value.length <= 42 && /^\d{1,20}:\d{1,20}$/.test(value);
}

function normalizeRuneBalance(value) {
  const amount = typeof value?.amount === 'string' ? value.amount : '';
  const rune = typeof value?.rune === 'string' ? value.rune : '';
  const spacedRune = typeof value?.spacedRune === 'string' ? value.spacedRune : '';
  const divisibility = Number(value?.divisibility);
  if (
    !/^\d{1,80}$/.test(amount) || !validRuneId(value?.runeid) ||
    !rune || rune.length > 128 || !spacedRune || spacedRune.length > 160 ||
    !Number.isSafeInteger(divisibility) || divisibility < 0 || divisibility > 38
  ) return null;
  return {
    amount,
    runeid: value.runeid,
    rune,
    spacedRune,
    symbol: typeof value.symbol === 'string' && value.symbol.length <= 16 ? value.symbol : '',
    divisibility,
  };
}

function normalizeAddressTransaction(value) {
  if (!value || typeof value !== 'object') return null;
  const txid = typeof value.txid === 'string' ? value.txid.toLowerCase() : '';
  const number = key => Number.isSafeInteger(Number(value[key])) ? Number(value[key]) : null;
  const nIn = number('nIn');
  const nOut = number('nOut');
  const inSatoshi = number('inSatoshi');
  const outSatoshi = number('outSatoshi');
  const size = number('size');
  const height = number('height');
  const idx = number('idx');
  const confirmations = number('confirmations');
  const timestamp = number('timestamp');
  const blkid = typeof value.blkid === 'string' && /^[a-f0-9]{64}$/i.test(value.blkid) ? value.blkid.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(txid) || [nIn, nOut, inSatoshi, outSatoshi, size, confirmations, timestamp].some(item => item === null || item < 0) || height === null || height < -1 || idx === null || idx < -1) return null;
  return { txid, nIn, nOut, inSatoshi, outSatoshi, size, height, idx, blkid, confirmations, timestamp };
}

function normalizeBrc20Balance(value) {
  if (!value || typeof value.ticker !== 'string' || !/^[a-z0-9]{4,32}$/i.test(value.ticker)) return null;
  const amounts = ['overallBalance', 'transferableBalance', 'availableBalance'];
  if (amounts.some(key => typeof value[key] !== 'string' || !/^\d+(\.\d+)?$/.test(value[key]))) return null;
  return { ticker: value.ticker, overallBalance: value.overallBalance, transferableBalance: value.transferableBalance, availableBalance: value.availableBalance };
}

function normalizeBrc20ProgBalance(value) {
  if (!value || typeof value.ticker !== 'string' || !/^[a-z0-9-]{6}$/i.test(value.ticker)) return null;
  const amounts = ['overallBalance', 'transferableBalance', 'availableBalance'];
  if (amounts.some(key => typeof value[key] !== 'string' || !/^\d+(\.\d+)?$/.test(value[key]))) return null;
  return { ticker: value.ticker, overallBalance: value.overallBalance, transferableBalance: value.transferableBalance, availableBalance: value.availableBalance };
}

function normalizeAlkaneBalance(value) {
  if (!value || typeof value.alkaneid !== 'string' || value.alkaneid.length > 128 || typeof value.amount !== 'string' || !/^\d+$/.test(value.amount)) return null;
  const tokenData = value.tokenData && typeof value.tokenData === 'object' ? value.tokenData : {};
  const nftData = value.nftData && typeof value.nftData === 'object' ? value.nftData : {};
  const collectionData = value.collectionData && typeof value.collectionData === 'object' ? value.collectionData : {};
  const divisibility = Number(tokenData.divisibility);
  return {
    alkaneid: value.alkaneid,
    amount: value.amount,
    type: typeof value.type === 'string' ? value.type : 'token',
    name: typeof tokenData.name === 'string' ? tokenData.name : typeof nftData.name === 'string' ? nftData.name : typeof collectionData.name === 'string' ? collectionData.name : '',
    symbol: typeof tokenData.symbol === 'string' ? tokenData.symbol : '',
    divisibility: Number.isSafeInteger(divisibility) && divisibility >= 0 && divisibility <= 38 ? divisibility : null,
  };
}


function validAlkaneId(value) { return typeof value === 'string' && /^\d{1,20}:\d{1,20}$/.test(value); }
function validProtocolAmount(value) { return typeof value === 'string' && /^(?:0|[1-9]\d{0,79})(?:\.\d{1,38})?$/.test(value); }
function normalizeBrc20InventoryBalance(value) {
  if (!value || typeof value !== 'object' || typeof value.ticker !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(value.ticker) || !validProtocolAmount(value.overallBalance) || !validProtocolAmount(value.transferableBalance) || !validProtocolAmount(value.availableBalance)) return null;
  return { ticker: value.ticker, overallBalance: value.overallBalance, transferableBalance: value.transferableBalance, availableBalance: value.availableBalance };
}

function normalizeAlkaneInfo(value) {
  if (!value || typeof value !== 'object' || !validAlkaneId(value.alkaneid) || !['token', 'collection'].includes(value.type)) return null;
  const tokenData = value.tokenData && typeof value.tokenData === 'object' ? value.tokenData : null;
  const collectionData = value.collectionData && typeof value.collectionData === 'object' ? value.collectionData : null;
  if (value.type === 'token' && (!tokenData || typeof tokenData.name !== 'string' || typeof tokenData.symbol !== 'string')) return null;
  if (value.type === 'collection' && (!collectionData || typeof collectionData.name !== 'string')) return null;
  const divisibility = Number(tokenData?.divisibility);
  if (tokenData && (!Number.isSafeInteger(divisibility) || divisibility < 0 || divisibility > 38)) return null;
  return {
    alkaneid: value.alkaneid,
    type: value.type,
    tokenData: tokenData ? {
      name: tokenData.name,
      symbol: tokenData.symbol,
      divisibility,
      totalSupply: typeof tokenData.totalSupply === 'string' ? tokenData.totalSupply : '',
      minted: typeof tokenData.minted === 'string' ? tokenData.minted : '',
      mintable: typeof tokenData.mintable === 'boolean' ? tokenData.mintable : false,
    } : undefined,
    collectionData: collectionData ? {
      name: collectionData.name,
      totalSupply: typeof collectionData.totalSupply === 'string' ? collectionData.totalSupply : '',
      minted: Number.isSafeInteger(collectionData.minted) ? collectionData.minted : null,
    } : undefined,
  };
}

function normalizeRuneUtxo(value, address, runeid, runeBalances) {
  const txid = typeof value?.txid === 'string' ? value.txid.toLowerCase() : '';
  const vout = Number(value?.vout);
  const satoshi = Number(value?.satoshi);
  const confirmations = Number(value?.confirmations);
  if (
    value?.address !== address || !/^[a-f0-9]{64}$/.test(txid) ||
    !Number.isSafeInteger(vout) || vout < 0 ||
    !Number.isSafeInteger(satoshi) || satoshi < 1 ||
    !Number.isSafeInteger(confirmations) || confirmations < 1 ||
    !Array.isArray(runeBalances) || runeBalances.length > 100
  ) return null;
  const runes = runeBalances.map(item => {
    if (!item || !validRuneId(item.runeid) || typeof item.amount !== 'string' || !/^\d{1,80}$/.test(item.amount) || BigInt(item.amount) <= 0n) return null;
    return { runeid: item.runeid, amount: item.amount };
  });
  if (runes.some(item => item === null) || !runes.some(item => item.runeid === runeid)) return null;
  return { txid, vout, satoshi, confirmations, runes };
}

function normalizeAlkaneUtxo(value, address, alkaneid) {
  const txid = typeof value?.txid === 'string' ? value.txid.toLowerCase() : '';
  const vout = Number(value?.vout);
  const satoshi = Number(value?.satoshi);
  const confirmations = Number(value?.confirmations);
  if (
    value?.address !== address || !/^[a-f0-9]{64}$/.test(txid) ||
    !Number.isSafeInteger(vout) || vout < 0 ||
    !Number.isSafeInteger(satoshi) || satoshi < 0 ||
    !Number.isSafeInteger(confirmations) || confirmations < 0 ||
    !Array.isArray(value.alkanes)
  ) return null;
  const balances = value.alkanes.filter(item => item?.alkaneid === alkaneid);
  if (!balances.length || balances.some(item => typeof item.amount !== 'string' || !/^\d{1,80}$/.test(item.amount))) return null;
  const amount = balances.reduce((total, item) => total + BigInt(item.amount), 0n).toString();
  return { txid, vout, satoshi, confirmations, amount };
}

async function walletProtocolAssets(request, env, headers) {
  const url = new URL(request.url);
  const path = url.pathname;
  const chain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
  const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  const address = url.searchParams.get('address') || '';
  const start = parseBoundedInteger(url.searchParams.get('start'), 0, MAX_RUNES_OFFSET);
  const limit = parseBoundedInteger(url.searchParams.get('limit'), 20, MAX_RUNES_PAGE_SIZE);
  const alkaneid = url.searchParams.get('alkaneid') || '';
  const noStore = { ...headers, 'Cache-Control': 'no-store' };
  if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) || !validWalletAddress(address) || start === null || limit === null || limit < 1) {
    return Response.json({ error: 'Réseau, adresse ou pagination protocolaire invalide.' }, { status: 400, headers: noStore });
  }
  if (path === '/api/alkanes/utxo-list' && !validAlkaneId(alkaneid)) {
    return Response.json({ error: 'Identifiant Alkane invalide.' }, { status: 400, headers: noStore });
  }
  try {
    if (path === '/api/brc20/balance-list') {
      const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/brc20/summary?start=${start}&limit=${limit}&exclude_zero=true`, env, { signal: AbortSignal.timeout(8000) });
      if (Number(source?.start) !== start || !Number.isSafeInteger(Number(source?.total)) || Number(source.total) < 0 || !Array.isArray(source?.detail) || source.detail.length > limit) throw new Error('Invalid UniSat BRC-20 balance response');
      const detail = source.detail.map(normalizeBrc20InventoryBalance);
      if (detail.some(item => item === null)) throw new Error('Invalid UniSat BRC-20 balance item');
      return Response.json({ network: chain, address, start, total: Number(source.total), detail, refreshedAt: new Date().toISOString() }, { headers: noStore });
    }
    if (path === '/api/alkanes/token-list' || path === '/api/alkanes/collection-list') {
      const suffix = path.endsWith('collection-list') ? 'collection-list' : 'token-list';
      const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/alkanes/${suffix}?start=${start}&limit=${limit}`, env, { signal: AbortSignal.timeout(8000) });
      if (Number(source?.start) !== start || !Number.isSafeInteger(Number(source?.total)) || Number(source.total) < 0 || !Array.isArray(source?.detail) || source.detail.length > limit) throw new Error('Invalid UniSat Alkanes list response');
      const detail = source.detail.map(normalizeAlkaneInfo);
      if (detail.some(item => item === null || (suffix === 'token-list' ? item.type !== 'token' : item.type !== 'collection'))) throw new Error('Invalid UniSat Alkane metadata item');
      return Response.json({ network: chain, address, start, total: Number(source.total), detail, refreshedAt: new Date().toISOString() }, { headers: noStore });
    }
    if (path === '/api/runes/utxo-list') {
      const runeid = url.searchParams.get('runeid') || '';
      if (!validRuneId(runeid)) return Response.json({ error: 'Identifiant Rune invalide.' }, { status: 400, headers: noStore });
      const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/runes/${encodeURIComponent(runeid)}/utxo?start=${start}&limit=${limit}`, env, { signal: AbortSignal.timeout(8000) });
      if (Number(source?.start) !== start || !Number.isSafeInteger(Number(source?.total)) || Number(source.total) < 0 || !Array.isArray(source?.utxo) || source.utxo.length > limit) throw new Error('Invalid UniSat Rune UTXO response');
      const utxo = await Promise.all(source.utxo.map(async item => {
        const txid = typeof item?.txid === 'string' ? item.txid.toLowerCase() : '';
        const vout = Number(item?.vout);
        if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) throw new Error('Invalid Rune outpoint');
        const balances = await uniNetwork(base, `/v1/indexer/runes/utxo/${txid}/${vout}/balance`, env, { signal: AbortSignal.timeout(8000) });
        if (!Array.isArray(balances)) throw new Error('Incomplete per-outpoint Rune balance');
        return normalizeRuneUtxo(item, address, runeid, balances);
      }));
      if (utxo.some(item => item === null)) throw new Error('Invalid or incomplete UniSat Rune UTXO item');
      return Response.json({ network: chain, address, runeid, start, total: Number(source.total), utxo, refreshedAt: new Date().toISOString() }, { headers: noStore });
    }
    if (path === '/api/alkanes/utxo-list') {
      const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/alkanes/${encodeURIComponent(alkaneid)}/utxo?start=${start}&limit=${limit}`, env, { signal: AbortSignal.timeout(8000) });
      if (Number(source?.start) !== start || !Number.isSafeInteger(Number(source?.total)) || Number(source.total) < 0 || !Array.isArray(source?.utxo) || source.utxo.length > limit) throw new Error('Invalid UniSat Alkane UTXO response');
      const utxo = source.utxo.map(item => normalizeAlkaneUtxo(item, address, alkaneid));
      if (utxo.some(item => item === null)) throw new Error('Invalid UniSat Alkane UTXO item');
      return Response.json({ network: chain, address, alkaneid, start, total: Number(source.total), utxo, refreshedAt: new Date().toISOString() }, { headers: noStore });
    }
  } catch {
    console.warn('Wallet protocol balance lookup failed', { path, chain });
    return Response.json({ error: 'Les données de portefeuille protocolaires sont temporairement indisponibles.' }, { status: 503, headers: noStore });
  }
  return Response.json({ error: 'Route protocolaire inconnue.' }, { status: 404, headers: noStore });
}


class SpendableUtxoError extends Error {
  constructor(code, status = 503, details = {}) {
    super(code);
    this.name = 'SpendableUtxoError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function safeUniSatFailureCode(error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UniSat server binding is missing') return 'UNISAT_KEY_MISSING';
  if (message === 'Bitcoin UniSat server binding is missing') return 'UNISAT_BITCOIN_API_KEY_MISSING';
  if (message === 'UniSat API quota exceeded') return 'UNISAT_RATE_LIMITED';
  const status = message.match(/^UniSat upstream returned (\d{3})$/);
  if (status) return `UNISAT_HTTP_${status[1]}`;
  if (message === 'UniSat upstream rejected the request') return 'UNISAT_REJECTED';
  return 'UPSTREAM_CONNECTION_OR_RESPONSE';
}

async function spendableUtxoStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SpendableUtxoError) throw error;
    throw new SpendableUtxoError(`${stage}_${safeUniSatFailureCode(error)}`);
  }
}


async function addressUtxos(request, env, corsHeaders) {
  const url = new URL(request.url);
  const chain = url.searchParams.get('chain') || '';
  const address = url.searchParams.get('address') || '';
  const cursor = parseBoundedInteger(url.searchParams.get('cursor'), 0, 1000000);
  const size = parseBoundedInteger(url.searchParams.get('size'), 25, 25);
  if (!['bitcoin', 'fractal'].includes(chain) || !validWalletAddress(address) || cursor === null || size === null || size < 1) {
    return Response.json({ error: 'Invalid active UTXO query.', code: 'INVALID_QUERY' }, { status: 400, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  }
  const base = chain === 'bitcoin' ? BITCOIN_API_BASE : API_BASE;
  try {
    // all-utxo-data includes address UTXOs that are intentionally absent from available-utxo-data,
    // such as inscription-bearing outputs. This endpoint is display-only, never spend authorization.
    const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/all-utxo-data?cursor=${cursor}&size=${size}`, env, { signal: AbortSignal.timeout(10000) });
    const raw = Array.isArray(source?.utxo) ? source.utxo : null;
    if (!raw || raw.length > size) throw new Error('Invalid UniSat UTXO response');
    const utxo = raw.map(item => {
      const txid = typeof item?.txid === 'string' ? item.txid.toLowerCase() : '';
      const vout = Number(item?.vout);
      const satoshi = normalizeSatoshiValue(item);
      const rawHeight = item?.height;
      const height = rawHeight === null || rawHeight === undefined ? null : Number(rawHeight);
      const scriptPk = typeof item?.scriptPk === 'string' && /^(?:[a-f0-9]{2})+$/i.test(item.scriptPk) ? item.scriptPk.toLowerCase() : null;
      const inscriptions = Array.isArray(item?.inscriptions)
        ? item.inscriptions.filter(value => typeof value === 'string' || (value && typeof value === 'object')).map(value => typeof value === 'string' ? value : (typeof value.inscriptionId === 'string' ? value.inscriptionId : 'unknown'))
        : null;
      const isSpent = typeof item?.isSpent === 'boolean' ? item.isSpent : null;
      // Keep protocol markers in this display-only endpoint so the UI can distinguish
      // an ordinary-looking output from one carrying Runes/Alkanes. Missing metadata stays unknown.
      const runes = Array.isArray(item?.runes) ? item.runes : null;
      const alkanes = Array.isArray(item?.alkanes) ? item.alkanes : null;
      if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0 || !Number.isSafeInteger(satoshi) || satoshi < 0 ||
          (height !== null && (!Number.isSafeInteger(height) || height < 0))) return null;
      return { txid, vout, satoshi, height, scriptPk, inscriptions, runes, alkanes, isSpent };
    });
    if (utxo.some(item => item === null)) throw new Error('Invalid UniSat UTXO item');
    const seenOutpoints = new Set();
    for (const item of utxo) {
      const key = `${item.txid}:${item.vout}`;
      if (seenOutpoints.has(key)) throw new Error('Duplicate outpoint in UniSat UTXO page');
      seenOutpoints.add(key);
    }
    const sourceCursor = source?.cursor === undefined ? cursor : Number(source.cursor);
    const sourceTotal = source?.total === undefined ? null : Number(source.total);
    if (!Number.isSafeInteger(sourceCursor) || sourceCursor !== cursor ||
        (sourceTotal !== null && (!Number.isSafeInteger(sourceTotal) || sourceTotal < cursor + raw.length))) throw new Error('Inconsistent UniSat UTXO pagination');
    const nextCursor = cursor + raw.length;
    const totalKnown = sourceTotal !== null;
    const hasMore = totalKnown ? nextCursor < sourceTotal : raw.length === size;
    const total = sourceTotal ?? nextCursor + (hasMore ? 1 : 0);
    return Response.json({ chain, address, cursor, nextCursor, total, totalKnown, hasMore, scannedCount: raw.length, utxo, refreshedAt: new Date().toISOString() }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = safeUniSatFailureCode(error);
    console.warn('Active UTXO lookup failed', { chain, code });
    return Response.json({ error: 'Les UTXO actifs UniSat sont temporairement indisponibles.', code: `ACTIVE_UTXO_${code}` }, { status: 503, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  }
}

function minimumSpendableSatsForScript(scriptPk) {
  const script = typeof scriptPk === 'string' ? scriptPk.toLowerCase() : '';
  // Bitcoin Core-style dust floors for standard output templates. The transaction
  // builder still estimates the real fee and verifies aggregate input sufficiency.
  if (/^0014[a-f0-9]{40}$/.test(script)) return 294; // P2WPKH
  if (/^(?:0020[a-f0-9]{64}|5120[a-f0-9]{64})$/.test(script)) return 330; // P2WSH / P2TR
  if (/^a914[a-f0-9]{40}87$/.test(script)) return 540; // P2SH
  if (/^76a914[a-f0-9]{40}88ac$/.test(script)) return 546; // P2PKH
  return 600; // Unknown/non-standard script: keep the conservative floor.
}

async function spendableUtxos(request, env, corsHeaders) {
  const url = new URL(request.url);
  const chain = url.searchParams.get('chain') || '';
  const address = url.searchParams.get('address') || '';
  const cursor = parseBoundedInteger(url.searchParams.get('cursor'), 0, 1000000);
  const requestedSize = parseBoundedInteger(url.searchParams.get('size'), 25, 25);
  if (!['bitcoin', 'fractal'].includes(chain) || !validWalletAddress(address) || cursor === null || requestedSize === null || requestedSize < 1) throw new SpendableUtxoError('INVALID_QUERY', 400);
  const base = chain === 'bitcoin' ? BITCOIN_API_BASE : API_BASE;
  const supportsAlkanes = chain === 'bitcoin';
  // Scan the complete address inventory, not only UniSat's pre-filtered available set.
  // Every candidate must pass explicit on-chain/indexer metadata checks below; unknown metadata fails closed.
  const source = await spendableUtxoStage('UTXO_LIST', () => uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/all-utxo-data?cursor=${cursor}&size=${requestedSize}`, env));
  if (!Array.isArray(source?.utxo)) throw new SpendableUtxoError('UTXO_LIST_INVALID_RESPONSE');
  const raw = source.utxo;
  if (raw.length > requestedSize) throw new SpendableUtxoError('UTXO_PAGE_OVERSIZED');
  const checked = [];
  const pageOutpoints = new Set();
  // Safe, address-free rejection counters help distinguish indexer inconsistencies from
  // correctly rejected asset-bearing outputs. Never include addresses or outpoints here.
  const rejected = {
    identityMismatch: 0,
    invalidValue: 0,
    invalidScript: 0,
    unconfirmedOrInvalidHeight: 0,
    invalidFlags: 0,
    hasInscriptionOrUnknown: 0,
    detailMismatch: 0,
    spentOrUnknown: 0,
    hasRunes: 0,
    hasAlkanes: 0,
  };
  // Aggregate rejected value totals without returning rejected outpoints.
  const rejectedSats = {
    unconfirmedOrInvalidHeight: 0,
    invalidFlags: 0,
    hasInscriptionOrUnknown: 0,
    detailMismatch: 0,
    spentOrUnknown: 0,
    hasRunes: 0,
    hasAlkanes: 0,
  };
  for (const item of raw.slice(0, 25)) {
    const txid = typeof item?.txid === 'string' ? item.txid.toLowerCase() : '';
    const vout = Number(item?.vout);
    const outpointKey = `${txid}:${vout}`;
    if (/^[a-f0-9]{64}$/.test(txid) && Number.isSafeInteger(vout) && vout >= 0) {
      if (pageOutpoints.has(outpointKey)) throw new SpendableUtxoError('UTXO_PAGE_DUPLICATE_OUTPOINT');
      pageOutpoints.add(outpointKey);
    }
    const satoshi = normalizeSatoshiValue(item);
    const scriptPk = typeof item?.scriptPk === 'string' ? item.scriptPk.toLowerCase() : '';
    const height = Number(item?.height);
    const isLowFee = item?.isLowFee === undefined ? false : item.isLowFee;
    const isOpInRBF = item?.isOpInRBF === undefined ? false : item.isOpInRBF;
    // Confirmed outputs cannot be replaced through opt-in RBF; height > 0 remains mandatory.
    if (item?.address !== address || !/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) {
      rejected.identityMismatch += 1;
      continue;
    }
    if (!/^(?:[a-f0-9]{2})+$/.test(scriptPk)) {
      rejected.invalidScript += 1;
      continue;
    }
    if (!Number.isSafeInteger(satoshi) || satoshi < minimumSpendableSatsForScript(scriptPk)) {
      rejected.invalidValue += 1;
      continue;
    }
    if (!Number.isSafeInteger(height) || height <= 0) {
      rejected.unconfirmedOrInvalidHeight += 1;
      rejectedSats.unconfirmedOrInvalidHeight += satoshi;
      continue;
    }
    if (typeof isLowFee !== 'boolean' || typeof isOpInRBF !== 'boolean') {
      rejected.invalidFlags += 1;
      rejectedSats.invalidFlags += satoshi;
      continue;
    }
    if (!Array.isArray(item?.inscriptions) || item.inscriptions.length !== 0) {
      rejected.hasInscriptionOrUnknown += 1;
      rejectedSats.hasInscriptionOrUnknown += satoshi;
      continue;
    }
    // available-utxo-data is the authoritative spendable inventory. If it explicitly
    // includes empty Runes and Alkanes arrays, plus an empty inscriptions array, we can
    // defer the per-outpoint detail request until signing-time confirmation. This avoids
    // one extra UniSat HTTP call for every ordinary UTXO during a 500-output scan.
    // If either protocol marker is missing, keep the conservative detail lookup below.
    const hasExplicitAssetFreeMarkers =
      Array.isArray(item?.runes) && item.runes.length === 0 &&
      (!supportsAlkanes || (Array.isArray(item?.alkanes) && item.alkanes.length === 0)) &&
      Array.isArray(item?.inscriptions) && item.inscriptions.length === 0 &&
      Number.isSafeInteger(Number(item?.height)) && Number(item.height) > 0 &&
      item?.isSpent === false;
    let detail = null;
    if (!hasExplicitAssetFreeMarkers) {
      detail = await spendableUtxoStage('UTXO_DETAIL', () => uniNetwork(base, `/v1/indexer/utxo/${txid}/${vout}`, env));
      if (
        String(detail?.txid || '').toLowerCase() !== txid || Number(detail?.vout) !== vout ||
        detail?.address !== address || normalizeSatoshiValue(detail) !== satoshi ||
        String(detail?.scriptPk || '').toLowerCase() !== scriptPk
      ) {
        rejected.detailMismatch += 1;
        rejectedSats.detailMismatch += satoshi;
        continue;
      }
      if (!Number.isSafeInteger(Number(detail?.height)) || Number(detail.height) <= 0) {
        rejected.unconfirmedOrInvalidHeight += 1;
        rejectedSats.unconfirmedOrInvalidHeight += satoshi;
        continue;
      }
      if (detail?.isSpent !== false) {
        rejected.spentOrUnknown += 1;
        rejectedSats.spentOrUnknown += satoshi;
        continue;
      }
      if (typeof (detail?.isOpInRBF === undefined ? false : detail.isOpInRBF) !== 'boolean') {
        rejected.invalidFlags += 1;
        continue;
      }
      if (!Array.isArray(detail?.inscriptions) || detail.inscriptions.length !== 0) {
        rejected.hasInscriptionOrUnknown += 1;
        rejectedSats.hasInscriptionOrUnknown += satoshi;
        continue;
      }
    }
    let runeMetadata = [item?.runes, detail?.runes].filter(value => value !== undefined);
    // UniSat's available-UTXO list does not always include protocol arrays. When neither
    // the list nor the verified UTXO detail provides Runes metadata, query the per-outpoint
    // endpoint instead of incorrectly classifying every such output as unsafe.
    if (runeMetadata.length === 0) {
      const runes = await spendableUtxoStage('RUNES_BALANCE', () =>
        uniNetwork(base, `/v1/indexer/runes/utxo/${txid}/${vout}/balance`, env));
      if (!Array.isArray(runes)) throw new SpendableUtxoError('RUNES_INVALID_RESPONSE');
      runeMetadata = [runes];
    }
    if (runeMetadata.some(value => !Array.isArray(value) || value.length !== 0)) {
      rejected.hasRunes += 1;
      rejectedSats.hasRunes += satoshi;
      continue;
    }
    if (supportsAlkanes) {
      let alkaneMetadata = [item?.alkanes, detail?.alkanes].filter(value => value !== undefined);
      // As with Runes, missing metadata is not proof of safety. Query the protocol endpoint
      // when possible. UniSat's available-utxo-data already excludes protocol-asset outputs;
      // a 404 means this network deployment does not expose the optional Alkanes detail route.
      if (alkaneMetadata.length === 0) {
        try {
          const alkanes = await spendableUtxoStage('ALKANES_BALANCE', () =>
            uniNetwork(base, `/v1/indexer/alkanes/utxo/${txid}/${vout}/balance`, env));
          if (!Array.isArray(alkanes)) throw new SpendableUtxoError('ALKANES_INVALID_RESPONSE');
          alkaneMetadata = [alkanes];
        } catch (error) {
          if (error instanceof Error && error.message === 'UniSat upstream returned 404') {
            alkaneMetadata = [[]];
          } else {
            throw new SpendableUtxoError(`ALKANES_BALANCE_${safeUniSatFailureCode(error)}`);
          }
        }
      }
      if (alkaneMetadata.some(value => !Array.isArray(value) || value.length !== 0)) {
        rejected.hasAlkanes += 1;
        rejectedSats.hasAlkanes += satoshi;
        continue;
      }
  
    } else if (
      (item?.alkanes !== undefined && (!Array.isArray(item.alkanes) || item.alkanes.length !== 0)) ||
      (detail?.alkanes !== undefined && (!Array.isArray(detail.alkanes) || detail.alkanes.length !== 0))
    ) {
      // Fractal does not support Alkanes; unexpected or malformed asset markers still fail closed.
      rejected.hasAlkanes += 1;
      rejectedSats.hasAlkanes += satoshi;
      continue;
    }
    checked.push({ address, txid, vout, satoshi, scriptPk, height, isLowFee, isOpInRBF, inscriptions: [], inscriptionsRunesAlkanesChecked: true });
  }
  const sourceTotal = typeof source?.total === 'number'
    ? source.total
    : typeof source?.total === 'string' && /^\d+$/.test(source.total) ? Number(source.total) : null;
  const nextCursor = cursor + raw.length;
  if (sourceTotal !== null && (!Number.isSafeInteger(sourceTotal) || sourceTotal < nextCursor)) throw new SpendableUtxoError('UTXO_LIST_INCONSISTENT_TOTAL');
  // If UniSat omits total, a full page means there may be another page. Only a short/empty page proves exhaustion.
  const totalKnown = sourceTotal !== null;
  const hasMore = totalKnown ? nextCursor < sourceTotal : raw.length === requestedSize;
  const total = sourceTotal ?? nextCursor + (hasMore ? 1 : 0);
  return Response.json({ chain, address, cursor, nextCursor, total, totalKnown, hasMore, scannedCount: raw.length, utxo: checked, diagnostics: rejected, diagnosticsSats: rejectedSats }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function confirmSpendableUtxos(request, env, corsHeaders) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UTXO_CONFIRM_BODY_BYTES) throw new SpendableUtxoError('UTXO_CONFIRM_BODY_TOO_LARGE', 413);
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) throw new SpendableUtxoError('UTXO_CONFIRM_JSON_REQUIRED', 415);
  let body;
  try { body = await request.json(); } catch { throw new SpendableUtxoError('UTXO_CONFIRM_INVALID_JSON', 400); }
  const chain = body?.chain;
  const address = body?.address;
  const minimumSats = body?.minimumSats;
  const candidates = body?.utxos;
  if (!['fractal', 'bitcoin'].includes(chain) || !validWalletAddress(address) || !Number.isSafeInteger(minimumSats) || minimumSats <= 0 || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_UTXO_CONFIRM_INPUTS) {
    throw new SpendableUtxoError('INVALID_QUERY', 400);
  }
  const candidateByOutpoint = new Map();
  for (const candidate of candidates) {
    const txid = typeof candidate?.txid === 'string' ? candidate.txid.toLowerCase() : '';
    const vout = Number(candidate?.vout);
    const satoshi = normalizeSatoshiValue(candidate);
    const scriptPk = typeof candidate?.scriptPk === 'string' ? candidate.scriptPk.toLowerCase() : '';
    const sourceCursor = candidate?.sourceCursor === undefined ? null : candidate.sourceCursor;
    const key = `${txid}:${vout}`;
    if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0 || !/^(?:[a-f0-9]{2})+$/.test(scriptPk) || !Number.isSafeInteger(satoshi) || satoshi < minimumSpendableSatsForScript(scriptPk) ||
        (sourceCursor !== null && (typeof sourceCursor !== 'number' || !Number.isSafeInteger(sourceCursor) || sourceCursor < 0 || sourceCursor > MAX_UTXO_CONFIRM_CURSOR || sourceCursor % UTXO_CONFIRM_PAGE_SIZE !== 0)) || candidateByOutpoint.has(key)) {
      throw new SpendableUtxoError('UTXO_CONFIRM_INVALID_CANDIDATE', 400);
    }
    candidateByOutpoint.set(key, { txid, vout, satoshi, scriptPk, sourceCursor });
  }
  const base = chain === 'bitcoin' ? BITCOIN_API_BASE : API_BASE;
  const supportsAlkanes = chain === 'bitcoin';
  const availableByOutpoint = new Map();
  const allCandidatesHaveCursor = [...candidateByOutpoint.values()].every(candidate => candidate.sourceCursor !== null);
  // sourceCursor is only a hint. First search a small window for the common case;
  // if any input moved farther, restart from cursor 0 and exhaust the live inventory.
  // Only a complete sequential pass may prove that an outpoint is absent.
  const candidatePageCursors = allCandidatesHaveCursor
    ? [...new Set([...candidateByOutpoint.values()].flatMap(candidate =>
        Array.from({ length: 11 }, (_, index) => candidate.sourceCursor + (index - 5) * UTXO_CONFIRM_PAGE_SIZE)
          .filter(value => value >= 0 && value <= MAX_UTXO_CONFIRM_CURSOR)
      ))].sort((left, right) => left - right)
    : null;
  let sourceTotal = null;
  let scanComplete = false;

  const inspectAvailablePage = (raw, cursor, seenOutpoints) => {
    for (const item of raw) {
      if (item?.address !== address) throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_ADDRESS_MISMATCH');
      const txid = typeof item?.txid === 'string' ? item.txid.toLowerCase() : '';
      const vout = Number(item?.vout);
      if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_INVALID_OUTPOINT');
      const key = `${txid}:${vout}`;
      if (seenOutpoints.has(key)) throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_DUPLICATE_OUTPOINT');
      seenOutpoints.add(key);
      if (!candidateByOutpoint.has(key)) continue;
      const satoshi = normalizeSatoshiValue(item);
      const scriptPk = typeof item?.scriptPk === 'string' ? item.scriptPk.toLowerCase() : '';
      // This pass establishes inventory membership and exact output identity only.
      // UniSat's all-utxo-data page may omit ancillary metadata that was available
      // during the safe scan; the per-outpoint detail request below is authoritative
      // for confirmation, spent status, inscriptions, Runes, and Alkanes.
      const candidate = candidateByOutpoint.get(key);
      if (candidate && satoshi === candidate.satoshi && scriptPk === candidate.scriptPk) {
        availableByOutpoint.set(key, {
          ...candidate,
          isLowFee: typeof item?.isLowFee === 'boolean' ? item.isLowFee : null,
          isOpInRBF: typeof item?.isOpInRBF === 'boolean' ? item.isOpInRBF : null,
        });
      }
    }
  };

  const recoverablePaginationErrors = new Set([
    'UTXO_CONFIRM_AVAILABLE_CURSOR_MISMATCH',
    'UTXO_CONFIRM_AVAILABLE_SNAPSHOT_CHANGED',
  ]);
  const fetchAvailablePage = async (cursor, expectedTotal) => {
    const source = await spendableUtxoStage('UTXO_CONFIRM_AVAILABLE', () => uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/all-utxo-data?cursor=${cursor}&size=${UTXO_CONFIRM_PAGE_SIZE}`, env));
    const raw = source?.utxo;
    const sourceCursor = Number(source?.cursor);
    const total = Number(source?.total);
    if (!Array.isArray(raw) || raw.length > UTXO_CONFIRM_PAGE_SIZE || !Number.isSafeInteger(total) || total < 0) {
      throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_INVALID_RESPONSE');
    }
    // UniSat's available set can change while the user reviews a PSBT. Treat
    // cursor/total drift as a stale snapshot and retry from cursor 0, not as a
    // malformed provider payload. A stable scan is still required before approval.
    if (sourceCursor !== cursor || cursor > total || total < cursor + raw.length) {
      throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_CURSOR_MISMATCH');
    }
    if (expectedTotal !== null && total !== expectedTotal) {
      throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_SNAPSHOT_CHANGED');
    }
    return { raw, total };
  };

  let hintedSearchStable = true;
  if (candidatePageCursors) {
    let hintedTotal = null;
    const hintedOutpoints = new Set();
    try {
      for (const cursor of candidatePageCursors) {
        const { raw, total } = await fetchAvailablePage(cursor, hintedTotal);
        hintedTotal ??= total;
        sourceTotal = total;
        inspectAvailablePage(raw, cursor, hintedOutpoints);
        if (availableByOutpoint.size === candidateByOutpoint.size) break;
      }
    } catch (error) {
      if (!(error instanceof SpendableUtxoError) || !recoverablePaginationErrors.has(error.code)) throw error;
      hintedSearchStable = false;
      availableByOutpoint.clear();
    }
  }

  // If the hint is stale or any input moved outside its search window, restart
  // from cursor 0. Retry one complete pass if UniSat's available inventory
  // changes during pagination; never attest against a mixed snapshot.
  if (!candidatePageCursors || !hintedSearchStable || availableByOutpoint.size !== candidateByOutpoint.size) {
    let scanSucceeded = false;
    for (let attempt = 0; attempt < 2 && !scanSucceeded; attempt += 1) {
      availableByOutpoint.clear();
      let cursor = 0;
      let expectedTotal = null;
      const scannedOutpoints = new Set();
      sourceTotal = null;
      scanComplete = false;
      try {
        const maxPages = Math.ceil((MAX_UTXO_CONFIRM_CURSOR + UTXO_CONFIRM_PAGE_SIZE) / UTXO_CONFIRM_PAGE_SIZE);
        for (let page = 0; page < maxPages; page += 1) {
          const { raw, total } = await fetchAvailablePage(cursor, expectedTotal);
          sourceTotal = total;
          expectedTotal ??= total;
          inspectAvailablePage(raw, cursor, scannedOutpoints);
          if (availableByOutpoint.size === candidateByOutpoint.size) break;
          const nextCursor = cursor + raw.length;
          if (raw.length === 0) {
            if (cursor < total) {
              if (cursor >= MAX_UTXO_CONFIRM_CURSOR) throw new SpendableUtxoError('UTXO_CONFIRM_SCAN_LIMIT_REACHED', 409);
              throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_SCAN_INCOMPLETE', 409);
            }
            scanComplete = true;
            break;
          }
          if (nextCursor === total) { scanComplete = true; break; }
          if (nextCursor > MAX_UTXO_CONFIRM_CURSOR) throw new SpendableUtxoError('UTXO_CONFIRM_SCAN_LIMIT_REACHED', 409);
          cursor = nextCursor;
        }
        // UniSat can reorder offset-paginated available outputs without changing `total`.
        // If a complete pass misses an input, retry once from cursor 0 before declaring
        // the outpoint unavailable. A second complete miss still fails closed.
        if (scanComplete && availableByOutpoint.size !== candidateByOutpoint.size && attempt === 0) {
          continue;
        }
        scanSucceeded = true;
      } catch (error) {
        if (!(error instanceof SpendableUtxoError) || !recoverablePaginationErrors.has(error.code)) throw error;
        if (attempt === 1) throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_UNSTABLE_RESPONSE', 503);
      }
    }
  } else {
    // Hinted pages can locate candidates but never prove the inventory was exhausted.
    scanComplete = false;
  }

  if (sourceTotal === null) throw new SpendableUtxoError('UTXO_CONFIRM_AVAILABLE_INVALID_RESPONSE');
  if (availableByOutpoint.size !== candidateByOutpoint.size) {
    if (!scanComplete) throw new SpendableUtxoError('UTXO_CONFIRM_SCAN_LIMIT_REACHED', 409);
    const missingOutpoints = [...candidateByOutpoint.keys()].filter(key => !availableByOutpoint.has(key));
    throw new SpendableUtxoError('UTXO_CONFIRM_NOT_IN_AVAILABLE_SET', 409, { missingOutpoints });
  }
  const verified = [];
  let safeSats = 0;
  for (const [key, candidate] of candidateByOutpoint) {
    const available = availableByOutpoint.get(key);
    const detail = await spendableUtxoStage('UTXO_CONFIRM_DETAIL', () => uniNetwork(base, `/v1/indexer/utxo/${candidate.txid}/${candidate.vout}`, env));
    if (!available) throw new SpendableUtxoError('UTXO_CONFIRM_NOT_IN_AVAILABLE_SET', 409);
    if (
      String(detail?.txid || '').toLowerCase() !== candidate.txid || Number(detail?.vout) !== candidate.vout ||
      detail?.address !== address || Number(detail?.satoshi) !== candidate.satoshi ||
      String(detail?.scriptPk || '').toLowerCase() !== candidate.scriptPk
    ) throw new SpendableUtxoError('UTXO_CONFIRM_DETAIL_MISMATCH', 409);
    if (!Number.isSafeInteger(Number(detail?.height)) || Number(detail.height) <= 0) throw new SpendableUtxoError('UTXO_CONFIRM_NOT_CONFIRMED', 409);
    if (detail?.isSpent !== false) throw new SpendableUtxoError('UTXO_CONFIRM_SPENT_OR_UNKNOWN', 409);
    if (detail?.isOpInRBF !== undefined && typeof detail.isOpInRBF !== 'boolean') throw new SpendableUtxoError('UTXO_CONFIRM_INVALID_RBF_FLAG', 409);
    // isLowFee is advisory indexer metadata, not proof that an output is safe.
    // The discovery scanner already normalizes an omitted flag to false; mirror that
    // behavior only after this confirmation has independently matched the output,
    // confirmed its height and unspent state. Reject malformed non-boolean values.
    const rawLowFee = typeof available.isLowFee === 'boolean' ? available.isLowFee : detail?.isLowFee;
    const isLowFee = rawLowFee === undefined || rawLowFee === null ? false : rawLowFee;
    if (typeof isLowFee !== 'boolean') throw new SpendableUtxoError('UTXO_CONFIRM_INVALID_LOW_FEE_FLAG', 409);
    if (!Array.isArray(detail?.inscriptions) || detail.inscriptions.length !== 0) {
      throw new SpendableUtxoError('UTXO_CONFIRM_ASSET_OR_UNKNOWN', 409);
    }
    let runeMetadata = detail?.runes;
    if (runeMetadata === undefined) {
      runeMetadata = await spendableUtxoStage('UTXO_CONFIRM_RUNES', () =>
        uniNetwork(base, `/v1/indexer/runes/utxo/${candidate.txid}/${candidate.vout}/balance`, env));
    }
    if (!Array.isArray(runeMetadata) || runeMetadata.length !== 0) {
      throw new SpendableUtxoError('UTXO_CONFIRM_ASSET_OR_UNKNOWN', 409);
    }
    if (supportsAlkanes) {
      let alkaneMetadata = detail?.alkanes;
      if (alkaneMetadata === undefined) {
        try {
          alkaneMetadata = await spendableUtxoStage('UTXO_CONFIRM_ALKANES', () =>
            uniNetwork(base, `/v1/indexer/alkanes/utxo/${candidate.txid}/${candidate.vout}/balance`, env));
        } catch (error) {
          if (error instanceof Error && error.message === 'UniSat upstream returned 404') alkaneMetadata = [];
          else throw error;
        }
      }
      if (!Array.isArray(alkaneMetadata) || alkaneMetadata.length !== 0) {
        throw new SpendableUtxoError('UTXO_CONFIRM_ASSET_OR_UNKNOWN', 409);
      }
  
    } else if (detail?.alkanes !== undefined && (!Array.isArray(detail.alkanes) || detail.alkanes.length !== 0)) {
      throw new SpendableUtxoError('UTXO_CONFIRM_ASSET_OR_UNKNOWN', 409);
    }
    safeSats += candidate.satoshi;
    if (!Number.isSafeInteger(safeSats)) throw new SpendableUtxoError('UTXO_CONFIRM_TOTAL_UNSAFE');
    verified.push({ address, txid: candidate.txid, vout: candidate.vout, satoshi: candidate.satoshi, scriptPk: candidate.scriptPk, height: Number(detail.height), isLowFee, isOpInRBF: typeof detail.isOpInRBF === 'boolean' ? detail.isOpInRBF : typeof available.isOpInRBF === 'boolean' ? available.isOpInRBF : false, inscriptionsRunesAlkanesChecked: true });
  }
  return Response.json({ chain, address, minimumSats, safeSats, sufficient: safeSats >= minimumSats, verifiedUtxoCount: verified.length, utxo: verified, confirmedAt: new Date().toISOString() }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function market(collectionId, start, limit, env) {
  const [stat, list, actions, coin] = await Promise.all([
    uni('/v3/market/collection/auction/collection_statistic', env, {
      method: 'POST',
      body: JSON.stringify({ collectionId }),
    }),
    uni('/v3/market/collection/auction/list', env, {
      method: 'POST',
      body: JSON.stringify({
        filter: { nftType: 'collection', collectionId, all: false, isEnd: false },
        sort: { unitPrice: 1 },
        start,
        limit,
      }),
    }),
    uni('/v3/market/collection/auction/actions', env, {
      method: 'POST',
      body: JSON.stringify({
        filter: { nftType: 'collection', collectionId, event: 'Sold' },
        start: 0,
        limit: 100,
      }),
    }),
    Promise.all([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=fractal-bitcoin&vs_currencies=usd'),
      fetch('https://api.coinpaprika.com/v1/tickers/fb-fractal-bitcoin'),
    ]).then(async ([a, b]) => {
      const x = a.ok ? await a.json() : {};
      const y = b.ok ? await b.json() : {};
      return {
        'fractal-bitcoin': x?.['fractal-bitcoin'],
        'fb-fractal-bitcoin': { usd: y?.quotes?.USD?.price || null },
      };
    }).catch(() => ({})),
  ]);

  const fbUsd = Number(coin?.['fractal-bitcoin']?.usd || coin?.['fb-fractal-bitcoin']?.usd) || 0.3938937982597746;
  const priceToFb = (value) => typeof value === 'number' ? value / SATS : null;
  const s = stat || {};
  const sold = Array.isArray(actions?.list) ? actions.list : [];
  const since = Date.now() - 86400000;
  const volume24hSats = sold
    .filter((item) => Number(item.timestamp || 0) * (Number(item.timestamp || 0) < 1000000000000 ? 1000 : 1) >= since)
    .reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const floorFb = priceToFb(Number(s.floorPrice) || 0);
  const volumeTotalFb = priceToFb(Number(s.btcValue) || 0);
  const marketCapFb = floorFb != null && Number(s.total) ? floorFb * Number(s.total) : null;
  const items = Array.isArray(list?.list)
    ? list.list
      .filter((item) => item && item.notOnSale !== true && Boolean(item.auctionId))
      .map((item) => {
        const priceSats = Number(item.price || item.unitPrice || 0) || null;
        const priceFb = priceToFb(priceSats);
        return {
          auctionId: item.auctionId || null,
          inscriptionId: item.inscriptionId,
          collectionItemName: item.collectionItemName || null,
          collectionName: item.collectionName || s.name || null,
          priceSats,
          priceFb,
          priceUsd: priceFb != null && fbUsd != null ? priceFb * fbUsd : null,
          address: item.address || null,
          marketType: item.marketType || null,
        };
      })
    : [];

  return {
    collectionId,
    collectionName: s.name || items[0]?.collectionName || null,
    fbUsd,
    stats: {
      volumeTotalFb,
      volumeTotalUsd: volumeTotalFb != null && fbUsd != null ? volumeTotalFb * fbUsd : null,
      volume24hFb: priceToFb(volume24hSats),
      volume24hUsd: priceToFb(volume24hSats) != null && fbUsd != null ? priceToFb(volume24hSats) * fbUsd : null,
      floorFb,
      floorUsd: floorFb != null && fbUsd != null ? floorFb * fbUsd : null,
      marketCapFb,
      marketCapUsd: marketCapFb != null && fbUsd != null ? marketCapFb * fbUsd : null,
      listed: s.listed ?? null,
      total: s.total ?? null,
    },
    listings: items,
    totalListings: Number(s.listed ?? list?.total ?? items.length),
    start,
    limit,
    refreshedAt: new Date().toISOString(),
  };
}

async function inscription(inscriptionId, env, chain = 'FRACTAL_BITCOIN_MAINNET') {
  const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  const genesisTxid = inscriptionId.split('i')[0];
  const [infoResult, listingResult, inputsResult] = await Promise.allSettled([
    uniNetwork(base, '/v1/indexer/inscription/info/' + inscriptionId, env),
    uniNetwork(base, '/v3/market/collection/auction/inscription_info', env, {
      method: 'POST',
      body: JSON.stringify({ inscriptionId }),
    }),
    /^[a-f0-9]{64}$/.test(genesisTxid)
      ? uniNetwork(base, '/v1/indexer/tx/' + genesisTxid + '/ins?cursor=0&size=100', env)
      : Promise.resolve([]),
  ]);
  if (infoResult.status !== 'fulfilled') throw infoResult.reason;
  const info = infoResult.value || {};
  const listing = listingResult.status === 'fulfilled' ? listingResult.value || {} : {};
  const inputs = inputsResult.status === 'fulfilled' ? inputsResult.value : [];
  const owner = info.address || (info.utxo && info.utxo.address) || null;
  const creator = Array.isArray(inputs) ? ((inputs.find((item) => item && item.address) || {}).address || null) : null;
  const listed = Boolean(listing.auctionId) && listing.notOnSale !== true;
  const priceFb = typeof listing.price === 'number' ? listing.price / SATS : null;
  return {
    inscriptionId,
    owner,
    creator,
    listing: {
      listed,
      auctionId: listing.auctionId || null,
      price: listing.price ?? null,
      priceFb,
      address: listing.address || null,
      marketType: listing.marketType || null,
      collectionName: listing.collectionName || null,
    },
    refreshedAt: new Date().toISOString(),
  };
}

function validAddress(value) {
  return typeof value === 'string' && value.length >= 14 && value.length <= 100 && /^[A-Za-z0-9]+$/.test(value);
}

function validPubkey(value) {
  return typeof value === 'string' && (/^(?:02|03)[a-f0-9]{64}$/i.test(value) || /^04[a-f0-9]{128}$/i.test(value));
}

class InscribeRequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validateInscribeFile(file) {
  if (!file || typeof file.filename !== 'string' || file.filename.length < 1 || file.filename.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(file.filename)) throw new InscribeRequestError('Nom de fichier invalide.');
  if (typeof file.dataURL !== 'string' || file.dataURL.length > 520000 || !/^data:[^,]{1,200};base64,/.test(file.dataURL)) throw new InscribeRequestError('Le fichier doit être fourni comme URL de données base64 valide.');
  const encoded = file.dataURL.slice(file.dataURL.indexOf(',') + 1);
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new InscribeRequestError('Encodage base64 du fichier invalide.');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedSize = (encoded.length / 4) * 3 - padding;
  if (decodedSize < 1 || decodedSize > MAX_INSCRIBE_FILE_BYTES) throw new InscribeRequestError('Chaque fichier doit mesurer entre 1 octet et 365 KiB.');
  return { filename: file.filename, dataURL: file.dataURL };
}

function boundedProtocolCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new InscribeRequestError('Le nombre de lots doit être compris entre 1 et 1000.');
  return count;
}

function validateInscribeProtocol(value) {
  if (value == null) return { type: 'files' };
  if (!value || typeof value !== 'object') throw new InscribeRequestError('Protocole d’inscription invalide.');
  const type = value.type;
  if (type === 'files' || type === 'alkanes-deploy') return { type };
  if (type === 'brc20') {
    const operation = value.operation;
    const ticker = typeof value.ticker === 'string' ? value.ticker : '';
    if (!['deploy', 'mint', 'transfer'].includes(operation) || !/^[A-Za-z0-9]{1,32}$/.test(ticker)) throw new InscribeRequestError('Opération ou ticker BRC-20 invalide.');
    if (operation === 'deploy') {
      const max = typeof value.max === 'string' ? value.max : '';
      const limit = typeof value.limit === 'string' ? value.limit : '';
      const decimals = value.decimals == null ? 18 : Number(value.decimals);
      if (!/^\d{1,80}$/.test(max) || !/^\d{1,80}$/.test(limit) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new InscribeRequestError('Paramètres de déploiement BRC-20 invalides.');
      return { type, operation, ticker, max, limit, decimals };
    }
    const amount = typeof value.amount === 'string' ? value.amount : '';
    if (!/^(?:0|[1-9]\d{0,79})(?:\.\d{1,18})?$/.test(amount) || /^0(?:\.0+)?$/.test(amount)) throw new InscribeRequestError('Montant BRC-20 invalide.');
    return { type, operation, ticker, amount };
  }
  if (type === 'runes-etch') {
    const spacedRune = typeof value.spacedRune === 'string' ? value.spacedRune : '';
    const symbol = value.symbol == null ? '' : value.symbol;
    const divisibility = Number(value.divisibility);
    const premine = typeof value.premine === 'string' ? value.premine : '';
    if (!/^[A-Z0-9•]{1,64}$/.test(spacedRune) || spacedRune.startsWith('•') || spacedRune.endsWith('•') || spacedRune.includes('••') || (typeof symbol !== 'string' || [...symbol].length > 1) || !Number.isSafeInteger(divisibility) || divisibility < 0 || divisibility > 38 || !/^\d{1,80}$/.test(premine)) throw new InscribeRequestError('Paramètres d’etch Runes invalides.');
    let terms;
    if (value.terms != null) {
      const raw = value.terms;
      if (!raw || typeof raw !== 'object' || !/^\d{1,80}$/.test(String(raw.amount ?? '')) || !/^\d{1,80}$/.test(String(raw.cap ?? ''))) throw new InscribeRequestError('Conditions d’etch Runes invalides.');
      const validateRange = range => Array.isArray(range) && range.length === 2 && range.every(item => Number.isSafeInteger(item) && item >= 0);
      if ((raw.height != null && !validateRange(raw.height)) || (raw.offset != null && !validateRange(raw.offset))) throw new InscribeRequestError('Plage de hauteur ou d’offset Rune invalide.');
      terms = { amount: String(raw.amount), cap: String(raw.cap), ...(raw.height ? { height: raw.height } : {}), ...(raw.offset ? { offset: raw.offset } : {}) };
    }
    return { type, etching: { spacedRune, ...(symbol ? { symbol } : {}), divisibility, premine, ...(terms ? { terms } : {}) } };
  }
  if (type === 'runes-mint') {
    const runeid = typeof value.runeid === 'string' ? value.runeid : '';
    if (!validRuneId(runeid)) throw new InscribeRequestError('Identifiant Rune invalide.');
    return { type, runeid, count: boundedProtocolCount(value.count) };
  }
  if (type === 'alkanes-mint') {
    const alkaneid = typeof value.alkaneid === 'string' ? value.alkaneid : '';
    if (!validAlkaneId(alkaneid)) throw new InscribeRequestError('Identifiant Alkane invalide.');
    return { type, alkaneid, count: boundedProtocolCount(value.count) };
  }
  throw new InscribeRequestError('Type d’inscription non pris en charge.');
}

function protocolDataUrl(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/plain;charset=utf-8;base64,${btoa(binary)}`;
}

async function inscribeOrder(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { throw new InscribeRequestError('Corps JSON invalide.'); }
  const protocol = validateInscribeProtocol(body?.protocol);
  let filesInput = Array.isArray(body?.files) ? body.files : (body?.file ? [body.file] : []);
  if (protocol.type === 'brc20') {
    const inscription = { p: 'brc-20', op: protocol.operation, tick: protocol.ticker, ...(protocol.operation === 'deploy' ? { max: protocol.max, lim: protocol.limit, dec: String(protocol.decimals) } : { amt: protocol.amount }) };
    filesInput = [{ filename: `brc20-${protocol.operation}-${protocol.ticker}.json`, dataURL: protocolDataUrl(inscription) }];
  }
  if (protocol.type === 'runes-etch' && !filesInput.length) {
    filesInput = [{ filename: 'runes-etch.json', dataURL: protocolDataUrl({ p: 'runes', op: 'etch', ...protocol.etching }) }];
  }
  const requestedFeeRate = body?.feeRate == null ? 0 : Number(body.feeRate);
  const outputValue = Number(body?.outputValue ?? 546);
  const chain = body?.chain || 'FRACTAL_BITCOIN_MAINNET';
  if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) throw new InscribeRequestError('Réseau d’inscription non pris en charge.');
  if (!validAddress(body?.receiver) || !validAddress(body?.refundAddress) || !validAddress(body?.userAddress) || !validPubkey(body?.userPubkey)) throw new InscribeRequestError('Adresse de wallet ou clé publique invalide.');
  if ((requestedFeeRate !== 0 && (!Number.isSafeInteger(requestedFeeRate) || requestedFeeRate < 1 || requestedFeeRate > 10000)) || outputValue !== 546) throw new InscribeRequestError('Fee rate ou valeur de sortie invalide.');
  if ((protocol.type !== 'runes-mint' && protocol.type !== 'alkanes-mint' && !filesInput.length) || filesInput.length > MAX_INSCRIBE_FILES) throw new InscribeRequestError(`La commande doit contenir de 1 à ${MAX_INSCRIBE_FILES} fichiers.`);
  if (protocol.type === 'runes-etch' && filesInput.length > 1) throw new InscribeRequestError('L’etch Rune accepte un seul fichier de données par commande.');
  let files = filesInput.map(validateInscribeFile);
  if (protocol.type === 'runes-etch') files = files.map(file => ({ ...file, runes_etch: { etching: protocol.etching } }));
  const estimatedPayloadBytes = files.reduce((total, file) => total + file.dataURL.length + file.filename.length + 512, 4096);
  if (estimatedPayloadBytes > MAX_INSCRIBE_BODY_BYTES) throw new InscribeRequestError('Le lot encodé dépasse 95 Mo. Réduisez la taille des fichiers ou créez plusieurs lots.', 413);
  const feeEstimate = await recommendedFeeEstimate(chain, env);
  const feeRate = feeEstimate.feeRate;
  const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  const common = { clientId: 'demro-labs-gallery', receiver: body.receiver, refundAddress: body.refundAddress, userAddress: body.userAddress, userPubkey: body.userPubkey, feeRate, outputValue };
  let quotePath = '/v5/inscribe/order/estimate-fee';
  let createPath = '/v5/inscribe/order/create';
  let payload = { ...common, files };
  if (protocol.type === 'runes-etch') {
    quotePath = '/v5/inscribe/order/quote/runes-etch';
    createPath = '/v5/inscribe/order/create/runes-etch';
  } else if (protocol.type === 'runes-mint') {
    quotePath = '/v5/inscribe/order/quote/runes-mint';
    createPath = '/v5/inscribe/order/create/runes-mint';
    payload = { ...common, runeId: protocol.runeid, count: protocol.count };
  } else if (protocol.type === 'alkanes-deploy') {
    quotePath = '/v5/inscribe/order/quote/alkanes-deploy';
    createPath = '/v5/inscribe/order/create/alkanes-deploy';
  } else if (protocol.type === 'alkanes-mint') {
    quotePath = '/v5/inscribe/order/quote/alkanes-mint';
    createPath = '/v5/inscribe/order/create/alkanes-mint';
    payload = { ...common, alkaneid: protocol.alkaneid, count: protocol.count };
  }
  const quote = await uniNetwork(base, quotePath, env, { method: 'POST', body: JSON.stringify(payload) });
  const quoteAmount = Number(quote?.payableAmount);
  if (!Number.isSafeInteger(quoteAmount) || quoteAmount <= 0) throw new Error('UniSat returned an invalid protocol inscription quote. No order was created.');
  const upstream = await uniNetwork(base, createPath, env, { method: 'POST', body: JSON.stringify(payload) });
  if (!upstream?.orderId || !upstream?.payAddress || !Number.isSafeInteger(Number(upstream?.amount))) throw new Error('UniSat returned an incomplete inscription order.');
  return Response.json({ orderId: upstream.orderId, status: upstream.status, payAddress: upstream.payAddress, amount: Number(upstream.amount), quoteAmount, network: chain, feeRate, feeTarget: feeEstimate.target, feeSources: feeEstimate.sources, feeStrategy: feeEstimate.strategy }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function cancelInscribeOrder(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Corps JSON invalide.' }, { status: 400, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } }); }
  const orderId = typeof body?.orderId === 'string' ? body.orderId : '';
  const chain = body?.chain || 'FRACTAL_BITCOIN_MAINNET';
  const noStore = { ...corsHeaders, 'Cache-Control': 'no-store' };
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(orderId)) return Response.json({ error: 'Identifiant de commande invalide.' }, { status: 400, headers: noStore });
  if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) return Response.json({ error: 'Réseau d’inscription non pris en charge.' }, { status: 400, headers: noStore });
  const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  try {
    // cancel2 is UniSat V5's order cancellation endpoint. /cancel is RBF acceleration and must not be used here.
    await uniNetwork(base, '/v5/inscribe/cancel2', env, { method: 'POST', body: JSON.stringify({ orderId }) });
    return Response.json({ cancelled: true, orderId, network: chain }, { headers: noStore });
  } catch (error) {
    console.warn('UniSat inscription order cancellation failed');
    return Response.json({ error: 'UniSat n’a pas confirmé l’annulation. Le reçu doit rester conservé jusqu’à vérification du statut.' }, { status: 502, headers: noStore });
  }
}
async function inscribeOrderStatus(request, env, corsHeaders) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('orderId') || '';
  const chain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(orderId)) return Response.json({ error: 'Identifiant de commande invalide.' }, { status: 400, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) return Response.json({ error: 'Réseau d’inscription non pris en charge.' }, { status: 400, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  const result = await uniNetwork(base, '/v5/inscribe/order/' + encodeURIComponent(orderId), env);
  return Response.json({ orderId: result.orderId, status: result.status, amount: result.amount, balance: result.balance, network: chain, files: Array.isArray(result.files) ? result.files.map(file => ({ filename: file.filename, size: file.size, inscriptionId: file.inscriptionId, txid: file.txid, inscriptionTxid: file.inscriptionTxid, status: file.status })) : [] }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function edgeCachedResponse(request, headers, freshSeconds, staleSeconds, producer) {
  const cache = typeof caches === 'undefined' ? null : caches.default;
  if (!cache) {
    const response = await producer();
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Cache-Control', `public, max-age=${freshSeconds}, s-maxage=${freshSeconds}, stale-while-revalidate=${staleSeconds}`);
    responseHeaders.set('X-Edge-Cache', 'BYPASS');
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('__edge_origin', request.headers.get('Origin') || 'no-origin');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  let cached = null;
  try { cached = await cache.match(cacheKey); } catch { /* Cache API is best-effort. */ }
  const now = Date.now();
  const freshUntil = Number(cached?.headers.get('X-Edge-Fresh-Until') || 0);

  const serve = (response, cacheState) => {
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('X-Edge-Fresh-Until');
    for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
    responseHeaders.set('Cache-Control', `public, max-age=${freshSeconds}, s-maxage=${freshSeconds}, stale-while-revalidate=${staleSeconds}`);
    responseHeaders.set('X-Edge-Cache', cacheState);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  };

  if (cached && freshUntil > now) return serve(cached, 'HIT');
  try {
    const response = await producer();
    if (response.ok) {
      const storedHeaders = new Headers(response.headers);
      storedHeaders.set('X-Edge-Fresh-Until', String(now + freshSeconds * 1000));
      storedHeaders.set('Cache-Control', `public, max-age=${freshSeconds + staleSeconds}`);
      try {
        await cache.put(cacheKey, new Response(response.clone().body, { status: response.status, headers: storedHeaders }));
      } catch { /* Continue with the fresh origin response if edge storage fails. */ }
    }
    return serve(response, 'MISS');
  } catch (error) {
    if (cached?.ok) return serve(cached, 'STALE');
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const headers = cors(request);

    if (origin && !isAllowedOrigin(origin)) {
      return new Response('Forbidden', { status: 403, headers });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname.startsWith('/api/auth/')) return handleWalletAuth(request, env, headers);
    if (url.pathname.startsWith('/api/mempool/')) {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || '';
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) return Response.json({ error: 'Unsupported Mempool network.' }, { status: 400, headers: noStore });
      const base = chain === 'BITCOIN_MAINNET' ? 'https://mempool.space' : 'https://mempool.fractalbitcoin.io';
      const address = url.searchParams.get('address') || '';
      const txid = url.searchParams.get('txid') || '';
      const validTxid = /^[a-f0-9]{64}$/i.test(txid);
      const validAddress = validWalletAddress(address);
      let upstreamPath = '';
      if (request.method === 'GET' && url.pathname === '/api/mempool/address') {
        if (!validAddress) return Response.json({ error: 'Invalid address.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/address/' + encodeURIComponent(address);
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/address-txs') {
        if (!validAddress) return Response.json({ error: 'Invalid address.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/address/' + encodeURIComponent(address) + '/txs';
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/validate-address') {
        if (!validAddress) return Response.json({ error: 'Invalid address.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/v1/validate-address/' + encodeURIComponent(address);
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/tx-status') {
        if (!validTxid) return Response.json({ error: 'Invalid transaction id.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/tx/' + encodeURIComponent(txid) + '/status';
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/tx-hex') {
        if (!validTxid) return Response.json({ error: 'Invalid transaction id.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/tx/' + encodeURIComponent(txid) + '/hex';
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/fees') {
        upstreamPath = '/api/v1/fees/recommended';
      } else if (request.method === 'POST' && url.pathname === '/api/mempool/tx') {
        const raw = (await request.text()).trim().replace(/^"|"$/g, '');
        if (!/^(?:[a-f0-9]{2})+$/i.test(raw) || raw.length > 2_000_000) return Response.json({ error: 'Invalid raw transaction hex.' }, { status: 400, headers: noStore });
        try {
          const upstream = await fetch(base + '/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain', Accept: 'text/plain' }, body: raw, signal: AbortSignal.timeout(15_000) });
          const body = (await upstream.text()).trim().replace(/^"|"$/g, '');
          if (!upstream.ok) return Response.json({ error: 'Mempool rejected the transaction.', detail: body.slice(0, 300) }, { status: upstream.status, headers: noStore });
          if (!/^[a-f0-9]{64}$/i.test(body)) return Response.json({ error: 'Mempool returned an invalid transaction id.' }, { status: 502, headers: noStore });
          return Response.json({ network: chain, txid: body.toLowerCase(), broadcastAt: new Date().toISOString() }, { headers: noStore });
        } catch {
          return Response.json({ error: 'Mempool broadcast endpoint is unavailable.' }, { status: 503, headers: noStore });
        }
      } else {
        return Response.json({ error: 'Unsupported Mempool proxy route.' }, { status: 404, headers: noStore });
      }
      try {
        const upstream = await fetchMempoolReadWithRetry(base + upstreamPath, { headers: { Accept: url.pathname.endsWith('/tx-hex') ? 'text/plain' : 'application/json' } });
        const body = await upstream.text();
        if (!upstream.ok) return Response.json({ error: 'Mempool upstream request failed.', upstreamStatus: upstream.status }, { status: upstream.status, headers: noStore });
        if (url.pathname.endsWith('/tx-hex')) {
          const hex = body.trim().replace(/^"|"$/g, '');
          if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) return Response.json({ error: 'Mempool returned invalid transaction hex.' }, { status: 502, headers: noStore });
          return new Response(hex, { headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        const data = JSON.parse(body);
        return Response.json(data, { headers: noStore });
      } catch {
        return Response.json({ error: 'Mempool live source is temporarily unavailable.' }, { status: 503, headers: noStore });
      }
    }
    if (url.pathname.startsWith('/api/mempool/')) {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || '';
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) return Response.json({ error: 'Unsupported Mempool network.' }, { status: 400, headers: noStore });
      const base = chain === 'BITCOIN_MAINNET' ? 'https://mempool.space' : 'https://mempool.fractalbitcoin.io';
      const address = url.searchParams.get('address') || '';
      const txid = url.searchParams.get('txid') || '';
      const validTxid = /^[a-f0-9]{64}$/i.test(txid);
      const validAddress = validWalletAddress(address);
      let upstreamPath = '';
      if (request.method === 'GET' && url.pathname === '/api/mempool/address') {
        if (!validAddress) return Response.json({ error: 'Invalid address.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/address/' + encodeURIComponent(address);
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/address-txs') {
        if (!validAddress) return Response.json({ error: 'Invalid address.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/address/' + encodeURIComponent(address) + '/txs';
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/validate-address') {
        if (!validAddress) return Response.json({ error: 'Invalid address.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/v1/validate-address/' + encodeURIComponent(address);
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/tx-status') {
        if (!validTxid) return Response.json({ error: 'Invalid transaction id.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/tx/' + encodeURIComponent(txid) + '/status';
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/tx-hex') {
        if (!validTxid) return Response.json({ error: 'Invalid transaction id.' }, { status: 400, headers: noStore });
        upstreamPath = '/api/tx/' + encodeURIComponent(txid) + '/hex';
      } else if (request.method === 'GET' && url.pathname === '/api/mempool/fees') {
        upstreamPath = '/api/v1/fees/recommended';
      } else if (request.method === 'POST' && url.pathname === '/api/mempool/tx') {
        const raw = (await request.text()).trim().replace(/^"|"$/g, '');
        if (!/^(?:[a-f0-9]{2})+$/i.test(raw) || raw.length > 2_000_000) return Response.json({ error: 'Invalid raw transaction hex.' }, { status: 400, headers: noStore });
        try {
          const upstream = await fetch(base + '/api/tx', { method: 'POST', headers: { 'Content-Type': 'text/plain', Accept: 'text/plain' }, body: raw, signal: AbortSignal.timeout(15_000) });
          const body = (await upstream.text()).trim().replace(/^"|"$/g, '');
          if (!upstream.ok) return Response.json({ error: 'Mempool rejected the transaction.', detail: body.slice(0, 300) }, { status: upstream.status, headers: noStore });
          if (!/^[a-f0-9]{64}$/i.test(body)) return Response.json({ error: 'Mempool returned an invalid transaction id.' }, { status: 502, headers: noStore });
          return Response.json({ network: chain, txid: body.toLowerCase(), broadcastAt: new Date().toISOString() }, { headers: noStore });
        } catch {
          return Response.json({ error: 'Mempool broadcast endpoint is unavailable.' }, { status: 503, headers: noStore });
        }
      } else {
        return Response.json({ error: 'Unsupported Mempool proxy route.' }, { status: 404, headers: noStore });
      }
      try {
        const upstream = await fetch(base + upstreamPath, { headers: { Accept: url.pathname.endsWith('/tx-hex') ? 'text/plain' : 'application/json' }, signal: AbortSignal.timeout(10_000) });
        const body = await upstream.text();
        if (!upstream.ok) return Response.json({ error: 'Mempool upstream request failed.', upstreamStatus: upstream.status }, { status: upstream.status, headers: noStore });
        if (url.pathname.endsWith('/tx-hex')) {
          const hex = body.trim().replace(/^"|"$/g, '');
          if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) return Response.json({ error: 'Mempool returned invalid transaction hex.' }, { status: 502, headers: noStore });
          return new Response(hex, { headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        const data = JSON.parse(body);
        return Response.json(data, { headers: noStore });
      } catch {
        return Response.json({ error: 'Mempool live source is temporarily unavailable.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/fractal/balance') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const address = url.searchParams.get('address') || '';
      if (!validWalletAddress(address)) return Response.json({ error: 'Adresse Fractal invalide.' }, { status: 400, headers: noStore });
      try {
        return edgeCachedResponse(request, headers, 10, 30, async () => {
          const balance = await uniNetwork(API_BASE, '/v1/indexer/address/' + encodeURIComponent(address) + '/balance', env, { signal: AbortSignal.timeout(8000) });
          return Response.json({ network: 'FRACTAL_BITCOIN_MAINNET', address, balance, refreshedAt: new Date().toISOString() }, { headers });
        });
      } catch {
        return Response.json({ error: 'Le solde Fractal est temporairement indisponible.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/transactions/history') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const address = url.searchParams.get('address') || '';
      const chain = url.searchParams.get('chain') || '';
      const cursorRaw = url.searchParams.get('cursor');
      const sizeRaw = url.searchParams.get('size');
      const cursor = cursorRaw === null ? 0 : /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : null;
      const size = sizeRaw === null ? 10 : /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : null;
      if (!validWalletAddress(address) || !['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 10000 || !Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
        return Response.json({ error: 'Adresse, réseau ou pagination de l’historique invalide.' }, { status: 400, headers: noStore });
      }
      const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
      try {
        const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/history?cursor=${cursor}&size=${size}`, env, { signal: AbortSignal.timeout(8000) });
        const total = Number(source?.total);
        if (!Number.isSafeInteger(Number(source?.start)) || Number(source.start) !== cursor || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(source?.detail) || source.detail.length > size) throw new Error('Invalid UniSat address history response');
        const detail = source.detail.map(normalizeAddressTransaction);
        if (detail.some(item => item === null)) throw new Error('Invalid UniSat address transaction');
        return Response.json({ network: chain, address, start: cursor, total, detail, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        return Response.json({ error: 'L’historique des transactions est temporairement indisponible pour ce réseau.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/fees/recommended') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || '';
      const target = url.searchParams.get('target') || 'halfHour';
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) || target !== 'halfHour') return Response.json({ error: 'Réseau ou objectif de confirmation invalide.' }, { status: 400, headers: noStore });
      try {
        const estimate = await recommendedFeeEstimate(chain, env);
        return Response.json(estimate, { headers: noStore });
      } catch {
        return Response.json({ error: 'Les estimateurs Mempool et UniSat sont temporairement indisponibles. Aucun taux périmé ne sera utilisé.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/brc20-prog/balances') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const address = url.searchParams.get('address') || '';
      const chain = url.searchParams.get('chain') || 'BITCOIN_MAINNET';
      if (!validWalletAddress(address) || chain !== 'BITCOIN_MAINNET') return Response.json({ error: 'BRC2.0 est disponible uniquement sur Bitcoin mainnet.' }, { status: 400, headers: noStore });
      const base = BITCOIN_API_BASE;
      try {
        const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/brc20-prog/summary?start=0&limit=100`, env, { signal: AbortSignal.timeout(8000) });
        const raw = Array.isArray(source?.detail) ? source.detail : [];
        const detail = raw.map(normalizeBrc20ProgBalance).filter(Boolean);
        if (detail.length !== raw.length) throw new Error('Invalid BRC20-Prog balance response');
        return Response.json({ network: chain, address, detail, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        return Response.json({ error: `Les soldes BRC20-Prog ${chain === 'BITCOIN_MAINNET' ? 'Bitcoin' : 'Fractal'} sont temporairement indisponibles.` }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/brc20-prog/module/status') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || 'BITCOIN_MAINNET';
      if (chain !== 'BITCOIN_MAINNET') return Response.json({ error: 'BRC2.0 est disponible uniquement sur Bitcoin mainnet.' }, { status: 400, headers: noStore });
      try {
        const rpcUrl = brc20ProgRpcUrl(env, chain);
        const rpcHeaders = brc20ProgRpcHeaders(env, chain);
        const upstream = await fetch(rpcUrl.toString(), {
          method: 'POST', headers: rpcHeaders, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 'brc20-prog-health', method: 'eth_blockNumber', params: [] }),
        });
        if (!upstream.ok) throw new Error('BRC2.0 RPC unavailable');
        const payload = await upstream.json();
        if (payload?.error || typeof payload?.result !== 'string' || !/^0x[0-9a-f]+$/i.test(payload.result)) throw new Error('Invalid BRC2.0 RPC response');
        return Response.json({ network: chain, configured: true, blockNumber: payload.result, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        return Response.json({ error: `Le RPC BRC2.0 ${chain === 'BITCOIN_MAINNET' ? 'Bitcoin' : 'Fractal Bitcoin'} est indisponible ou a retourné une réponse invalide.` }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/brc20-prog/module/balance') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (!isAllowedOrigin(origin)) return Response.json({ error: 'Origine non autorisée pour consulter le solde BRC2.0.' }, { status: 403, headers: noStore });
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      try {
        const length = Number(request.headers.get('Content-Length') || '0');
        if (length > MAX_BRC20_PROG_BALANCE_BODY_BYTES) return Response.json({ error: 'Requête de solde BRC2.0 trop volumineuse.' }, { status: 413, headers: noStore });
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).length > MAX_BRC20_PROG_BALANCE_BODY_BYTES) return Response.json({ error: 'Requête de solde BRC2.0 trop volumineuse.' }, { status: 413, headers: noStore });
        const body = JSON.parse(rawBody);
        const chain = body?.chain || 'BITCOIN_MAINNET';
        if (chain !== 'BITCOIN_MAINNET') return Response.json({ error: 'BRC2.0 est disponible uniquement sur Bitcoin mainnet.' }, { status: 400, headers: noStore });
        const ticker = body?.ticker;
        const evmAddress = body?.evmAddress;
        if (typeof ticker !== 'string' || !/^[a-z0-9-]{6}$/i.test(ticker) || typeof evmAddress !== 'string' || !/^0x[a-f0-9]{40}$/i.test(evmAddress)) {
          return Response.json({ error: 'Ticker BRC20-Prog ou identité EVM invalide.' }, { status: 400, headers: noStore });
        }
        const rpcUrl = brc20ProgRpcUrl(env, chain);
        const rpcHeaders = brc20ProgRpcHeaders(env, chain);
        const upstream = await fetch(rpcUrl.toString(), {
          method: 'POST', headers: rpcHeaders, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'brc20-prog-balance', method: 'eth_call',
            params: [{ to: BRC20_PROG_CONTROLLER_ADDRESS, data: encodeBrc20ProgBalanceOf(ticker, evmAddress) }, 'latest'],
          }),
        });
        if (!upstream.ok) throw new Error('BRC2.0 RPC unavailable');
        const payload = await upstream.json();
        if (payload?.error || typeof payload?.result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(payload.result)) throw new Error('Invalid BRC2.0 balance response');
        return Response.json({ network: chain, ticker, evmAddress, balance: BigInt(payload.result).toString(10), decimals: 18, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        return Response.json({ error: 'Le solde du module BRC2.0 est indisponible ou la réponse RPC est invalide.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/brc20-prog/activation/broadcast') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (!isAllowedOrigin(origin)) return Response.json({ error: 'Origine non autorisée pour diffuser une activation BRC2.0.' }, { status: 403, headers: noStore });
      if (isRateLimited(request) || isBrc20ProgActivationRateLimited(request)) return Response.json({ error: 'Trop de tentatives de diffusion. Réessayez dans une minute.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      return broadcastBrc20ProgActivation(request, headers);
    }
    if (request.method === 'GET' && url.pathname === '/api/brc20/transferable') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const address = url.searchParams.get('address') || '';
      const ticker = url.searchParams.get('ticker') || '';
      const chain = url.searchParams.get('chain') || '';
      const start = parseBoundedInteger(url.searchParams.get('start'), 0, 10_000);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 100, 100);
      if (!validWalletAddress(address) || !/^[a-z0-9]{4,6}$/i.test(ticker) ||
          !['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) ||
          start === null || limit === null || limit < 1) {
        return Response.json({ error: 'Adresse, ticker BRC-20 classique, réseau ou pagination invalide.' }, { status: 400, headers: noStore });
      }
      const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
      const normalizeTransferable = rawDetail => {
        if (!Array.isArray(rawDetail)) throw new Error('Invalid UniSat transferable inscription list');
        return rawDetail.map(item => {
          if (typeof item?.inscriptionId !== 'string' || !/^[a-f0-9]{64}i\d+$/i.test(item.inscriptionId) ||
              typeof item?.data?.amt !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(item.data.amt) ||
              item.data.amt === '0' || /^0+\.0+$/.test(item.data.amt)) throw new Error('Invalid UniSat transferable inscription item');
          return { inscriptionId: item.inscriptionId.toLowerCase(), amount: item.data.amt };
        });
      };
      try {
        try {
          const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/brc20/${encodeURIComponent(ticker)}/transferable-inscriptions?start=${start}&limit=${limit}`, env, { signal: AbortSignal.timeout(8000) });
          const sourceStart = Number(source?.start ?? start);
          const normalized = normalizeTransferable(source?.detail);
          const total = Number(source?.total ?? normalized.length);
          if (!Number.isSafeInteger(sourceStart) || sourceStart !== start || !Number.isSafeInteger(total) || total < 0 || normalized.length > limit || total < start + normalized.length) throw new Error('Invalid UniSat transferable-inscriptions response');
          return Response.json({ network: chain, address, ticker, start, total, detail: normalized, refreshedAt: new Date().toISOString() }, { headers: noStore });
        } catch (cause) {
          if (start !== 0) throw cause;
          console.warn('UniSat transferable-inscriptions endpoint failed; trying address info fallback', { network: chain });
        }
        const info = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/brc20/${encodeURIComponent(ticker)}/info`, env, { signal: AbortSignal.timeout(8000) });
        const normalized = normalizeTransferable(info?.transferableInscriptions);
        const total = Number(info?.transferableCount ?? normalized.length);
        if (!Number.isSafeInteger(total) || total !== normalized.length) throw new Error('UniSat info fallback did not return a complete transferable-inscription list');
        return Response.json({ network: chain, address, ticker, start, total, detail: normalized.slice(start, start + limit), refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        console.warn('BRC-20 transferable lookup failed', { network: chain, start });
        return Response.json({ error: 'Les inscriptions BRC-20 transférables sont temporairement indisponibles sur l’indexeur UniSat.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && (url.pathname === '/api/brc20/balances' || url.pathname === '/api/alkanes/balances')) {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const address = url.searchParams.get('address') || '';
      const isBrc20 = url.pathname === '/api/brc20/balances';
      // Alkanes balance indexing is supported only on Bitcoin mainnet. Defaulting this
      // endpoint to Fractal sends requests to an unsupported UniSat route and produces a
      // misleading upstream 404. Reject explicit Fractal requests before contacting UniSat.
      const chain = url.searchParams.get('chain') || (isBrc20 ? '' : 'BITCOIN_MAINNET');
      if (!validWalletAddress(address) || !['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) return Response.json({ error: 'Adresse ou réseau invalide.' }, { status: 400, headers: noStore });
      if (!isBrc20 && chain !== 'BITCOIN_MAINNET') return Response.json({ error: 'Alkanes balance indexing is supported only on Bitcoin mainnet.', code: 'ALKANES_CHAIN_UNSUPPORTED' }, { status: 400, headers: noStore });
      const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
      try {
        const path = isBrc20
          ? `/v1/indexer/address/${encodeURIComponent(address)}/brc20/summary?start=0&limit=25&exclude_zero=true`
          : `/v1/indexer/address/${encodeURIComponent(address)}/alkanes/token-list?start=0&limit=100`;
        const source = await uniNetwork(base, path, env, { signal: AbortSignal.timeout(8000) });
        if (isBrc20 && !Array.isArray(source?.detail)) throw new Error('Invalid BRC-20 summary response');
        const detail = Array.isArray(source?.detail) ? source.detail : [];
        const normalized = detail.map(isBrc20 ? normalizeBrc20Balance : normalizeAlkaneBalance).filter(Boolean);
        if (isBrc20 && normalized.length !== detail.length) throw new Error('Invalid BRC-20 balance row');
        return Response.json({ network: chain, address, detail: normalized, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        console.warn(`${isBrc20 ? 'BRC20' : 'Alkanes'} balance lookup failed`, { chain });
        return Response.json({ error: `Les soldes ${isBrc20 ? 'BRC-20' : 'Alkanes'} sont temporairement indisponibles.` }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/alkanes/')) {
      const requestedChain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
      if (requestedChain !== 'BITCOIN_MAINNET') return Response.json({ error: 'Alkanes est disponible uniquement sur Bitcoin mainnet.' }, { status: 400, headers: { ...headers, 'Cache-Control': 'no-store' } });
    }
    if (request.method === 'GET' && ['/api/brc20/balance-list', '/api/alkanes/token-list', '/api/alkanes/collection-list', '/api/alkanes/utxo-list', '/api/runes/utxo-list'].includes(url.pathname)) {
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' } });
      return walletProtocolAssets(request, env, headers);
    }
    if (request.method === 'GET' && url.pathname === '/api/ordinals/address-list') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
      const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
      const address = url.searchParams.get('address') || '';
      const start = parseBoundedInteger(url.searchParams.get('start'), 0, 10_000);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 50, 50);
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) || !validWalletAddress(address) || start === null || limit === null || limit < 1) {
        return Response.json({ error: 'Réseau, adresse ou pagination Ordinals invalide.' }, { status: 400, headers: noStore });
      }
      try {
        // Use UniSat's documented address inscription endpoint. Its current response nests
        // the live output in item.utxo and exposes the inscription offset separately.
        const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/inscription-data?cursor=${start}&size=${limit}`, env, { signal: AbortSignal.timeout(8000) });
        const sourceStart = Number(source?.cursor ?? source?.start);
        const total = Number(source?.total);
        const sourceItems = Array.isArray(source?.inscription) ? source.inscription : source?.detail;
        if (!Number.isSafeInteger(sourceStart) || sourceStart !== start || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(sourceItems) || sourceItems.length > limit) throw new Error('Invalid UniSat Ordinals response');
        const detail = sourceItems.map(item => {
          const inscriptionId = typeof item?.inscriptionId === 'string' && /^[a-f0-9]{64}i\d+$/i.test(item.inscriptionId) ? item.inscriptionId.toLowerCase() : null;
          const utxo = item?.utxo && typeof item.utxo === 'object' ? item.utxo : null;
          const rawLocation = typeof item?.location === 'string' ? item.location : null;
          const txid = typeof utxo?.txid === 'string' && /^[a-f0-9]{64}$/i.test(utxo.txid) ? utxo.txid.toLowerCase() : null;
          const vout = Number(utxo?.vout);
          const offset = Number(item?.offset);
          const location = rawLocation && /^[a-f0-9]{64}:\d+:\d+$/i.test(rawLocation)
            ? rawLocation
            : txid && Number.isSafeInteger(vout) && vout >= 0 && Number.isSafeInteger(offset) && offset >= 0
              ? `${txid}:${vout}:${offset}`
              : null;
          const inscriptionNumber = item?.inscriptionNumber === null || item?.inscriptionNumber === undefined ? null : Number(item.inscriptionNumber);
          const rawOutputValue = item?.outputValue ?? utxo?.satoshi;
          const outputValue = rawOutputValue === null || rawOutputValue === undefined ? null : Number(rawOutputValue);
          if (!inscriptionId) return null;
          return { inscriptionId, inscriptionNumber: Number.isSafeInteger(inscriptionNumber) && inscriptionNumber >= 0 ? inscriptionNumber : null, location, outputValue: Number.isSafeInteger(outputValue) && outputValue >= 0 ? outputValue : null, contentType: typeof item?.contentType === 'string' ? item.contentType : null };
        });
        if (detail.some(item => item === null)) throw new Error('Invalid Ordinals item');
        return Response.json({ network: chain, address, start, total, detail, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch (error) {
        // Keep provider diagnostics useful without logging addresses, API keys, or response bodies.
        console.warn('Ordinals address lookup failed', {
          chain,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          reason: error instanceof Error ? error.message.slice(0, 120) : 'Unknown error',
        });
        return Response.json({ error: 'Les inscriptions Ordinals sont temporairement indisponibles.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/runes/balance-list') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
      const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
      const address = url.searchParams.get('address') || '';
      const start = parseBoundedInteger(url.searchParams.get('start'), 0, MAX_RUNES_OFFSET);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 20, MAX_RUNES_PAGE_SIZE);
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) || !validWalletAddress(address) || start === null || limit === null || limit < 1) {
        return Response.json({ error: 'Réseau, adresse ou pagination Runes invalide.' }, { status: 400, headers: noStore });
      }
      try {
        const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/runes/balance-list?start=${start}&limit=${limit}`, env, { signal: AbortSignal.timeout(8000) });
        const sourceStart = Number(source?.start);
        const total = Number(source?.total);
        if (!Number.isSafeInteger(sourceStart) || sourceStart !== start || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(source?.detail) || source.detail.length > limit) {
          throw new Error('Invalid UniSat Rune balance list response');
        }
        const detail = source.detail.map(normalizeRuneBalance);
        if (detail.some(item => item === null)) throw new Error('Invalid UniSat Rune balance item');
        return Response.json({ network: chain, address, start, total, detail, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        console.warn('Rune balance list lookup failed');
        return Response.json({ error: 'Les soldes Runes sont temporairement indisponibles.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/runes/balance') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
      const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
      const address = url.searchParams.get('address') || '';
      const runeid = url.searchParams.get('runeid') || '';
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain) || !validWalletAddress(address) || !validRuneId(runeid)) {
        return Response.json({ error: 'Réseau, adresse ou identifiant Rune invalide.' }, { status: 400, headers: noStore });
      }
      try {
        const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/runes/${encodeURIComponent(runeid)}/balance`, env, { signal: AbortSignal.timeout(8000) });
        const balance = normalizeRuneBalance(source);
        if (!balance || balance.runeid !== runeid) throw new Error('Invalid UniSat Rune balance response');
        return Response.json({ network: chain, address, balance, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch {
        console.warn('Rune balance lookup failed');
        return Response.json({ error: 'Le solde Rune est temporairement indisponible.' }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/address-utxos') {
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' } });
      return addressUtxos(request, env, headers);
    }
    if (request.method === 'GET' && url.pathname === '/api/utxo-balance-summary') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      const chain = url.searchParams.get('chain') || '';
      const address = url.searchParams.get('address') || '';
      if (!['fractal', 'bitcoin'].includes(chain) || !validWalletAddress(address)) {
        return Response.json({ error: 'Adresse ou réseau invalide.' }, { status: 400, headers: noStore });
      }
      const base = chain === 'bitcoin' ? BITCOIN_API_BASE : API_BASE;
      try {
        const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/available-balance?withLowFee=true`, env, { signal: AbortSignal.timeout(8000) });
        const fields = ['totalBalance', 'totalUtxoCount', 'availableBalance', 'availableUtxoCount', 'unavailableBalance', 'unavailableUtxoCount'];
        const values = Object.fromEntries(fields.map(key => [key, Number(source?.[key])]));
        if (fields.some(key => !Number.isSafeInteger(values[key]) || values[key] < 0) ||
            values.availableBalance + values.unavailableBalance !== values.totalBalance ||
            values.availableUtxoCount + values.unavailableUtxoCount !== values.totalUtxoCount) {
          throw new Error('Invalid UniSat available-balance response');
        }
        return Response.json({ chain, address, ...values, refreshedAt: new Date().toISOString() }, { headers: noStore });
      } catch (error) {
        const failure = error instanceof SpendableUtxoError ? error : null;
        const code = failure?.code || (String(error?.message || '').includes('quota') ? 'UTXO_SUMMARY_UNISAT_RATE_LIMITED' : 'UTXO_SUMMARY_UNISAT_UNAVAILABLE');
        return Response.json({ error: 'Le résumé des UTXO UniSat est temporairement indisponible.', code }, { status: 503, headers: noStore });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/spendable-utxos') {
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' } });
      try { return await spendableUtxos(request, env, headers); } catch (error) {
        const failure = error instanceof SpendableUtxoError ? error : new SpendableUtxoError('UTXO_SCAN_FAILED');
        const message = failure.status === 400
          ? 'Invalid spendable UTXO query.'
          : failure.code.endsWith('_UNISAT_RATE_LIMITED')
            ? 'UniSat API quota/rate limit reached. Retry later or configure a UniSat API key with available quota.'
            : 'Live UniSat data is temporarily unavailable.';
        if (failure.status !== 400) console.warn('Spendable UTXO lookup failed', { chain: url.searchParams.get('chain') || 'unknown', code: failure.code });
        return Response.json({ error: message, code: failure.code }, { status: failure.status, headers: { ...headers, 'Cache-Control': 'no-store' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/spendable-utxos/confirm') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (!isAllowedOrigin(origin)) return Response.json({ error: 'Origine non autorisée pour confirmer les UTXO.' }, { status: 403, headers: noStore });
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      try { return await confirmSpendableUtxos(request, env, headers); } catch (error) {
        const failure = error instanceof SpendableUtxoError ? error : new SpendableUtxoError('UTXO_CONFIRM_FAILED');
        const message = failure.status === 400 ? 'Invalid UTXO confirmation request.' : failure.status === 409 ? 'The selected UTXO set was not confirmed as safe and spendable.' : 'Live UniSat data is temporarily unavailable.';
        if (failure.status !== 400) console.warn('Spendable UTXO confirmation failed', { code: failure.code });
        return Response.json({ error: message, code: failure.code, ...(Array.isArray(failure.details?.missingOutpoints) ? { missingOutpoints: failure.details.missingOutpoints } : {}) }, { status: failure.status, headers: noStore });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/inscribe/order') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (!isAllowedOrigin(origin)) return Response.json({ error: 'Origine non autorisée pour créer une commande.' }, { status: 403, headers: noStore });
      if (isRateLimited(request) || isInscribeRateLimited(request)) return Response.json({ error: 'Trop de commandes. Réessayez dans une minute.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return Response.json({ error: 'Content-Type JSON requis.' }, { status: 415, headers: noStore });
      const contentLength = Number(request.headers.get('Content-Length') || 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_INSCRIBE_BODY_BYTES) return Response.json({ error: 'Le lot dépasse la taille maximale autorisée.' }, { status: 413, headers: noStore });
      try { return await inscribeOrder(request, env, headers); }
      catch (error) {
        if (error instanceof InscribeRequestError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
        console.warn('UniSat inscription order creation failed');
        return Response.json({ error: 'UniSat n’a pas pu créer la commande. Vérifiez le réseau, le fichier et le fee rate, puis réessayez.' }, { status: 502, headers: noStore });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/inscribe/order/cancel') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (!isAllowedOrigin(origin)) return Response.json({ error: 'Origine non autorisée pour annuler une commande.' }, { status: 403, headers: noStore });
      if (isRateLimited(request) || isInscribeRateLimited(request)) return Response.json({ error: 'Trop de commandes. Réessayez dans une minute.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return Response.json({ error: 'Content-Type JSON requis.' }, { status: 415, headers: noStore });
      return await cancelInscribeOrder(request, env, headers);
    }
    if (request.method === 'GET' && url.pathname === '/api/inscribe/order') {
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' } });
      try { return await inscribeOrderStatus(request, env, headers); } catch { return Response.json({ error: 'Unable to read the UniSat inscription order.' }, { status: 502, headers: { ...headers, 'Cache-Control': 'no-store' } }); }
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...headers, Allow: 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname !== '/api/market' && url.pathname !== '/api/live-inscription') {
      return new Response('Not found', { status: 404, headers });
    }
    try {
      if (url.pathname === '/api/market') {
        const collectionId = url.searchParams.get('collectionId') || '';
        const start = parseBoundedInteger(url.searchParams.get('start'), 0, MAX_MARKET_OFFSET);
        const limit = parseBoundedInteger(url.searchParams.get('limit'), MAX_PAGE_SIZE, MAX_PAGE_SIZE);
        if (!ALLOWED_COLLECTION_IDS.has(collectionId) || start === null || limit === null || limit < 1) {
          // Invalid traffic still consumes the request budget to prevent abuse.
          if (isRateLimited(request)) {
            return Response.json({ error: 'Too many requests.' }, {
              status: 429,
              headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' },
            });
          }
          return Response.json({ error: 'Invalid market query.' }, {
            status: 400,
            headers: { ...headers, 'Cache-Control': 'no-store' },
          });
        }
        // Rate-limit only cache misses: cached public market reads must not consume
        // the same per-IP budget used by wallet and transaction preparation routes.
        return edgeCachedResponse(request, headers, 60, 300, async () => {
          if (isRateLimited(request)) {
            return Response.json({ error: 'Too many requests.' }, {
              status: 429,
              headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' },
            });
          }
          return Response.json(await market(collectionId, start, limit, env), { headers });
        });
      }

      const inscriptionId = url.searchParams.get('inscriptionId') || '';
      if (!/^[a-f0-9]{64}i\d+$/.test(inscriptionId)) {
        return Response.json({ error: 'A valid inscription ID is required.' }, {
          status: 400,
          headers: { ...headers, 'Cache-Control': 'no-store' },
        });
      }
      const chain = url.searchParams.get('chain') || 'FRACTAL_BITCOIN_MAINNET';
      if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) {
        return Response.json({ error: 'Unsupported mainnet.' }, { status: 400, headers: { ...headers, 'Cache-Control': 'no-store' } });
      }
      if (url.searchParams.get('refresh') === '1') {
        if (isRateLimited(request)) {
          return Response.json({ error: 'Too many requests.' }, {
            status: 429,
            headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' },
          });
        }
        return Response.json(await inscription(inscriptionId, env, chain), {
          headers: { ...headers, 'Cache-Control': 'no-store', 'X-Edge-Cache': 'BYPASS' },
        });
      }
      // Cached public inscription reads bypass the per-IP limit; only cache misses count.
      return edgeCachedResponse(request, headers, 120, 300, async () => {
        if (isRateLimited(request)) {
          return Response.json({ error: 'Too many requests.' }, {
            status: 429,
            headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' },
          });
        }
        return Response.json(await inscription(inscriptionId, env, chain), { headers });
      });
    } catch {
      console.warn('Live API upstream request failed', url.pathname);
      return Response.json({ error: 'Live UniSat data is temporarily unavailable.' }, {
        status: 503,
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    }
  },
};