export type LiveListing = { listed: boolean; auctionId: string | null; price: number | null; address: string | null; marketType: string | null; collectionName: string | null };
export type LiveInscription = { inscriptionId: string; owner: string | null; creator: string | null; listing: LiveListing; refreshedAt: string };

export const LIVE_DATA_URL = import.meta.env.VITE_LIVE_DATA_URL || "https://punksgallery-mlwdpcwl.manus.space/api/live-inscription";

export async function fetchLiveInscription(inscriptionId: string, signal?: AbortSignal): Promise<LiveInscription> {
  const response = await fetch(`${LIVE_DATA_URL}?inscriptionId=${encodeURIComponent(inscriptionId)}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Live UniSat request failed (${response.status}).`);
  return (await response.json()) as LiveInscription;
}
