export type LiveListing = { listed: boolean; auctionId: string | null; price: number | null; address: string | null; marketType: string | null; collectionName: string | null };
export type LiveInscription = { inscriptionId: string; owner: string | null; creator: string | null; listing: LiveListing; refreshedAt: string };

export const LIVE_DATA_URL = import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription";
export const LIVE_DATA_API_BASE = LIVE_DATA_URL.replace(/\/api\/live-inscription\/?$/, "");

export async function fetchLiveInscription(inscriptionId: string, signal?: AbortSignal): Promise<LiveInscription> {
  const response = await fetch(`${LIVE_DATA_URL}?inscriptionId=${encodeURIComponent(inscriptionId)}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Live UniSat request failed (${response.status}).`);
  const payload = (await response.json()) as Partial<LiveInscription>;
  return {
    inscriptionId: payload.inscriptionId || inscriptionId,
    owner: payload.owner ?? null,
    creator: payload.creator ?? null,
    listing: payload.listing ?? { listed: false, auctionId: null, price: null, address: null, marketType: null, collectionName: null },
    refreshedAt: payload.refreshedAt || new Date().toISOString(),
  };
}
