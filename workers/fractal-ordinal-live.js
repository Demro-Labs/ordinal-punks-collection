const API_BASE = 'https://open-api-fractal.unisat.io';
const BITCOIN_API_BASE = 'https://open-api.unisat.io';
const ALLOWED_ORIGINS = new Set([
  'https://demro-labs.github.io',
  'https://punksgallery-mlwdpcwl.manus.space',
]);
const ALLOWED_COLLECTION_IDS = new Set(['opunk', 'pokedex']);
const SATS = 100000000;
const MAX_MARKET_OFFSET = 10000;
const MAX_PAGE_SIZE = 20;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_REQUESTS = 180;
const rateBuckets = new Map();
const INSCRIBE_RATE_WINDOW_MS = 60_000;
const INSCRIBE_RATE_LIMIT = 5;
const inscribeBuckets = new Map();
const HUMAN_SESSION_URL = 'https://turnstile-human-verification.servostar23.workers.dev/api/session';
const HUMAN_ACTIONS = new Set(['ordinal-punks', 'pokedex']);
const MAX_INSCRIBE_FILES = 100;
const MAX_INSCRIBE_FILE_BYTES = 365 * 1024;
const MAX_INSCRIBE_BODY_BYTES = 50_000_000;

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
    'Access-Control-Allow-Headers': 'Accept, Content-Type, X-Human-Action, X-Human-Proof',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
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

async function verifyHumanSession(action, proof) {
  if (!HUMAN_ACTIONS.has(action) || typeof proof !== 'string' || proof.length < 1 || proof.length > 2048) return false;
  const response = await fetch(HUMAN_SESSION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://demro-labs.github.io' },
    body: JSON.stringify({ action, proof }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Cloudflare verification service unavailable');
  const result = await response.json();
  return result?.valid === true;
}

function parseBoundedInteger(raw, fallback, maximum) {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

async function uni(path, env, init = {}) {
  if (!env.UNISAT_API_KEY) throw new Error('UniSat server binding is missing');
  const response = await fetch(API_BASE + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + env.UNISAT_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error('UniSat upstream returned ' + response.status);
  const payload = await response.json();
  if (payload.code !== 0) throw new Error('UniSat upstream rejected the request');
  return payload.data;
}

async function uniNetwork(base, path, env, init = {}) {
  if (!env.UNISAT_API_KEY) throw new Error('UniSat server binding is missing');
  const response = await fetch(base + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + env.UNISAT_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error('UniSat upstream returned ' + response.status);
  const payload = await response.json();
  if (payload.code !== 0) throw new Error('UniSat upstream rejected the request');
  return payload.data;
}

function selectedFeeRate(fees) {
  const value = Number(fees?.halfHourFee ?? fees?.fastestFee ?? fees?.hourFee ?? fees?.economyFee ?? fees?.minimumFee);
  if (!Number.isFinite(value) || value <= 0 || value > 10000) return null;
  return Math.max(1, Math.ceil(value));
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

async function spendableUtxos(request, env, corsHeaders) {
  const url = new URL(request.url);
  const chain = url.searchParams.get('chain') || '';
  const address = url.searchParams.get('address') || '';
  const cursor = parseBoundedInteger(url.searchParams.get('cursor'), 0, 1000000);
  const requestedSize = parseBoundedInteger(url.searchParams.get('size'), 50, 50);
  if (!['bitcoin', 'fractal'].includes(chain) || !validWalletAddress(address) || cursor === null || requestedSize === null || requestedSize < 1) throw new Error('Invalid spendable UTXO query.');
  const base = chain === 'bitcoin' ? BITCOIN_API_BASE : API_BASE;
  const source = await uniNetwork(base, `/v1/indexer/address/${encodeURIComponent(address)}/available-utxo-data?cursor=${cursor}&size=${requestedSize}`, env);
  const raw = Array.isArray(source?.utxo) ? source.utxo : [];
  const checked = [];
  for (const item of raw.slice(0, 25)) {
    const txid = typeof item?.txid === 'string' ? item.txid.toLowerCase() : '';
    const vout = Number(item?.vout);
    const satoshi = Number(item?.satoshi);
    const scriptPk = typeof item?.scriptPk === 'string' ? item.scriptPk.toLowerCase() : '';
    const height = Number(item?.height);
    if (item?.address !== address || !/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0 || !Number.isSafeInteger(satoshi) || satoshi < 600 || !/^(?:[a-f0-9]{2})+$/.test(scriptPk) || !Number.isSafeInteger(height) || height <= 0 || item?.isLowFee === true || item?.isOpInRBF === true || !Array.isArray(item?.inscriptions) || item.inscriptions.length !== 0) continue;
    const detail = await uniNetwork(base, `/v1/indexer/utxo/${txid}/${vout}`, env);
    if (detail?.address !== address || Number(detail?.satoshi) !== satoshi || String(detail?.scriptPk || '').toLowerCase() !== scriptPk || detail?.spent === true || (Array.isArray(detail?.inscriptions) && detail.inscriptions.length !== 0)) continue;
    checked.push({ address, txid, vout, satoshi, scriptPk, height, isLowFee: false, isOpInRBF: false, inscriptions: [], protocolAssetsChecked: true });
  }
  return Response.json({ chain, address, cursor, nextCursor: cursor + raw.length, total: Number.isSafeInteger(source?.total) ? source.total : cursor + raw.length, scannedCount: raw.length, utxo: checked }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
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

async function inscription(inscriptionId, env) {
  const genesisTxid = inscriptionId.split('i')[0];
  const [info, listing, inputs] = await Promise.all([
    uni('/v1/indexer/inscription/info/' + inscriptionId, env),
    uni('/v3/market/collection/auction/inscription_info', env, {
      method: 'POST',
      body: JSON.stringify({ inscriptionId }),
    }),
    /^[a-f0-9]{64}$/.test(genesisTxid)
      ? uni('/v1/indexer/tx/' + genesisTxid + '/ins?cursor=0&size=100', env)
      : Promise.resolve([]),
  ]);
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

async function inscribeOrder(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { throw new InscribeRequestError('Corps JSON invalide.'); }
  const filesInput = Array.isArray(body?.files) ? body.files : (body?.file ? [body.file] : []);
  const requestedFeeRate = body?.feeRate == null ? 0 : Number(body.feeRate);
  const outputValue = Number(body?.outputValue ?? 546);
  const chain = body?.chain || 'FRACTAL_BITCOIN_MAINNET';
  if (!['BITCOIN_MAINNET', 'FRACTAL_BITCOIN_MAINNET'].includes(chain)) throw new InscribeRequestError('Réseau d’inscription non pris en charge.');
  if (!validAddress(body?.receiver) || !validAddress(body?.refundAddress) || !validAddress(body?.userAddress) || !validPubkey(body?.userPubkey)) throw new InscribeRequestError('Adresse de wallet ou clé publique invalide.');
  if ((requestedFeeRate !== 0 && (!Number.isSafeInteger(requestedFeeRate) || requestedFeeRate < 1 || requestedFeeRate > 10000)) || outputValue !== 546) throw new InscribeRequestError('Fee rate ou valeur de sortie invalide.');
  if (!filesInput.length || filesInput.length > MAX_INSCRIBE_FILES) throw new InscribeRequestError(`La commande doit contenir de 1 à ${MAX_INSCRIBE_FILES} fichiers.`);
  const files = filesInput.map(validateInscribeFile);
  const feeEstimate = await recommendedFeeEstimate(chain, env);
  const feeRate = feeEstimate.feeRate;
  const base = chain === 'BITCOIN_MAINNET' ? BITCOIN_API_BASE : API_BASE;
  const upstream = await uniNetwork(base, '/v5/inscribe/order/create', env, { method: 'POST', body: JSON.stringify({ clientId: 'demro-labs-gallery', receiver: body.receiver, refundAddress: body.refundAddress, userAddress: body.userAddress, userPubkey: body.userPubkey, feeRate, outputValue, files }) });
  if (!upstream?.orderId || !upstream?.payAddress || !Number.isSafeInteger(Number(upstream?.amount))) throw new Error('UniSat returned an incomplete inscription order.');
  return Response.json({ orderId: upstream.orderId, status: upstream.status, payAddress: upstream.payAddress, amount: Number(upstream.amount), network: chain, feeRate, feeTarget: feeEstimate.target, feeSources: feeEstimate.sources, feeStrategy: feeEstimate.strategy }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
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

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response('Forbidden', { status: 403, headers });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
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
    if (request.method === 'GET' && url.pathname === '/api/spendable-utxos') {
      if (isRateLimited(request)) return Response.json({ error: 'Too many requests.' }, { status: 429, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' } });
      try { return await spendableUtxos(request, env, headers); } catch { return Response.json({ error: 'Live UniSat data is temporarily unavailable.' }, { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/inscribe/order') {
      const noStore = { ...headers, 'Cache-Control': 'no-store' };
      if (origin !== 'https://demro-labs.github.io') return Response.json({ error: 'Origine non autorisée pour créer une commande.' }, { status: 403, headers: noStore });
      if (isRateLimited(request) || isInscribeRateLimited(request)) return Response.json({ error: 'Trop de commandes. Réessayez dans une minute.' }, { status: 429, headers: { ...noStore, 'Retry-After': '60' } });
      if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return Response.json({ error: 'Content-Type JSON requis.' }, { status: 415, headers: noStore });
      const contentLength = Number(request.headers.get('Content-Length') || 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_INSCRIBE_BODY_BYTES) return Response.json({ error: 'Le lot dépasse la taille maximale autorisée.' }, { status: 413, headers: noStore });
      const action = request.headers.get('X-Human-Action') || '';
      const proof = request.headers.get('X-Human-Proof') || '';
      try {
        if (!await verifyHumanSession(action, proof)) return Response.json({ error: 'Terminez la vérification Cloudflare du site avant de créer une commande.' }, { status: 403, headers: noStore });
      } catch {
        return Response.json({ error: 'Le service de vérification Cloudflare est temporairement indisponible.' }, { status: 503, headers: noStore });
      }
      try { return await inscribeOrder(request, env, headers); }
      catch (error) {
        if (error instanceof InscribeRequestError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
        console.warn('UniSat inscription order creation failed');
        return Response.json({ error: 'UniSat n’a pas pu créer la commande. Vérifiez le réseau, le fichier et le fee rate, puis réessayez.' }, { status: 502, headers: noStore });
      }
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
    if (isRateLimited(request)) {
      return Response.json({ error: 'Too many requests.' }, {
        status: 429,
        headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': '60' },
      });
    }

    try {
      if (url.pathname === '/api/market') {
        const collectionId = url.searchParams.get('collectionId') || '';
        const start = parseBoundedInteger(url.searchParams.get('start'), 0, MAX_MARKET_OFFSET);
        const limit = parseBoundedInteger(url.searchParams.get('limit'), MAX_PAGE_SIZE, MAX_PAGE_SIZE);
        if (!ALLOWED_COLLECTION_IDS.has(collectionId) || start === null || limit === null || limit < 1) {
          return Response.json({ error: 'Invalid market query.' }, {
            status: 400,
            headers: { ...headers, 'Cache-Control': 'no-store' },
          });
        }
        return edgeCachedResponse(request, headers, 20, 60, async () => Response.json(await market(collectionId, start, limit, env), { headers }));
      }

      const inscriptionId = url.searchParams.get('inscriptionId') || '';
      if (!/^[a-f0-9]{64}i\d+$/.test(inscriptionId)) {
        return Response.json({ error: 'A valid Fractal inscription ID is required.' }, {
          status: 400,
          headers: { ...headers, 'Cache-Control': 'no-store' },
        });
      }
      return edgeCachedResponse(request, headers, 120, 300, async () => Response.json(await inscription(inscriptionId, env), { headers }));
    } catch {
      console.warn('Live API upstream request failed', url.pathname);
      return Response.json({ error: 'Live UniSat data is temporarily unavailable.' }, {
        status: 503,
        headers: { ...headers, 'Cache-Control': 'no-store' },
      });
    }
  },
};
