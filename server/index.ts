import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UNISAT_BASE = "https://open-api-fractal.unisat.io";
const liveCache = new Map<string, { expiresAt: number; payload: object }>();
const CACHE_TTL_MS = 30_000;

async function unisatJson(pathname: string, init: RequestInit = {}) {
  const apiKey = process.env.UNISAT_API_KEY;
  if (!apiKey) throw new Error("UNISAT_API_KEY is not configured on the server.");
  const response = await fetch(`${UNISAT_BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`UniSat upstream returned ${response.status}.`);
  const payload = (await response.json()) as { code?: number; msg?: string; data?: any };
  if (payload.code !== 0) throw new Error(payload.msg || "UniSat upstream request failed.");
  return payload.data;
}

async function readCreator(inscriptionId: string): Promise<string | null> {
  const genesisTxid = inscriptionId.split("i")[0];
  if (!/^[a-f0-9]{64}$/.test(genesisTxid)) return null;
  const inputs = await unisatJson(`/v1/indexer/tx/${genesisTxid}/ins?cursor=0&size=100`);
  if (!Array.isArray(inputs)) return null;
  return inputs.find((input) => typeof input?.address === "string" && input.address.length > 0)?.address ?? null;
}

async function readLive(inscriptionId: string) {
  const [info, listing, creator] = await Promise.allSettled([
    unisatJson(`/v1/indexer/inscription/info/${inscriptionId}`),
    unisatJson("/v3/market/collection/auction/inscription_info", { method: "POST", body: JSON.stringify({ inscriptionId }) }),
    readCreator(inscriptionId),
  ]);
  if (info.status === "rejected") throw info.reason;
  const infoData = info.value ?? {};
  const listingData = listing.status === "fulfilled" ? listing.value ?? {} : {};
  const owner = infoData.address ?? infoData.utxo?.address ?? null;
  const listed = listingData.notOnSale === false && Boolean(listingData.auctionId);
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
  const server = createServer(app);

  app.get("/api/live-inscription", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    const inscriptionId = String(req.query.inscriptionId ?? "");
    if (!/^[a-f0-9]{64}i\d+$/.test(inscriptionId)) return res.status(400).json({ error: "A valid Fractal inscription ID is required." });
    const cached = liveCache.get(inscriptionId);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.payload);
    try {
      const payload = await readLive(inscriptionId);
      liveCache.set(inscriptionId, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
      return res.json(payload);
    } catch (error) {
      console.error("UniSat live proxy error", error instanceof Error ? error.message : error);
      return res.status(502).json({ error: "Live UniSat data is temporarily unavailable." });
    }
  });

  const staticPath = process.env.NODE_ENV === "production" ? path.resolve(__dirname, "public") : path.resolve(__dirname, "..", "dist", "public");
  app.use(express.static(staticPath));
  app.get("*", (_req, res) => res.sendFile(path.join(staticPath, "index.html")));
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Server running on http://localhost:${port}/`));
}

startServer().catch(console.error);
