import { LIVE_DATA_API_BASE } from "@/lib/live";

export type RuneNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";

export type RuneBalance = {
  amount: string;
  runeid: string;
  rune: string;
  spacedRune: string;
  symbol: string;
  divisibility: number;
};

export type FractalRuneBalance = RuneBalance;

export type RuneUtxo = {
  txid: string;
  vout: number;
  satoshi: number;
  confirmations: number;
  runes: Array<{ runeid: string; amount: string }>;
};
export type RuneUtxoPage = {
  network: RuneNetwork;
  address: string;
  runeid: string;
  start: number;
  total: number;
  utxo: RuneUtxo[];
  refreshedAt: string;
};

export type RuneBalancePage = {
  network: RuneNetwork;
  address: string;
  start: number;
  total: number;
  detail: RuneBalance[];
  refreshedAt: string;
};

export type FractalRuneBalancePage = RuneBalancePage;

const MAX_DIVISIBILITY = 38;
const RUNE_ID_PATTERN = /^\d{1,20}:\d{1,20}$/;

function normalizeBalance(value: unknown): FractalRuneBalance | null {
  if (!value || typeof value !== "object") return null;
  const rune = value as Record<string, unknown>;
  if (
    typeof rune.amount !== "string" ||
    !/^\d{1,80}$/.test(rune.amount) ||
    typeof rune.runeid !== "string" ||
    !RUNE_ID_PATTERN.test(rune.runeid) ||
    typeof rune.rune !== "string" ||
    !rune.rune ||
    rune.rune.length > 128 ||
    typeof rune.spacedRune !== "string" ||
    !rune.spacedRune ||
    rune.spacedRune.length > 160 ||
    typeof rune.divisibility !== "number" ||
    !Number.isSafeInteger(rune.divisibility) ||
    rune.divisibility < 0 ||
    rune.divisibility > MAX_DIVISIBILITY ||
    (rune.symbol !== undefined &&
      (typeof rune.symbol !== "string" || rune.symbol.length > 16))
  )
    return null;
  return {
    amount: rune.amount,
    runeid: rune.runeid,
    rune: rune.rune,
    spacedRune: rune.spacedRune,
    symbol: typeof rune.symbol === "string" ? rune.symbol : "",
    divisibility: rune.divisibility,
  };
}

async function requestJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as
      | ({ error?: unknown } & Record<string, unknown>)
      | null;
    if (!response.ok) {
      throw new Error(
        typeof data?.error === "string"
          ? data.error
          : `Rune API HTTP ${response.status}`
      );
    }
    if (!data) throw new Error("The Rune API returned an invalid response.");
    return data as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchRuneBalancePage(
  address: string,
  network: RuneNetwork,
  start = 0,
  limit = 20
): Promise<RuneBalancePage> {
  if (
    !["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"].includes(network) ||
    !/^[A-Za-z0-9]{14,100}$/.test(address) ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > 10_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 25
  ) {
    throw new Error("Invalid Rune balance query.");
  }
  const query = new URLSearchParams({
    address,
    chain: network,
    start: String(start),
    limit: String(limit),
  });
  const result = await requestJson<Partial<RuneBalancePage>>(
    `${LIVE_DATA_API_BASE}/api/runes/balance-list?${query}`
  );
  const detail = Array.isArray(result.detail)
    ? result.detail.map(normalizeBalance)
    : null;
  if (
    result.network !== network ||
    result.address !== address ||
    result.start !== start ||
    !Number.isSafeInteger(result.total) ||
    (result.total ?? -1) < 0 ||
    !detail ||
    detail.some(item => item === null) ||
    detail.length > limit ||
    typeof result.refreshedAt !== "string"
  )
    throw new Error(
      "The Worker returned an invalid Rune balance page."
    );
  return {
    ...result,
    detail: detail as RuneBalance[],
  } as RuneBalancePage;
}

export function fetchFractalRuneBalancePage(
  address: string,
  start = 0,
  limit = 20
) {
  return fetchRuneBalancePage(address, "FRACTAL_BITCOIN_MAINNET", start, limit);
}

export async function fetchRuneBalance(
  address: string,
  network: RuneNetwork,
  runeid: string
): Promise<RuneBalance> {
  if (
    !["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"].includes(network) ||
    !/^[A-Za-z0-9]{14,100}$/.test(address) ||
    !RUNE_ID_PATTERN.test(runeid)
  )
    throw new Error("Invalid Rune balance query.");
  const query = new URLSearchParams({ address, chain: network, runeid });
  const result = await requestJson<{
    network?: string;
    address?: string;
    balance?: unknown;
    refreshedAt?: string;
  }>(`${LIVE_DATA_API_BASE}/api/runes/balance?${query}`);
  const balance = normalizeBalance(result.balance);
  if (
    result.network !== network ||
    result.address !== address ||
    !balance ||
    balance.runeid !== runeid
  ) {
    throw new Error(
      "The Worker returned an invalid current Rune balance."
    );
  }
  return balance;
}

export function fetchFractalRuneBalance(address: string, runeid: string) {
  return fetchRuneBalance(address, "FRACTAL_BITCOIN_MAINNET", runeid);
}

/** Format an integer base-unit Rune balance exactly, without floating-point rounding. */
export function formatRuneAmount(amount: string, divisibility: number): string {
  if (
    !/^\d{1,80}$/.test(amount) ||
    !Number.isSafeInteger(divisibility) ||
    divisibility < 0 ||
    divisibility > MAX_DIVISIBILITY
  )
    return "—";
  const value = BigInt(amount);
  if (divisibility === 0) return value.toString();
  let scale = BigInt(1);
  for (let digit = 0; digit < divisibility; digit += 1) scale *= BigInt(10);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(divisibility, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Convert a human-readable amount into Rune base units, rejecting excess precision and overspending. */
export function parseRuneAmountToBaseUnits(
  value: string,
  divisibility: number,
  balance: string
): string | null {
  if (
    !/^\d{1,80}$/.test(balance) ||
    !Number.isSafeInteger(divisibility) ||
    divisibility < 0 ||
    divisibility > MAX_DIVISIBILITY
  )
    return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > divisibility) return null;
  let scale = BigInt(1);
  for (let digit = 0; digit < divisibility; digit += 1) scale *= BigInt(10);
  const raw =
    BigInt(match[1]) * scale +
    (fraction ? BigInt(fraction.padEnd(divisibility, "0")) : BigInt(0));
  if (raw <= BigInt(0) || raw > BigInt(balance)) return null;
  return raw.toString();
}


/** Fetch the exact Rune-bearing UTXOs from the read-only Worker indexer; this never calls a wallet provider. */
export async function fetchRuneUtxoPage(
  address: string,
  network: RuneNetwork,
  runeid: string,
  start = 0,
  limit = 25,
): Promise<RuneUtxoPage> {
  if (
    !["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"].includes(network) ||
    !/^[A-Za-z0-9]{14,100}$/.test(address) ||
    !/^\d{1,20}:\d{1,20}$/.test(runeid) ||
    !Number.isSafeInteger(start) || start < 0 || start > 10_000 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 25
  ) throw new Error("Invalid Rune UTXO query.");
  const query = new URLSearchParams({ address, chain: network, runeid, start: String(start), limit: String(limit) });
  const result = await requestJson<Partial<RuneUtxoPage>>(`${LIVE_DATA_API_BASE}/api/runes/utxo-list?${query}`);
  if (
    result.network !== network || result.address !== address || result.runeid !== runeid ||
    result.start !== start || !Number.isSafeInteger(result.total) || (result.total ?? -1) < 0 ||
    !Array.isArray(result.utxo) || result.utxo.length > limit || typeof result.refreshedAt !== "string"
  ) throw new Error("The Worker returned an invalid Rune UTXO page.");
  const utxo = result.utxo.map(item => {
    if (!item || !/^[a-f0-9]{64}$/.test(item.txid) ||
      !Number.isSafeInteger(item.vout) || item.vout < 0 ||
      !Number.isSafeInteger(item.satoshi) || item.satoshi < 1 ||
      !Number.isSafeInteger(item.confirmations) || item.confirmations < 1 ||
      !Array.isArray(item.runes) || item.runes.length < 1 || item.runes.length > 100 ||
      item.runes.some(rune => !rune || !/^\d{1,20}:\d{1,20}$/.test(rune.runeid) || !/^\d{1,80}$/.test(rune.amount) || BigInt(rune.amount) <= 0n)
    ) return null;
    if (!item.runes.some(rune => rune.runeid === runeid)) return null;
    return { txid: item.txid, vout: item.vout, satoshi: item.satoshi, confirmations: item.confirmations, runes: item.runes.map(rune => ({ runeid: rune.runeid, amount: rune.amount })) };
  });
  if (utxo.some(item => item === null)) throw new Error("The Worker returned an unsafe or incomplete Rune UTXO.");
  return { network, address, runeid, start, total: result.total!, utxo: utxo as RuneUtxo[], refreshedAt: result.refreshedAt };
}
