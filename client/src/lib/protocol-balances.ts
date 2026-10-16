export type ProtocolNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";

export type Brc20Balance = {
  ticker: string;
  overallBalance: string;
  transferableBalance: string;
  availableBalance: string;
};

export type AlkaneBalance = {
  alkaneid: string;
  amount: string;
  type: "token" | "collection" | "nft" | "contract" | string;
  name: string;
  symbol: string;
  divisibility: number | null;
};

export type ProtocolBalances = {
  network: ProtocolNetwork;
  address: string;
  brc20: Brc20Balance[];
  alkanes: AlkaneBalance[];
  refreshedAt: string;
};

const LIVE_API_BASE = (import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription").replace(/\/api\/live-inscription\/?$/, "");

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${LIVE_API_BASE}${path}`, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Protocol API HTTP ${response.status}`);
  return payload as T;
}

export async function fetchProtocolBalances(address: string, network: ProtocolNetwork, signal?: AbortSignal): Promise<ProtocolBalances> {
  if (!/^[A-Za-z0-9]{14,100}$/.test(address)) throw new Error("Adresse wallet invalide.");
  const query = new URLSearchParams({ address, chain: network });
  const [brc20, alkanes] = await Promise.all([
    request<{ detail?: Brc20Balance[] }>(`/api/brc20/balances?${query}`, signal),
    request<{ detail?: AlkaneBalance[] }>(`/api/alkanes/balances?${query}`, signal),
  ]);
  return { network, address, brc20: brc20.detail || [], alkanes: alkanes.detail || [], refreshedAt: new Date().toISOString() };
}
