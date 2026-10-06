export type LiveMarketListing = {
  auctionId: string | null;
  inscriptionId: string;
  collectionItemName: string | null;
  collectionName: string | null;
  priceSats: number | null;
  priceFb: number | null;
  priceUsd: number | null;
  address: string | null;
  marketType: string | null;
};

export type LiveMarket = {
  collectionId: string;
  collectionName: string | null;
  fbUsd: number | null;
  stats: {
    volumeTotalFb: number | null;
    volumeTotalUsd: number | null;
    volume24hFb: number | null;
    volume24hUsd: number | null;
    floorFb: number | null;
    floorUsd: number | null;
    marketCapFb: number | null;
    marketCapUsd: number | null;
    listed: number | null;
    total: number | null;
  };
  listings: LiveMarketListing[];
  totalListings: number;
  start: number;
  limit: number;
  refreshedAt: string;
};

export const MARKET_DATA_URL = import.meta.env.VITE_LIVE_DATA_URL?.replace(/\/api\/live-inscription$/, "") || "https://fractal-ordinal-live.servostar23.workers.dev";

export async function fetchLiveMarket(collectionId: string, start = 0, limit = 20, signal?: AbortSignal): Promise<LiveMarket> {
  const response = await fetch(`${MARKET_DATA_URL}/api/market?collectionId=${encodeURIComponent(collectionId)}&start=${start}&limit=${limit}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Live market request failed (${response.status}).`);
  return (await response.json()) as LiveMarket;
}
