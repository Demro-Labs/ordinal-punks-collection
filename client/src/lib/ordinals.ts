import { LIVE_DATA_API_BASE } from "@/lib/live";

export type OrdinalNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
export type AddressOrdinal = {
  inscriptionId: string;
  inscriptionNumber: number | null;
  location: string | null;
  outputValue: number | null;
  contentType: string | null;
};
export type AddressOrdinals = {
  network: OrdinalNetwork;
  address: string;
  start: number;
  total: number;
  detail: AddressOrdinal[];
  refreshedAt: string;
};

function validAddress(address: string) {
  return /^[A-Za-z0-9]{14,100}$/.test(address);
}
function normalize(value: unknown): AddressOrdinal | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.inscriptionId !== "string" || !/^[a-f0-9]{64}i\d+$/i.test(item.inscriptionId)) return null;
  const location = typeof item.location === "string" && /^[a-f0-9]{64}:\d+:\d+$/i.test(item.location) ? item.location : null;
  const inscriptionNumber = item.inscriptionNumber === null || item.inscriptionNumber === undefined ? null : Number(item.inscriptionNumber);
  const outputValue = item.outputValue === null || item.outputValue === undefined ? null : Number(item.outputValue);
  const normalizedInscriptionNumber = inscriptionNumber !== null && Number.isSafeInteger(inscriptionNumber) && inscriptionNumber >= 0 ? inscriptionNumber : null;
  const normalizedOutputValue = outputValue !== null && Number.isSafeInteger(outputValue) && outputValue >= 0 ? outputValue : null;
  return {
    inscriptionId: item.inscriptionId.toLowerCase(),
    inscriptionNumber: normalizedInscriptionNumber,
    location,
    outputValue: normalizedOutputValue,
    contentType: typeof item.contentType === "string" ? item.contentType : null,
  };
}

export async function fetchAddressOrdinals(address: string, network: OrdinalNetwork, signal?: AbortSignal): Promise<AddressOrdinals> {
  if (!validAddress(address)) throw new Error("Invalid Local Vault address.");
  const query = new URLSearchParams({ address, chain: network, start: "0", limit: "50" });
  const response = await fetch(`${LIVE_DATA_API_BASE}/api/ordinals/address-list?${query}`, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Live Ordinals request failed (${response.status}).`);
  if (payload.network !== network || payload.address !== address || payload.start !== 0 || !Number.isSafeInteger(payload.total) || payload.total < 0 || !Array.isArray(payload.detail) || payload.detail.length > 50) throw new Error("The Ordinals indexer returned an incomplete response.");
  const detail = payload.detail.map(normalize);
  if (detail.some((item: AddressOrdinal | null) => item === null)) throw new Error("The Ordinals indexer returned an invalid inscription.");
  return { network, address, start: 0, total: payload.total, detail: detail as AddressOrdinal[], refreshedAt: typeof payload.refreshedAt === "string" ? payload.refreshedAt : new Date().toISOString() };
}
