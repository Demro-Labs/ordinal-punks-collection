import { LIVE_DATA_API_BASE } from "@/lib/live";

export type ProtocolNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
export type Brc20Balance = { ticker: string; overallBalance: string; transferableBalance: string; availableBalance: string };
export type RuneBalance = { amount: string; runeid: string; rune: string; spacedRune: string; symbol: string; divisibility: number };
export type AlkaneBalance = { alkaneid: string; amount: string; type: string; name: string; symbol: string; divisibility: number | null };
export type AlkaneCollection = { alkaneid: string; name: string; totalSupply: string; minted: number | null };
export type AlkaneCollectionPage = { network: "BITCOIN_MAINNET"; address: string; start: number; total: number; detail: AlkaneCollection[]; refreshedAt?: string };
export type ProtocolBalances = {
  network: ProtocolNetwork;
  address: string;
  brc20: Brc20Balance[];
  brc20Prog: Brc20Balance[];
  runes: RuneBalance[];
  alkanes: AlkaneBalance[];
  errors: Partial<Record<"BRC20-Prog" | "Runes" | "Alkanes", string>>;
  refreshedAt: string;
};

const LIVE_API_BASE = LIVE_DATA_API_BASE;

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${LIVE_API_BASE}${path}`, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : `Protocol API HTTP ${response.status}`,
    );
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeBrc20(value: unknown): Brc20Balance | null {
  if (!isRecord(value) || typeof value.ticker !== "string" || !/^[a-z0-9]{4,32}$/i.test(value.ticker) ||
    [value.overallBalance, value.transferableBalance, value.availableBalance].some(amount => typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount))) return null;
  return { ticker: value.ticker, overallBalance: value.overallBalance as string, transferableBalance: value.transferableBalance as string, availableBalance: value.availableBalance as string };
}
function normalizeRune(value: unknown): RuneBalance | null {
  if (!isRecord(value) || typeof value.amount !== "string" || !/^\d{1,80}$/.test(value.amount) || typeof value.runeid !== "string" || !/^\d{1,20}:\d{1,20}$/.test(value.runeid) || typeof value.rune !== "string" || !value.rune || typeof value.spacedRune !== "string" || !value.spacedRune || !Number.isSafeInteger(value.divisibility) || Number(value.divisibility) < 0 || Number(value.divisibility) > 38 || (value.symbol !== undefined && typeof value.symbol !== "string")) return null;
  return { amount: value.amount, runeid: value.runeid, rune: value.rune, spacedRune: value.spacedRune, symbol: typeof value.symbol === "string" ? value.symbol : "", divisibility: Number(value.divisibility) };
}
function normalizeAlkane(value: unknown): AlkaneBalance | null {
  if (!isRecord(value) || typeof value.alkaneid !== "string" || !/^\d{1,20}:\d{1,20}$/.test(value.alkaneid) || typeof value.amount !== "string" || !/^\d{1,80}$/.test(value.amount) || typeof value.type !== "string" || typeof value.name !== "string" || typeof value.symbol !== "string" || (value.divisibility !== null && (!Number.isSafeInteger(value.divisibility) || Number(value.divisibility) < 0 || Number(value.divisibility) > 38))) return null;
  return { alkaneid: value.alkaneid, amount: value.amount, type: value.type, name: value.name, symbol: value.symbol, divisibility: value.divisibility as number | null };
}
function normalizeAlkaneCollection(value: unknown): AlkaneCollection | null {
  if (!isRecord(value) || typeof value.alkaneid !== "string" || !/^\d{1,20}:\d{1,20}$/.test(value.alkaneid) || value.type !== "collection" || !isRecord(value.collectionData) || typeof value.collectionData.name !== "string" || typeof value.collectionData.totalSupply !== "string" || (value.collectionData.minted !== null && !Number.isSafeInteger(value.collectionData.minted))) return null;
  return { alkaneid: value.alkaneid, name: value.collectionData.name, totalSupply: value.collectionData.totalSupply, minted: value.collectionData.minted as number | null };
}

async function readList<T>(path: string, address: string, network: ProtocolNetwork, signal: AbortSignal | undefined, normalize: (value: unknown) => T | null, label: string): Promise<T[]> {
  const result = await request<{ network?: string; address?: string; detail?: unknown }>(path, signal);
  if (result.network !== network || result.address !== address || !Array.isArray(result.detail)) {
    throw new Error(`The ${label} indexer returned an incomplete response or data for a different network or wallet.`);
  }
  const rows = result.detail.map(normalize);
  if (rows.some(row => row === null)) throw new Error(`A ${label} balance row is invalid.`);
  return rows as T[];
}

export async function fetchAlkaneCollectionPage(address: string, network: ProtocolNetwork, start: number, signal?: AbortSignal): Promise<AlkaneCollectionPage> {
  if (!/^[A-Za-z0-9]{14,100}$/.test(address)) throw new Error("Invalid wallet address.");
  if (network !== "BITCOIN_MAINNET") throw new Error("Alkane collection indexing is currently enabled only for Bitcoin mainnet.");
  if (!Number.isSafeInteger(start) || start < 0 || start > 10_000) throw new Error("Invalid Alkane collection page offset.");
  const limit = 25;
  const query = new URLSearchParams({ address, chain: network, start: String(start), limit: String(limit) });
  const result = await request<{ network?: string; address?: string; start?: number; total?: number; detail?: unknown; refreshedAt?: string }>(`/api/alkanes/collection-list?${query}`, signal);
  if (result.network !== network || result.address !== address || result.start !== start || !Number.isSafeInteger(result.total) || (result.total ?? -1) < 0 || !Array.isArray(result.detail) || result.detail.length > limit) {
    throw new Error("The Alkane collection indexer returned an incomplete response or data for a different network or wallet.");
  }
  const detail = result.detail.map(normalizeAlkaneCollection);
  if (detail.some(item => item === null)) throw new Error("An Alkane collection row is invalid.");
  return { network, address, start, total: result.total as number, detail: detail as AlkaneCollection[], refreshedAt: result.refreshedAt };
}

export async function fetchProtocolBalances(address: string, network: ProtocolNetwork, signal?: AbortSignal): Promise<ProtocolBalances> {
  if (!/^[A-Za-z0-9]{14,100}$/.test(address)) throw new Error("Invalid wallet address.");
  const query = new URLSearchParams({ address, chain: network });
  const brc20 = await readList<Brc20Balance>(`/api/brc20/balances?${query}`, address, network, signal, normalizeBrc20, "Classic BRC-20");
  const errors: ProtocolBalances["errors"] = {};
  const optional = async <T,>(label: keyof ProtocolBalances["errors"], path: string, normalize: (value: unknown) => T | null): Promise<T[]> => {
    try {
      return await readList<T>(path, address, network, signal, normalize, label);
    } catch (cause) {
      if (signal?.aborted) return [];
      errors[label] = cause instanceof Error ? cause.message : "Data is temporarily unavailable.";
      return [];
    }
  };
  const alkanesRequest = network === "BITCOIN_MAINNET"
    ? optional("Alkanes", `/api/alkanes/balances?${query}`, normalizeAlkane)
    : Promise.resolve([]);
  const brc20ProgRequest = network === "BITCOIN_MAINNET"
    ? optional("BRC20-Prog", `/api/brc20-prog/balances?${query}`, normalizeBrc20)
    : Promise.resolve([]);
  const [brc20Prog, runes, alkanes] = await Promise.all([
    brc20ProgRequest,
    optional("Runes", `/api/runes/balance-list?${new URLSearchParams({ ...Object.fromEntries(query), start: "0", limit: "20" })}`, normalizeRune),
    alkanesRequest,
  ]);
  return { network, address, brc20, brc20Prog, runes, alkanes, errors, refreshedAt: new Date().toISOString() };
}
