import { Buffer } from 'buffer';
import { Address, Verifier } from '@exodus/bip322-js';

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

const AUTH_SITES = {
  punks: {
    origin: 'https://demro-labs.github.io',
    domain: 'demro-labs.github.io',
    uri: 'https://demro-labs.github.io/ordinal-punks-collection/',
    cookie: '__Host-demro-punks-auth',
  },
  pokedex: {
    origin: 'https://demro-labs.github.io',
    domain: 'demro-labs.github.io',
    uri: 'https://demro-labs.github.io/fractal-pokedex-ordinal-ledger/',
    cookie: '__Host-demro-pokedex-auth',
  },
};

const AUTH_NETWORK = 'FRACTAL_BITCOIN_MAINNET';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADDRESS_RATE_WINDOW_MS = 60 * 60 * 1000;
const ADDRESS_RATE_LIMIT = 6;
const IP_RATE_WINDOW_MS = 15 * 60 * 1000;
const IP_RATE_LIMITS = { challenge: 8, verify: 20, session: 120, logout: 20 };
const authIpBuckets = new Map();
const MAX_AUTH_BODY_BYTES = 12_000;

class AuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

function bytesToHex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function randomToken(bytes = 32) {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(random).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isValidChallengeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isValidAddress(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase()) return false;
  try {
    const script = Address.convertAdressToScriptPubkey(value);
    if (value.startsWith('bc1q')) return value.length === 42 && Address.isP2WPKH(value) && script?.byteLength === 22;
    if (value.startsWith('bc1p')) return value.length === 62 && Address.isP2TR(value) && script?.byteLength === 34;
    return false;
  } catch {
    return false;
  }
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
    throw new AuthError('AUTH_JSON_REQUIRED', 415);
  }
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_BODY_BYTES) throw new AuthError('AUTH_BODY_TOO_LARGE', 413);
  if (!request.body) throw new AuthError('AUTH_INVALID_JSON', 400);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_AUTH_BODY_BYTES) {
      await reader.cancel();
      throw new AuthError('AUTH_BODY_TOO_LARGE', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new AuthError('AUTH_INVALID_JSON', 400);
  }
}

async function checkIpRateLimit(request, action) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `${action}:${await sha256Hex(ip)}`;
  const now = Date.now();
  let bucket = authIpBuckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    if (authIpBuckets.size >= 10_000) {
      for (const [oldKey, oldBucket] of authIpBuckets) {
        if (oldBucket.expiresAt <= now) authIpBuckets.delete(oldKey);
      }
      if (authIpBuckets.size >= 10_000) return true;
    }
    bucket = { count: 0, expiresAt: now + IP_RATE_WINDOW_MS };
    authIpBuckets.set(key, bucket);
  }
  if (bucket.count >= IP_RATE_LIMITS[action]) return true;
  bucket.count += 1;
  return false;
}

async function rateIpHash(request, windowStart) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256Hex(`${ip}:${windowStart}`);
}

async function consumeDurableIpRate(env, request, action, now) {
  const windowStart = Math.floor(now / IP_RATE_WINDOW_MS) * IP_RATE_WINDOW_MS;
  const ipHash = await rateIpHash(request, windowStart);
  const result = await authStorage(env, 'rate/ip', {
    ipHash,
    action,
    windowStart,
    now,
    limit: IP_RATE_LIMITS[action],
  });
  if (!result?.allowed) throw new AuthError('AUTH_IP_RATE_LIMITED', 429);
}

function siteForRequest(siteName, request) {
  const site = AUTH_SITES[siteName];
  const origin = request.headers.get('Origin') || '';
  if (!site || origin !== site.origin) throw new AuthError('AUTH_ORIGIN_NOT_ALLOWED', 403);
  return site;
}

function buildChallengeMessage(siteName, address, challengeId, issuedAt, expiresAt) {
  const site = AUTH_SITES[siteName];
  return [
    `${site.domain} requests a wallet sign-in`,
    `URI: ${site.uri}`,
    `Network: ${AUTH_NETWORK}`,
    `Address: ${address}`,
    'Action: Login; prove wallet control only',
    `Nonce: ${challengeId}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    'No payment, transfer, or spending approval is authorized.',
  ].join('\n');
}

async function authStorage(env, operation, payload) {
  if (!env?.AUTH_STORAGE) throw new AuthError('AUTH_STORAGE_UNAVAILABLE', 503);
  try {
    const id = env.AUTH_STORAGE.idFromName('wallet-auth-v1');
    const stub = env.AUTH_STORAGE.get(id);
    const response = await stub.fetch(new Request(`https://auth.internal/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    let result = {};
    try { result = await response.json(); } catch { /* handled as a generic storage failure below */ }
    if (!response.ok) {
      if (response.status === 429) throw new AuthError(result?.code === 'AUTH_IP_RATE_LIMITED' ? 'AUTH_IP_RATE_LIMITED' : 'AUTH_ADDRESS_RATE_LIMITED', 429);
      if (response.status === 404 && operation === 'challenge/get') return null;
      if (response.status === 409 && operation === 'challenge/consume') return { created: false };
      throw new AuthError('AUTH_STORAGE_UNAVAILABLE', 503);
    }
    return result;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('AUTH_STORAGE_UNAVAILABLE', 503);
  }
}

function responseHeaders(headers) {
  return { ...headers, 'Cache-Control': 'no-store', Pragma: 'no-cache' };
}

function errorResponse(error, headers) {
  const failure = error instanceof AuthError ? error : new AuthError('AUTH_SERVICE_UNAVAILABLE', 503);
  const messages = {
    AUTH_JSON_REQUIRED: 'This endpoint requires an application/json request.',
    AUTH_BODY_TOO_LARGE: 'The authentication request is too large.',
    AUTH_INVALID_JSON: 'The authentication request is invalid.',
    AUTH_ORIGIN_NOT_ALLOWED: 'This site origin is not allowed to authenticate.',
    AUTH_INVALID_SITE: 'The requested site is not supported.',
    AUTH_INVALID_NETWORK: 'Select Fractal Bitcoin mainnet in UniSat to sign in.',
    AUTH_INVALID_ADDRESS: 'Use a supported mainnet SegWit or Taproot address in UniSat.',
    AUTH_INVALID_CHALLENGE: 'The challenge is invalid, expired, or already used. Request a new challenge.',
    AUTH_INVALID_SIGNATURE: 'UniSat did not return a valid BIP-322 simple signature.',
    AUTH_SIGNATURE_REJECTED: 'The signature does not prove control of this address.',
    AUTH_ADDRESS_RATE_LIMITED: 'Too many sign-in attempts for this address. Try again later.',
    AUTH_IP_RATE_LIMITED: 'Too many sign-in requests from this connection. Try again later.',
    AUTH_STORAGE_UNAVAILABLE: 'The secure authentication service is temporarily unavailable.',
    AUTH_SERVICE_UNAVAILABLE: 'The authentication service is temporarily unavailable.',
  };
  const status = failure.status;
  const retryAfter = failure.code === 'AUTH_ADDRESS_RATE_LIMITED' ? '3600' : '900';
  const extraHeaders = status === 429 ? { 'Retry-After': retryAfter } : {};
  return Response.json({ error: messages[failure.code] || messages.AUTH_SERVICE_UNAVAILABLE, code: failure.code }, {
    status,
    headers: { ...responseHeaders(headers), ...extraHeaders },
  });
}

async function decodeWitness(signature) {
  if (typeof signature !== 'string' || signature.length < 8 || signature.length > 8192) return null;
  const candidates = [signature];
  if (signature.startsWith('smp')) candidates.push(signature.slice(3));
  for (const candidate of candidates) {
    const base64 = candidate.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) continue;
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64');
    if (decoded.byteLength < 1 || decoded.byteLength > 4096 || decoded.toString('base64') !== padded) continue;
    return decoded;
  }
  return null;
}

async function createChallenge(request, env, headers) {
  const now = Date.now();
  if (await checkIpRateLimit(request, 'challenge')) throw new AuthError('AUTH_IP_RATE_LIMITED', 429);
  await consumeDurableIpRate(env, request, 'challenge', now);
  const body = await readJson(request);
  const siteName = body.site;
  if (!AUTH_SITES[siteName]) throw new AuthError('AUTH_INVALID_SITE', 400);
  const site = siteForRequest(siteName, request);
  if (body.network !== AUTH_NETWORK) throw new AuthError('AUTH_INVALID_NETWORK', 400);
  if (!isValidAddress(body.address)) throw new AuthError('AUTH_INVALID_ADDRESS', 400);
  const expiresAt = now + CHALLENGE_TTL_MS;
  const challengeId = randomToken();
  const idHash = await sha256Hex(challengeId);
  const addressHash = await sha256Hex(body.address);
  const stored = await authStorage(env, 'challenge/create', {
    idHash,
    site: siteName,
    address: body.address,
    addressHash,
    network: AUTH_NETWORK,
    origin: site.origin,
    issuedAt: now,
    expiresAt,
    now,
    rateWindowStart: Math.floor(now / ADDRESS_RATE_WINDOW_MS) * ADDRESS_RATE_WINDOW_MS,
  });
  if (!stored?.created) throw new AuthError('AUTH_STORAGE_UNAVAILABLE', 503);

  return Response.json({
    challengeId,
    message: buildChallengeMessage(siteName, body.address, challengeId, now, expiresAt),
    expiresAt: new Date(expiresAt).toISOString(),
    network: AUTH_NETWORK,
    site: siteName,
  }, { headers: responseHeaders(headers) });
}

async function verifyChallenge(request, env, headers) {
  const now = Date.now();
  if (await checkIpRateLimit(request, 'verify')) throw new AuthError('AUTH_IP_RATE_LIMITED', 429);
  await consumeDurableIpRate(env, request, 'verify', now);
  const body = await readJson(request);
  const siteName = body.site;
  if (!AUTH_SITES[siteName]) throw new AuthError('AUTH_INVALID_SITE', 400);
  const site = siteForRequest(siteName, request);
  if (body.network !== AUTH_NETWORK) throw new AuthError('AUTH_INVALID_NETWORK', 400);
  if (!isValidAddress(body.address)) throw new AuthError('AUTH_INVALID_ADDRESS', 400);
  if (!isValidChallengeId(body.challengeId)) throw new AuthError('AUTH_INVALID_CHALLENGE', 400);
  const witness = await decodeWitness(body.signature);
  if (!witness) throw new AuthError('AUTH_INVALID_SIGNATURE', 400);
  const idHash = await sha256Hex(body.challengeId);
  const challenge = await authStorage(env, 'challenge/get', { idHash });
  if (!challenge || challenge.site !== siteName || challenge.address !== body.address || challenge.network !== AUTH_NETWORK || challenge.origin !== site.origin || challenge.usedAt || Number(challenge.expiresAt) <= now) {
    throw new AuthError('AUTH_INVALID_CHALLENGE', 401);
  }

  const message = buildChallengeMessage(siteName, body.address, body.challengeId, Number(challenge.issuedAt), Number(challenge.expiresAt));
  let valid = false;
  try { valid = await Verifier.verifySignature(body.address, message, witness); } catch { valid = false; }
  if (!valid) throw new AuthError('AUTH_SIGNATURE_REJECTED', 401);

  const sessionToken = randomToken();
  const tokenHash = await sha256Hex(sessionToken);
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const consumed = await authStorage(env, 'challenge/consume', {
    idHash,
    tokenHash,
    site: siteName,
    address: body.address,
    network: AUTH_NETWORK,
    now: createdAt,
    expiresAt,
  });
  if (!consumed?.created) throw new AuthError('AUTH_INVALID_CHALLENGE', 401);

  const cookie = `${site.cookie}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return Response.json({
    session: { site: siteName, address: body.address, network: AUTH_NETWORK, createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() },
  }, { headers: { ...responseHeaders(headers), 'Set-Cookie': cookie } });
}

function readCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

async function getSession(request, env, headers) {
  if (await checkIpRateLimit(request, 'session')) throw new AuthError('AUTH_IP_RATE_LIMITED', 429);
  const url = new URL(request.url);
  const siteName = url.searchParams.get('site') || '';
  if (!AUTH_SITES[siteName]) throw new AuthError('AUTH_INVALID_SITE', 400);
  const site = siteForRequest(siteName, request);
  const token = readCookie(request, site.cookie);
  if (!token || token.length > 128) return Response.json({ session: null }, { headers: responseHeaders(headers) });
  const tokenHash = await sha256Hex(token);
  const result = await authStorage(env, 'session/get', { tokenHash, site: siteName, now: Date.now() });
  return Response.json({ session: result?.session || null }, { headers: responseHeaders(headers) });
}

async function logout(request, env, headers) {
  if (await checkIpRateLimit(request, 'logout')) throw new AuthError('AUTH_IP_RATE_LIMITED', 429);
  const body = await readJson(request);
  const siteName = body.site;
  if (!AUTH_SITES[siteName]) throw new AuthError('AUTH_INVALID_SITE', 400);
  const site = siteForRequest(siteName, request);
  const token = readCookie(request, site.cookie);
  if (token && token.length <= 128) {
    const tokenHash = await sha256Hex(token);
    await authStorage(env, 'session/delete', { tokenHash, site: siteName });
  }
  const clearCookie = `${site.cookie}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  return Response.json({ ok: true }, { headers: { ...responseHeaders(headers), 'Set-Cookie': clearCookie } });
}

export async function handleWalletAuth(request, env, headers) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/auth/')) return null;
  try {
    if (request.method === 'POST' && url.pathname === '/api/auth/challenge') return await createChallenge(request, env, headers);
    if (request.method === 'POST' && url.pathname === '/api/auth/verify') return await verifyChallenge(request, env, headers);
    if (request.method === 'GET' && url.pathname === '/api/auth/session') return await getSession(request, env, headers);
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') return await logout(request, env, headers);
    return new Response('Not found', { status: 404, headers: responseHeaders(headers) });
  } catch (error) {
    return errorResponse(error, headers);
  }
}

export class AuthStorage {
  constructor(ctx) {
    this.ctx = ctx;
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS auth_challenges (id_hash TEXT PRIMARY KEY, site TEXT NOT NULL, address TEXT NOT NULL, address_hash TEXT NOT NULL, network TEXT NOT NULL, origin TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)');
    sql.exec('CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges(expires_at)');
    sql.exec('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, site TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at)');
    sql.exec('CREATE INDEX IF NOT EXISTS auth_sessions_wallet_idx ON auth_sessions(site, address)');
    sql.exec('CREATE TABLE IF NOT EXISTS auth_address_rates (address_hash TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (address_hash, window_start))');
    sql.exec('CREATE TABLE IF NOT EXISTS auth_ip_rates (ip_hash TEXT NOT NULL, action TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip_hash, action, window_start))');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    let body;
    try { body = await request.json(); } catch { return Response.json({ code: 'INVALID_INTERNAL_JSON' }, { status: 400 }); }
    const sql = this.ctx.storage.sql;

    if (url.pathname === '/challenge/create') {
      const result = this.ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM auth_challenges WHERE expires_at <= ?', body.now);
        sql.exec('DELETE FROM auth_sessions WHERE expires_at <= ?', body.now);
        sql.exec('DELETE FROM auth_address_rates WHERE window_start < ?', body.now - 24 * ADDRESS_RATE_WINDOW_MS);
        sql.exec('DELETE FROM auth_ip_rates WHERE window_start < ?', body.now - 24 * IP_RATE_WINDOW_MS);
        const row = sql.exec('SELECT count FROM auth_address_rates WHERE address_hash = ? AND window_start = ?', body.addressHash, body.rateWindowStart).toArray()[0];
        if (Number(row?.count || 0) >= ADDRESS_RATE_LIMIT) return { created: false, code: 'AUTH_ADDRESS_RATE_LIMITED' };
        sql.exec('INSERT INTO auth_address_rates (address_hash, window_start, count) VALUES (?, ?, 1) ON CONFLICT(address_hash, window_start) DO UPDATE SET count = count + 1', body.addressHash, body.rateWindowStart);
        sql.exec('INSERT INTO auth_challenges (id_hash, site, address, address_hash, network, origin, issued_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)', body.idHash, body.site, body.address, body.addressHash, body.network, body.origin, body.issuedAt, body.expiresAt);
        return { created: true };
      });
      if (!result.created) return Response.json({ code: result.code }, { status: 429 });
      return Response.json(result);
    }

    if (url.pathname === '/rate/ip') {
      const result = this.ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM auth_ip_rates WHERE window_start < ?', body.now - 24 * IP_RATE_WINDOW_MS);
        const row = sql.exec('SELECT count FROM auth_ip_rates WHERE ip_hash = ? AND action = ? AND window_start = ?', body.ipHash, body.action, body.windowStart).toArray()[0];
        if (Number(row?.count || 0) >= Number(body.limit)) return { allowed: false };
        sql.exec('INSERT INTO auth_ip_rates (ip_hash, action, window_start, count) VALUES (?, ?, ?, 1) ON CONFLICT(ip_hash, action, window_start) DO UPDATE SET count = count + 1', body.ipHash, body.action, body.windowStart);
        return { allowed: true };
      });
      return Response.json(result, { status: result.allowed ? 200 : 429, headers: result.allowed ? {} : { 'Retry-After': '900' } });
    }

    if (url.pathname === '/challenge/get') {
      const row = sql.exec('SELECT site, address, network, origin, issued_at AS issuedAt, expires_at AS expiresAt, used_at AS usedAt FROM auth_challenges WHERE id_hash = ?', body.idHash).toArray()[0];
      if (!row) return Response.json({ code: 'AUTH_CHALLENGE_NOT_FOUND' }, { status: 404 });
      return Response.json(row);
    }

    if (url.pathname === '/challenge/consume') {
      const result = this.ctx.storage.transactionSync(() => {
        const row = sql.exec('SELECT site, address, network, expires_at AS expiresAt, used_at AS usedAt FROM auth_challenges WHERE id_hash = ?', body.idHash).toArray()[0];
        if (!row || row.usedAt || Number(row.expiresAt) <= Number(body.now) || row.site !== body.site || row.address !== body.address || row.network !== body.network) return { created: false };
        sql.exec('UPDATE auth_challenges SET used_at = ? WHERE id_hash = ? AND used_at IS NULL AND expires_at > ?', body.now, body.idHash, body.now);
        const changed = Number(sql.exec('SELECT changes() AS changes').toArray()[0]?.changes || 0);
        if (changed !== 1) return { created: false };
        sql.exec('DELETE FROM auth_sessions WHERE site = ? AND address = ?', body.site, body.address);
        sql.exec('INSERT INTO auth_sessions (token_hash, site, address, network, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', body.tokenHash, body.site, body.address, body.network, body.now, body.expiresAt);
        return { created: true };
      });
      return Response.json(result, { status: result.created ? 200 : 409 });
    }

    if (url.pathname === '/session/get') {
      const row = sql.exec('SELECT site, address, network, created_at AS createdAt, expires_at AS expiresAt FROM auth_sessions WHERE token_hash = ? AND site = ?', body.tokenHash, body.site).toArray()[0];
      if (!row || Number(row.expiresAt) <= Number(body.now)) {
        if (row) sql.exec('DELETE FROM auth_sessions WHERE token_hash = ? AND site = ?', body.tokenHash, body.site);
        return Response.json({ session: null });
      }
      return Response.json({ session: { ...row, createdAt: new Date(Number(row.createdAt)).toISOString(), expiresAt: new Date(Number(row.expiresAt)).toISOString() } });
    }

    if (url.pathname === '/session/delete') {
      sql.exec('DELETE FROM auth_sessions WHERE token_hash = ? AND site = ?', body.tokenHash, body.site);
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
