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

const ORDINAL_PAGE_SIZE = 50;
const MAX_LOCAL_VAULT_INSCRIPTIONS = 1_000;
const PAGE_DELAY_MS = 250;

function waitForNextPage() {
  return new Promise(resolve => window.setTimeout(resolve, PAGE_DELAY_MS));
}

async function fetchOrdinalPage(address: string, network: OrdinalNetwork, start: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ address, chain: network, start: String(start), limit: String(ORDINAL_PAGE_SIZE) });
  const response = await fetch(`${LIVE_DATA_API_BASE}/api/ordinals/address-list?${query}`, {
    signal, cache: "no-store", headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Live Ordinals request failed (${response.status}).`);
  if (payload.network !== network || payload.address !== address || payload.start !== start
    || !Number.isSafeInteger(payload.total) || payload.total < 0
    || !Array.isArray(payload.detail) || payload.detail.length > ORDINAL_PAGE_SIZE) {
    throw new Error("The Ordinals indexer returned an incomplete page.");
  }
  const detail = payload.detail.map(normalize);
  if (detail.some((item: AddressOrdinal | null) => item === null)) throw new Error("The Ordinals indexer returned an invalid inscription.");
  return { total: payload.total as number, detail: detail as AddressOrdinal[], refreshedAt: typeof payload.refreshedAt === "string" ? payload.refreshedAt : new Date().toISOString() };
}

export async function fetchAddressOrdinals(address: string, network: OrdinalNetwork, signal?: AbortSignal): Promise<AddressOrdinals> {
  if (!validAddress(address)) throw new Error("Invalid Local Vault address.");
  const first = await fetchOrdinalPage(address, network, 0, signal);
  if (first.total > MAX_LOCAL_VAULT_INSCRIPTIONS) {
    throw new Error(`This Local Vault address has ${first.total} inscriptions. The safe local signer currently verifies at most ${MAX_LOCAL_VAULT_INSCRIPTIONS} inscriptions per address; no transaction was signed.`);
  }
  if (first.detail.length !== Math.min(ORDINAL_PAGE_SIZE, first.total)) throw new Error("The Ordinals indexer returned an incomplete first page.");
  const detail = [...first.detail];
  for (let start = ORDINAL_PAGE_SIZE; start < first.total; start += ORDINAL_PAGE_SIZE) {
    if (signal?.aborted) throw new DOMException("The Ordinals lookup was cancelled.", "AbortError");
    await waitForNextPage();
    const page = await fetchOrdinalPage(address, network, start, signal);
    if (page.total !== first.total || page.detail.length !== Math.min(ORDINAL_PAGE_SIZE, first.total - start)) {
      throw new Error("The Ordinals index changed or returned an incomplete page during local verification. Refresh and retry.");
    }
    detail.push(...page.detail);
  }
  const ids = new Set<string>();
  for (const item of detail) {
    if (ids.has(item.inscriptionId)) throw new Error("The Ordinals index returned a duplicate inscription; local signing is blocked.");
    ids.add(item.inscriptionId);
  }
  return { network, address, start: 0, total: first.total, detail, refreshedAt: new Date().toISOString() };
}
