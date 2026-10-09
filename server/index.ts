import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UNISAT_BASE = "https://open-api-fractal.unisat.io";
const liveCache = new Map<string, { expiresAt: number; payload: object }>();
const CACHE_TTL_MS = 30_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 120;
const rateBuckets = new Map<string, { count: number; expiresAt: number }>();
const ALLOWED_ORIGINS = new Set(
  (
    process.env.ALLOWED_ORIGINS ??
    "https://demro-labs.github.io,https://punksgallery-mlwdpcwl.manus.space"
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' https://forge.butterfly-effect.dev https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com 'unsafe-eval' blob:; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com data: blob:; connect-src 'self' https://fractal-ordinal-live.servostar23.workers.dev https://forge.butterfly-effect.dev https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:; manifest-src 'self'; worker-src 'self' blob:; frame-src *.google.com; upgrade-insecure-requests",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
function isRateLimited(ip: string) {
  const now = Date.now();
  const current = rateBuckets.get(ip);
  if (!current || current.expiresAt <= now) {
    if (rateBuckets.size >= 10_000) {
      rateBuckets.forEach((value, key) => {
        if (value.expiresAt <= now) rateBuckets.delete(key);
      });
      if (rateBuckets.size >= 10_000) return true;
    }
    rateBuckets.set(ip, { count: 1, expiresAt: now + RATE_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > RATE_MAX_REQUESTS;
}

async function unisatJson(pathname: string, init: RequestInit = {}) {
  const apiKey = process.env.UNISAT_API_KEY;
  if (!apiKey)
    throw new Error("UNISAT_API_KEY is not configured on the server.");
  const response = await fetch(`${UNISAT_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`UniSat upstream returned ${response.status}.`);
  const payload = (await response.json()) as {
    code?: number;
    msg?: string;
    data?: any;
  };
  if (payload.code !== 0)
    throw new Error(payload.msg || "UniSat upstream request failed.");
  return payload.data;
}

async function readCreator(inscriptionId: string): Promise<string | null> {
  const genesisTxid = inscriptionId.split("i")[0];
  if (!/^[a-f0-9]{64}$/.test(genesisTxid)) return null;
  const inputs = await unisatJson(
    `/v1/indexer/tx/${genesisTxid}/ins?cursor=0&size=100`
  );
  if (!Array.isArray(inputs)) return null;
  return (
    inputs.find(
      input => typeof input?.address === "string" && input.address.length > 0
    )?.address ?? null
  );
}

async function readLive(inscriptionId: string) {
  const [info, listing, creator] = await Promise.allSettled([
    unisatJson(`/v1/indexer/inscription/info/${inscriptionId}`),
    unisatJson("/v3/market/collection/auction/inscription_info", {
      method: "POST",
      body: JSON.stringify({ inscriptionId }),
    }),
    readCreator(inscriptionId),
  ]);
  if (info.status === "rejected") throw info.reason;
  const infoData = info.value ?? {};
  const listingData =
    listing.status === "fulfilled" ? (listing.value ?? {}) : {};
  const owner = infoData.address ?? infoData.utxo?.address ?? null;
  const listed =
    listingData.notOnSale === false && Boolean(listingData.auctionId);
  return {
    inscriptionId,
    owner,
    creator: creator.status === "fulfilled" ? creator.value : null,
    listing: {
      listed,
      auctionId: listingData.auctionId ?? null,
      price: listingData.price ?? null,
      address: listingData.address ?? null,
      marketType: listingData.marketType ?? null,
      collectionName: listingData.collectionName ?? null,
    },
    refreshedAt: new Date().toISOString(),
  };
}

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      res.setHeader(name, value);
    const origin = req.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin))
      return res.status(403).json({ error: "Origin is not allowed." });
    if (req.path === "/api/live-inscription") {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (isRateLimited(ip))
        return res
          .setHeader("Retry-After", "60")
          .status(429)
          .json({ error: "Too many requests." });
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    return next();
  });

  app.get("/api/live-inscription", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const inscriptionId = String(req.query.inscriptionId ?? "");
    if (!/^[a-f0-9]{64}i\d+$/.test(inscriptionId))
      return res
        .status(400)
        .json({ error: "A valid Fractal inscription ID is required." });
    const cached = liveCache.get(inscriptionId);
    if (cached && cached.expiresAt > Date.now())
      return res.json(cached.payload);
    try {
      const payload = await readLive(inscriptionId);
      liveCache.set(inscriptionId, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        payload,
      });
      return res.json(payload);
    } catch (error) {
      console.error(
        "UniSat live proxy error",
        error instanceof Error ? error.message : error
      );
      return res
        .status(502)
        .json({ error: "Live UniSat data is temporarily unavailable." });
    }
  });

  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");
  app.use(express.static(staticPath));
  app.get("*", (_req, res) =>
    res.sendFile(path.join(staticPath, "index.html"))
  );
  const port = process.env.PORT || 3000;
  server.listen(port, () =>
    console.log(`Server running on http://localhost:${port}/`)
  );
}

startServer().catch(console.error);
