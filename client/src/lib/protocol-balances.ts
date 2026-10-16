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
  brc20Prog: Brc20Balance[];
  brc20ProgError?: string;
  alkanes: AlkaneBalance[];
  refreshedAt: string;
};

export type Brc20ProgModuleStatus = {
  network: "BITCOIN_MAINNET";
  configured: boolean;
  blockNumber: string | null;
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
  // UniSat documents BRC20-Prog indexing as Bitcoin-only; never query it on Fractal.
  let prog: { detail?: Brc20Balance[] } | null = null;
  let brc20ProgError: string | undefined;
  if (network === "BITCOIN_MAINNET") {
    try {
      prog = await request<{ detail?: Brc20Balance[] }>(`/api/brc20-prog/balances?${new URLSearchParams({ address })}`, signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      brc20ProgError = cause instanceof Error ? cause.message : "Indexeur BRC20-Prog indisponible.";
    }
  }
  return { network, address, brc20: brc20.detail || [], brc20Prog: prog?.detail || [], brc20ProgError, alkanes: alkanes.detail || [], refreshedAt: new Date().toISOString() };
}

export async function fetchBrc20ProgModuleStatus(signal?: AbortSignal): Promise<Brc20ProgModuleStatus> {
  return request<Brc20ProgModuleStatus>("/api/brc20-prog/module/status", signal);
}
