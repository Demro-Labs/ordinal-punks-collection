const ALLOWED_ORIGIN = "https://demro-labs.github.io";
const ALLOWED_ACTIONS = new Set(["ordinal-punks", "pokedex"]);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const buckets = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request),
  });
}

function isRateLimited(request) {
  const now = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  let bucket = buckets.get(ip);
  if (!bucket || bucket.expiresAt <= now) {
    if (buckets.size >= 10_000) {
      for (const [key, value] of buckets) {
        if (value.expiresAt <= now) buckets.delete(key);
      }
      if (buckets.size >= 10_000) return true;
    }
    bucket = { count: 0, expiresAt: now + RATE_WINDOW_MS };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sessionKey(secret) {
  if (!secret) throw new Error("Session signing key is not configured");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createProof(action, secret) {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    v: 1,
    h: "demro-labs.github.io",
    a: action,
    e: Date.now() + SESSION_TTL_MS,
  })));
  const key = await sessionKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return { proof: payload + "." + encodeBase64Url(signature), expiresAt: Date.now() + SESSION_TTL_MS };
}

async function proofIsValid(proof, action, secret) {
  if (typeof proof !== "string" || proof.length > 2048) return false;
  const parts = proof.split(".");
  if (parts.length !== 2) return false;
  try {
    const key = await sessionKey(secret);
    if (!await crypto.subtle.verify("HMAC", key, decodeBase64Url(parts[1]), encoder.encode(parts[0]))) return false;
    const payload = JSON.parse(decoder.decode(decodeBase64Url(parts[0])));
    return payload.v === 1 && payload.h === "demro-labs.github.io" && payload.a === action && Number.isFinite(payload.e) && payload.e > Date.now();
  } catch {
    return false;
  }
}

async function verifyWithCloudflare(token, action, request, env) {
  if (!env.TURNSTILE_SECRET) throw new Error("Turnstile secret is not configured");
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) form.set("remoteip", remoteIp);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && result.hostname === "demro-labs.github.io" && result.action === action;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request);
    if (request.headers.get("Origin") !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Forbidden origin" }), { status: 403, headers });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
    if (url.pathname !== "/api/verify" && url.pathname !== "/api/session") {
      return json(request, { error: "Not found" }, 404);
    }
    if (isRateLimited(request)) return json(request, { error: "Too many requests" }, 429);
    const contentType = request.headers.get("Content-Type") || "";
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (!contentType.toLowerCase().includes("application/json") || contentLength > 4096) {
      return json(request, { error: "Invalid request" }, 400);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json(request, { error: "Invalid request" }, 400);
    }
    const action = body?.action;
    if (!ALLOWED_ACTIONS.has(action)) return json(request, { error: "Invalid request" }, 400);

    if (url.pathname === "/api/session") {
      const valid = await proofIsValid(body?.proof, action, env.SESSION_SECRET);
      return json(request, { valid });
    }

    const token = body?.token;
    if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
      return json(request, { error: "Verification required" }, 400);
    }
    try {
      const valid = await verifyWithCloudflare(token, action, request, env);
      if (!valid) return json(request, { error: "Human verification failed" }, 403);
      const session = await createProof(action, env.SESSION_SECRET);
      return json(request, { valid: true, ...session });
    } catch {
      return json(request, { error: "Verification service unavailable" }, 503);
    }
  },
};
