import { LIVE_DATA_API_BASE } from "@/lib/live";
import * as bitcoin from "bitcoinjs-lib";

export type MempoolConfig = { api: string; explorer: string; label: string };
export type MempoolReceipt = {
  txid: string;
  network: string;
  status: "checking" | "pending" | "confirmed" | "timeout" | "error";
  message: string;
  blockHeight: number | null;
  explorerUrl: string;
  checkedAt: string;
};

export const MEMPOOL_ENDPOINTS: Record<string, MempoolConfig> = {
  BITCOIN_MAINNET: { api: "https://mempool.space", explorer: "https://mempool.space/tx/", label: "Bitcoin" },
  FRACTAL_BITCOIN_MAINNET: { api: "https://mempool.fractalbitcoin.io", explorer: "https://mempool.fractalbitcoin.io/tx/", label: "Fractal Bitcoin" },
};

export function getMempoolConfig(network?: string) { return network ? MEMPOOL_ENDPOINTS[network] : undefined; }

export function formatLiveIndexerHttpError(status: number, retryAfter: string | null = null, upstreamMessage?: string): string {
  const detail = typeof upstreamMessage === "string" && upstreamMessage.length <= 180 ? upstreamMessage.replace(/\s+/g, " ").trim() : "";
  const suffix = detail ? ` Détail du service: ${detail}` : "";
  if (status === 401) return "Authentification refusée (HTTP 401). Vérifiez la configuration du proxy et la clé côté serveur; ne publiez jamais la clé." + suffix;
  if (status === 403) return "Accès refusé (HTTP 403). Consultez les journaux du Worker pour distinguer un refus du Worker d’un refus UniSat; vérifiez la clé, les autorisations et l’endpoint du réseau." + suffix;
  if (status === 429) return "Limite de requêtes atteinte (HTTP 429). " + (retryAfter && /^\d{1,5}$/.test(retryAfter) ? `Réessayez après ${retryAfter} seconde(s).` : "Respectez Retry-After et réduisez la fréquence des scans.") + suffix;
  if (status >= 500) return `Service de données indisponible (HTTP ${status}) côté Worker ou UniSat. Réessayez plus tard; ne contournez pas la vérification des UTXO.` + suffix;
  if (status === 404) return "Endpoint ou ressource introuvable (HTTP 404). Vérifiez le chemin API et le réseau sélectionné." + suffix;
  if (status === 400) return "Requête rejetée (HTTP 400). Vérifiez les paramètres réseau, adresse et pagination." + suffix;
  return `Échec HTTP ${status} du service de données UniSat/Worker.` + suffix;
}

async function requestJson<T>(url: string, timeoutMs = 8_000, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal, headers });
    if (!response.ok) {
      if (new URL(url).origin === new URL(LIVE_DATA_API_BASE).origin) {
        const failure = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
        if (failure?.code === "UTXO_CONFIRM_NOT_IN_AVAILABLE_SET") {
          const missing = Array.isArray((failure as { missingOutpoints?: unknown }).missingOutpoints)
            ? ((failure as { missingOutpoints: unknown[] }).missingOutpoints).filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}:\d+$/i.test(value))
            : [];
          const outpoints = missing.length ? ` Entrées non retrouvées dans l’index UniSat : ${missing.join(", ")}.` : "";
          throw new Error(`UTXO_CONFIRM_NOT_IN_AVAILABLE_SET: après deux scans, une ou plusieurs entrées PSBT ne figurent toujours pas dans l’ensemble UTXO disponibles et sûrs.${outpoints} Actualisez les UTXO et reconstruisez le PSBT à partir des sorties sûres actuelles. Ne réutilisez pas ces entrées sans confirmation; aucune signature ni diffusion n’a été effectuée.`);
        }
        if (failure?.code === "UTXO_CONFIRM_SCAN_LIMIT_REACHED" || failure?.code === "UTXO_CONFIRM_AVAILABLE_SCAN_INCOMPLETE") {
          throw new Error("La revalidation du scan UTXO n’a pas pu atteindre une page confirmée par l’indexeur. Actualisez les UTXO et reconstruisez le PSBT; aucune signature ni diffusion n’a été effectuée.");
        }
        if (
          failure?.code === "UTXO_CONFIRM_AVAILABLE_INVALID_RESPONSE" ||
          failure?.code === "UTXO_CONFIRM_AVAILABLE_UNSTABLE_RESPONSE" ||
          failure?.code === "UTXO_CONFIRM_AVAILABLE_CURSOR_MISMATCH" ||
          failure?.code === "UTXO_CONFIRM_AVAILABLE_SNAPSHOT_CHANGED"
        ) {
          throw new Error("Les données UniSat ont changé ou sont incohérentes pendant la confirmation des UTXO. Actualisez le coffre, reconstruisez le PSBT et recommencez l’examen. Aucune signature ni diffusion n’a été effectuée.");
        }
        const message = formatLiveIndexerHttpError(response.status, response.headers.get("Retry-After"), typeof failure?.error === "string" ? failure.error : undefined);
        const code = typeof failure?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(failure.code) ? ` [${failure.code}]` : "";
        throw new Error(`${message}${code}`);
      }
      throw new Error(`Mempool HTTP ${response.status}`);
    }
    return await response.json() as T;
  } finally { window.clearTimeout(timer); }
}

async function requestText(url: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "text/plain" } });
    const text = (await response.text()).trim().replace(/^\"|\"$/g, "");
    if (!response.ok) throw new Error(`Mempool HTTP ${response.status}`);
    if (!/^(?:[a-f0-9]{2})+$/i.test(text)) throw new Error("Mempool n’a pas retourné une transaction brute valide.");
    return text;
  } finally { window.clearTimeout(timer); }
}

/** Fetch the full parent transaction required by BIP174 for Legacy P2PKH inputs. */
export async function getMempoolRawTransaction(network: string, txid: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("No Mempool endpoint is configured for this network.");
  if (!/^[a-f0-9]{64}$/i.test(txid)) throw new Error("The previous transaction id is invalid.");
  // Use the chain-specific Mempool API for the parent transaction hex.
  // Safe UTXO selection still comes from the Worker/UniSat asset-aware index.
  return requestText(config.api + "/api/tx/" + encodeURIComponent(txid) + "/hex");
}

export type FeeEstimateSource = { feeRate: number | null; available: boolean };
export type FeeEstimate = {
  network: string;
  target: "halfHour";
  feeRate: number;
  strategy: "maximum-of-mempool-and-unisat" | "single-provider-fallback";
  sources: { mempool: FeeEstimateSource; unisat: FeeEstimateSource };
  sampledAt: string;
};

export function describeFeeSources(strategy: FeeEstimate["strategy"], sources: FeeEstimate["sources"]) {
  if (strategy === "maximum-of-mempool-and-unisat") return "Mempool + UniSat (highest live rate)";
  return sources.mempool.available ? "Mempool seul (UniSat indisponible)" : "UniSat seul (Mempool indisponible)";
}

/** Server-side consensus: compare the live Mempool and UniSat estimates without exposing the UniSat API key. */
export async function getRecommendedFeeEstimate(network: string): Promise<FeeEstimate> {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Select Bitcoin mainnet or Fractal Bitcoin mainnet in UniSat.");
  const query = new URLSearchParams({ chain: network, target: "halfHour" });
  let workerFailure = "";
  try {
    const result = await requestJson<FeeEstimate & { error?: string }>(`${LIVE_DATA_API_BASE}/api/fees/recommended?${query}`, 10_000);
    if (!Number.isFinite(result.feeRate) || result.feeRate < 1 || result.feeRate > 10_000 || result.network !== network || result.target !== "halfHour") {
      throw new Error(result.error || "The Worker fee estimate is invalid.");
    }
    return result;
  } catch (error) {
    workerFailure = error instanceof Error ? error.message : "The fee Worker is temporarily unavailable.";
  }
  try {
    // Direct, chain-specific Mempool fallback; never reuse stale fee estimates.
    const direct = await requestJson<{ halfHourFee?: number; fastestFee?: number; hourFee?: number; economyFee?: number; minimumFee?: number }>(config.api + "/api/v1/fees/recommended");
    // A present but invalid preferred field must not mask a valid fallback rate.
    const rawRate = [direct.halfHourFee, direct.fastestFee, direct.hourFee, direct.economyFee, direct.minimumFee]
      .find(value => value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 10_000);
    const feeRate = Math.ceil(Number(rawRate));
    if (!Number.isSafeInteger(feeRate) || feeRate < 1 || feeRate > 10_000) throw new Error("Mempool n’a pas retourné un taux de frais valide.");
    return { network, target: "halfHour", feeRate, strategy: "single-provider-fallback", sources: { mempool: { feeRate, available: true }, unisat: { feeRate: null, available: false } }, sampledAt: new Date().toISOString() };
  } catch (error) {
    const mempoolFailure = error instanceof Error ? error.message : "Mempool est temporairement indisponible.";
    throw new Error(`Les frais live sont indisponibles via le Worker (${workerFailure}) et Mempool (${mempoolFailure}). Aucun ancien taux n’a été réutilisé.`);
  }
}

export async function getRecommendedFeeRate(network: string) {
  const estimate = await getRecommendedFeeEstimate(network);
  return Math.ceil(estimate.feeRate);
}

export type UtxoBalanceSummary = {
  chain: "fractal" | "bitcoin";
  address: string;
  totalBalance: number;
  totalUtxoCount: number;
  availableBalance: number;
  availableUtxoCount: number;
  unavailableBalance: number;
  unavailableUtxoCount: number;
  refreshedAt: string;
};

/** Read UniSat's aggregate total-vs-available view; never use this summary to select transaction inputs. */
export async function getUtxoBalanceSummary(network: string, address: string): Promise<UtxoBalanceSummary> {
  const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : network === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : null;
  if (!chain || !address || address.length > 100) throw new Error("Réseau ou adresse invalide pour le résumé des UTXO.");
  const query = new URLSearchParams({ chain, address });
  const result = await requestJson<Partial<UtxoBalanceSummary>>(`${LIVE_DATA_API_BASE}/api/utxo-balance-summary?${query}`, 12_000);
  const fields = ["totalBalance", "totalUtxoCount", "availableBalance", "availableUtxoCount", "unavailableBalance", "unavailableUtxoCount"] as const;
  if (result.chain !== chain || result.address !== address || typeof result.refreshedAt !== "string" ||
      fields.some(key => !Number.isSafeInteger(result[key]) || (result[key] as number) < 0) ||
      result.availableBalance! + result.unavailableBalance! !== result.totalBalance ||
      result.availableUtxoCount! + result.unavailableUtxoCount! !== result.totalUtxoCount) {
    throw new Error("Le Worker n’a pas confirmé un résumé cohérent des UTXO UniSat.");
  }
  return result as UtxoBalanceSummary;
}

export type AddressUtxoInventoryProgress = { scannedCount: number; totalCount: number };
export type AddressUtxoInventoryScan = AddressUtxoInventoryProgress;
type AddressUtxoInventoryPage = {
  chain?: string; address?: string; cursor?: number; nextCursor?: number; total?: number; totalKnown?: boolean; hasMore?: boolean; scannedCount?: number; utxo?: unknown[];
};
const ADDRESS_UTXO_PAGE_SIZE = 25;
const MAX_ADDRESS_UTXO_PAGES = 40_000;
const MAX_ADDRESS_UTXO_REQUESTS_PER_MINUTE = 120;
const ADDRESS_UTXO_REQUEST_WINDOW_MS = 60_000;

/** Enumerate and validate every indexed wallet output for inventory; this display-only set never authorizes spending. */
export async function scanAddressUtxoInventory(network: string, address: string, options: { onProgress?: (progress: AddressUtxoInventoryProgress) => void } = {}): Promise<AddressUtxoInventoryScan> {
  const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : network === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : null;
  if (!chain || !address || address.length > 100) throw new Error("Réseau ou adresse invalide pour l’inventaire UTXO.");

  let cursor = 0;
  let scannedCount = 0;
  let totalCount: number | null = null;
  let totalCountKnown: boolean | null = null;
  let requestWindowStartedAt = Date.now();
  let requestsInWindow = 0;
  const seenInventoryOutpoints = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_ADDRESS_UTXO_PAGES; pageNumber += 1) {
    if (requestsInWindow >= MAX_ADDRESS_UTXO_REQUESTS_PER_MINUTE) {
      const waitMs = Math.max(0, requestWindowStartedAt + ADDRESS_UTXO_REQUEST_WINDOW_MS - Date.now());
      if (waitMs > 0) await new Promise<void>(resolve => window.setTimeout(resolve, waitMs));
      requestWindowStartedAt = Date.now();
      requestsInWindow = 0;
    }
    requestsInWindow += 1;
    const query: URLSearchParams = new URLSearchParams({ chain, address, cursor: String(cursor), size: String(ADDRESS_UTXO_PAGE_SIZE) });
    const page: AddressUtxoInventoryPage = await requestJson<AddressUtxoInventoryPage>(`${LIVE_DATA_API_BASE}/api/address-utxos?${query}`, 15_000);
    const pageRows = page.utxo;
    const pageScannedCount = page.scannedCount;
    const nextCursor = page.nextCursor;
    const pageTotal = page.total;
    const pageTotalKnown = typeof page.totalKnown === "boolean" ? page.totalKnown : !(pageScannedCount === ADDRESS_UTXO_PAGE_SIZE && pageTotal === nextCursor! + 1);
    const hasMore = typeof page.hasMore === "boolean" ? page.hasMore : (pageTotalKnown ? nextCursor! < pageTotal! : pageScannedCount === ADDRESS_UTXO_PAGE_SIZE);
    if (
      page.chain !== chain || page.address !== address || page.cursor !== cursor || !Array.isArray(pageRows) ||
      !Number.isSafeInteger(pageScannedCount) || pageScannedCount! < 0 || pageScannedCount! > ADDRESS_UTXO_PAGE_SIZE ||
      !Number.isSafeInteger(nextCursor) || nextCursor !== cursor + pageScannedCount! ||
      !Number.isSafeInteger(pageTotal) || pageTotal! < nextCursor! || pageRows.length !== pageScannedCount! ||
      typeof pageTotalKnown !== "boolean" || typeof hasMore !== "boolean" ||
      (pageTotalKnown && hasMore !== (nextCursor! < pageTotal!)) ||
      (!pageTotalKnown && hasMore !== (pageScannedCount === ADDRESS_UTXO_PAGE_SIZE)) ||
      (totalCountKnown === true && pageTotalKnown && pageTotal !== totalCount)
    ) {
      throw new Error("L’indexeur n’a pas confirmé une page d’inventaire UTXO cohérente. Les lignes partielles ne sont pas comptées.");
    }

    const pageOutpoints = new Set<string>();
    const nullableArray = (value: unknown) => value === undefined || value === null || Array.isArray(value);
    const rowsValid = pageRows.every(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      const amount = normalizeSatoshiValue(item);
      const outpoint = `${String(item.txid).toLowerCase()}:${String(item.vout)}`;
      const validHeight = item.height === undefined || item.height === null || (Number.isSafeInteger(item.height) && (item.height as number) >= 0);
      const validScript = item.scriptPk === undefined || item.scriptPk === null || (typeof item.scriptPk === "string" && /^(?:[a-f0-9]{2})+$/i.test(item.scriptPk));
      const validSpent = item.isSpent === undefined || item.isSpent === null || typeof item.isSpent === "boolean";
      if (typeof item.txid !== "string" || !/^[a-f0-9]{64}$/i.test(item.txid) ||
          typeof item.vout !== "number" || !Number.isSafeInteger(item.vout) || item.vout < 0 || amount === null ||
          pageOutpoints.has(outpoint) || seenInventoryOutpoints.has(outpoint) || !validHeight || !validScript || !validSpent ||
          !nullableArray(item.inscriptions) || !nullableArray(item.runes) || !nullableArray(item.alkanes)) return false;
      pageOutpoints.add(outpoint);
      return true;
    });
    if (!rowsValid) throw new Error("Une sortie de l’inventaire UTXO est absente, dupliquée ou mal formée; le scan complet est refusé.");
    pageOutpoints.forEach(outpoint => seenInventoryOutpoints.add(outpoint));

    const confirmedPageCount = pageScannedCount!;
    const confirmedNextCursor = nextCursor!;
    scannedCount += confirmedPageCount;
    if (pageTotalKnown) { totalCount = pageTotal!; totalCountKnown = true; }
    else if (totalCountKnown !== true) { totalCount = pageTotal!; totalCountKnown = false; }
    options.onProgress?.({ scannedCount, totalCount: totalCount ?? scannedCount });
    if (!hasMore) return { scannedCount, totalCount: scannedCount };
    if (confirmedPageCount === 0 || confirmedNextCursor === cursor) {
      throw new Error(`Inventaire UTXO incomplet : ${scannedCount} sorties parcourues; l’indexeur n’a pas avancé.`);
    }
    cursor = confirmedNextCursor;
  }
  throw new Error(`Inventaire UTXO incomplet : ${scannedCount} sorties parcourues sur ${totalCount ?? "un total inconnu"}. La limite de pages est atteinte.`);
}

export type SpendableUtxo = { address: string; txid: string; vout: number; satoshi: number; scriptPk: string; height: number; inscriptionsRunesAlkanesChecked: true; isLowFee: boolean; isOpInRBF: boolean; inscriptions: []; sourceCursor?: number };
export class InsufficientSafeUtxosError extends Error {
  constructor(message: string) { super(message); this.name = "InsufficientSafeUtxosError"; }
}
export type WorkerSafeUtxoAttestation = {
  chain: "fractal" | "bitcoin";
  address: string;
  minimumSats: number;
  safeSats: number;
  sufficient: true;
  verifiedUtxoCount: number;
  confirmedAt: string;
};
type WorkerSafeUtxoConfirmationResponse = Omit<WorkerSafeUtxoAttestation, "sufficient"> & { sufficient: boolean };
const SPENDABLE_UTXO_PAGE_SIZE = 25;
// The Worker accepts cursors through 1,000,000; keep scanning until the reported total.
const MAX_SPENDABLE_UTXO_PAGES = 40_000;
const MAX_SPENDABLE_REQUESTS_PER_MINUTE = 120;
const SPENDABLE_REQUEST_WINDOW_MS = 60_000;
const UTXO_REJECTION_KEYS = [
  "identityMismatch", "invalidValue", "invalidScript", "unconfirmedOrInvalidHeight", "invalidFlags",
  "hasInscriptionOrUnknown", "detailMismatch", "spentOrUnknown", "hasRunes", "hasAlkanes",
] as const;
type UtxoRejectionDiagnostics = Record<typeof UTXO_REJECTION_KEYS[number], number>;
type UtxoRejectionSats = Record<"unconfirmedOrInvalidHeight" | "invalidFlags" | "hasInscriptionOrUnknown" | "detailMismatch" | "spentOrUnknown" | "hasRunes" | "hasAlkanes", number>;
const UTXO_REJECTION_LABELS: Record<typeof UTXO_REJECTION_KEYS[number], string> = {
  identityMismatch: "adresse/outpoint incohérent",
  invalidValue: "montant inférieur au seuil standard du script ou invalide",
  invalidScript: "script de sortie absent ou hexadécimal invalide",
  unconfirmedOrInvalidHeight: "sortie non confirmée/hauteur invalide",
  invalidFlags: "métadonnées de sécurité invalides",
  hasInscriptionOrUnknown: "inscription présente ou statut inconnu",
  detailMismatch: "détail UTXO incohérent",
  spentOrUnknown: "sortie dépensée ou état inconnu",
  hasRunes: "Rune détectée",
  hasAlkanes: "Alkane détecté",
};

/** UniSat may serialize satoshi amounts as decimal strings; normalize safely before filtering/summing. */
function normalizeSatoshiValue(item: Record<string, unknown>): number | null {
  const raw = item.satoshi !== undefined && item.satoshi !== null ? item.satoshi : item.value;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

/** Keep the browser-side UTXO floor aligned with the Worker; final fee sufficiency is checked separately. */
export function minimumSpendableSatsForScript(scriptHex: string): number {
  const script = typeof scriptHex === "string" ? scriptHex.toLowerCase() : "";
  if (/^0014[a-f0-9]{40}$/.test(script)) return 294; // P2WPKH
  if (/^(?:0020[a-f0-9]{64}|5120[a-f0-9]{64})$/.test(script)) return 330; // P2WSH / P2TR
  if (/^a914[a-f0-9]{40}87$/.test(script)) return 540; // P2SH
  if (/^76a914[a-f0-9]{40}88ac$/.test(script)) return 546; // P2PKH
  return 600; // Unknown/non-standard script: keep conservative floor.
}

/** Fetch confirmed, non-asset UTXOs; a low-fee/RBF history does not make a confirmed output replaceable. */
function compareSpendableUtxos(left: SpendableUtxo, right: SpendableUtxo) {
  // Largest-first reduces the number of fee inputs while keeping the selection deterministic.
  return right.satoshi - left.satoshi ||
    left.txid.localeCompare(right.txid) ||
    left.vout - right.vout;
}

export async function getSpendableUtxos(network: string, address: string, minimumSats: number, options: { mobile?: boolean; requiredOutpoints?: string[]; collectAll?: boolean; allowInsufficientSafeBalance?: boolean; onProgress?: (progress: { scannedCount: number; totalCount: number; safeUtxoCount: number }) => void; onDiagnostics?: (diagnostics: { counts: Record<string, number>; sats: Record<string, number> }) => void; onDiagnostics?: (diagnostics: { counts: Record<string, number>; sats: Record<string, number> }) => void } = {}): Promise<SpendableUtxo[]> {
  const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : network === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : null;
  if (!chain || !address || !Number.isSafeInteger(minimumSats) || minimumSats <= 0) {
    throw new Error("Invalid network, address, or amount for spendable UTXO verification.");
  }
  // Local Vault fee discovery scans the complete indexer-reported set by default.
  // Callers may opt into an early stop only when they explicitly request collectAll: false.
  const collectAll = options.collectAll ?? true;
  const normalizedOutpoints = options.requiredOutpoints?.map(value => value.toLowerCase());
  const requiredOutpoints = normalizedOutpoints ? normalizedOutpoints.filter((value, index) => normalizedOutpoints.indexOf(value) === index) : null;
  if (requiredOutpoints && (requiredOutpoints.length !== options.requiredOutpoints!.length || requiredOutpoints.length < 1 || requiredOutpoints.some(value => !/^[a-f0-9]{64}:\d+$/.test(value)))) {
    throw new Error("The required PSBT outpoints are invalid or duplicated.");
  }
  const collected: SpendableUtxo[] = [];
  const seenSafeOutpoints = new Set<string>();
  let cursor = 0;
  let scannedCount = 0;
  let sourceTotal: number | null = null;
  let expectedTotal: number | null = null;
  let scanComplete = false;
  const rejectionTotals: UtxoRejectionDiagnostics = {
    identityMismatch: 0, invalidValue: 0, invalidScript: 0, unconfirmedOrInvalidHeight: 0, invalidFlags: 0,
    hasInscriptionOrUnknown: 0, detailMismatch: 0, spentOrUnknown: 0, hasRunes: 0, hasAlkanes: 0,
  };
  const rejectionSatsTotals: UtxoRejectionSats = {
    unconfirmedOrInvalidHeight: 0, invalidFlags: 0, hasInscriptionOrUnknown: 0,
    detailMismatch: 0, spentOrUnknown: 0, hasRunes: 0, hasAlkanes: 0,
  };
  let requestWindowStartedAt = Date.now();
  let requestsInWindow = 0;
  for (let pageNumber = 0; pageNumber < MAX_SPENDABLE_UTXO_PAGES; pageNumber += 1) {
    if (requestsInWindow >= MAX_SPENDABLE_REQUESTS_PER_MINUTE) {
      const waitMs = Math.max(0, requestWindowStartedAt + SPENDABLE_REQUEST_WINDOW_MS - Date.now());
      if (waitMs > 0) await new Promise<void>(resolve => window.setTimeout(resolve, waitMs));
      requestWindowStartedAt = Date.now();
      requestsInWindow = 0;
    }
    requestsInWindow += 1;
    const query = new URLSearchParams({ chain, address, cursor: String(cursor), size: String(SPENDABLE_UTXO_PAGE_SIZE) });
    if (options.mobile) query.set("mobile", "1");
    type SpendableUtxoPage = {
      chain?: string; address?: string; cursor?: number; nextCursor?: number; total?: number; totalKnown?: boolean; hasMore?: boolean; scannedCount?: number;
      utxo?: Array<Record<string, unknown>>;
      diagnostics?: Partial<UtxoRejectionDiagnostics>;
      diagnosticsSats?: Partial<UtxoRejectionSats>;
    };
    const page: SpendableUtxoPage = await requestJson<SpendableUtxoPage>(`${LIVE_DATA_API_BASE}/api/spendable-utxos?${query}`, 15_000);
    const pageScannedCount = page.scannedCount;
    const nextCursor = page.nextCursor;
    const total = page.total;
    const totalKnown = typeof page.totalKnown === "boolean" ? page.totalKnown : !(pageScannedCount === SPENDABLE_UTXO_PAGE_SIZE && total === nextCursor! + 1);
    const hasMore = typeof page.hasMore === "boolean" ? page.hasMore : (totalKnown ? nextCursor! < total! : pageScannedCount === SPENDABLE_UTXO_PAGE_SIZE);
    if (
      page.chain !== chain || page.address !== address || page.cursor !== cursor || !Array.isArray(page.utxo) ||
      !Number.isSafeInteger(pageScannedCount) || pageScannedCount! < 0 || pageScannedCount! > SPENDABLE_UTXO_PAGE_SIZE ||
      !Number.isSafeInteger(nextCursor) || nextCursor !== cursor + pageScannedCount! ||
      !Number.isSafeInteger(total) || total! < 0 || nextCursor! > total! || page.utxo.length > pageScannedCount! ||
      typeof totalKnown !== "boolean" || typeof hasMore !== "boolean" ||
      (totalKnown && hasMore !== (nextCursor! < total!)) ||
      (!totalKnown && hasMore !== (pageScannedCount === SPENDABLE_UTXO_PAGE_SIZE)) ||
      (expectedTotal !== null && totalKnown && total !== expectedTotal)
    ) {
      throw new Error("The server did not confirm a consistent safe-UTXO page for this address.");
    }
    scannedCount += pageScannedCount!;
    sourceTotal = totalKnown ? total! : null;
    if (totalKnown) expectedTotal = total!;
    if (page.diagnostics !== undefined) {
      let rejectedOnPage = 0;
      for (const key of UTXO_REJECTION_KEYS) {
        const value = page.diagnostics[key];
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
          throw new Error("The Worker returned invalid safe-UTXO rejection diagnostics.");
        }
        rejectionTotals[key] += value as number;
        rejectedOnPage += value as number;
      }
      if (rejectedOnPage + page.utxo.length > pageScannedCount!) {
        throw new Error("The Worker returned inconsistent safe-UTXO rejection diagnostics.");
      }
    }
    if (page.diagnosticsSats !== undefined) {
      for (const key of Object.keys(rejectionSatsTotals) as (keyof UtxoRejectionSats)[]) {
        const value = page.diagnosticsSats[key];
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
          throw new Error("The Worker returned invalid safe-UTXO rejected-value diagnostics.");
        }
        rejectionSatsTotals[key] += value as number;
      }
    }
    const safe = page.utxo.map((item): Record<string, unknown> => ({
      ...item,
      satoshi: normalizeSatoshiValue(item),
    })).filter((item): item is Record<string, unknown> & SpendableUtxo =>
      item.address === address && typeof item.txid === "string" && /^[a-f0-9]{64}$/i.test(item.txid) &&
      typeof item.vout === "number" && Number.isSafeInteger(item.vout) && item.vout >= 0 &&
      typeof item.satoshi === "number" && Number.isSafeInteger(item.satoshi) &&
      typeof item.scriptPk === "string" && /^(?:[a-f0-9]{2})+$/i.test(item.scriptPk) &&
      item.satoshi >= minimumSpendableSatsForScript(item.scriptPk) &&
      typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0 &&
      item.inscriptionsRunesAlkanesChecked === true && typeof item.isLowFee === "boolean" && typeof item.isOpInRBF === "boolean" &&
      Array.isArray(item.inscriptions) && item.inscriptions.length === 0
    );
    for (const item of safe) {
      const key = `${item.txid.toLowerCase()}:${item.vout}`;
      if (seenSafeOutpoints.has(key)) {
        throw new Error(`Safe UTXO index repeated outpoint ${key} across pages. The inventory is inconsistent; no transaction was signed or broadcast.`);
      }
      seenSafeOutpoints.add(key);
    }
    collected.push(...safe.map(item => ({ ...item, sourceCursor: cursor })));
    options.onProgress?.({ scannedCount, totalCount: sourceTotal ?? (hasMore ? nextCursor! + 1 : nextCursor!), safeUtxoCount: collected.length });
    options.onDiagnostics?.({ counts: { ...rejectionTotals }, sats: { ...rejectionSatsTotals } });
    options.onDiagnostics?.({ counts: { ...rejectionTotals }, sats: { ...rejectionSatsTotals } });
    const safeSats = collected.reduce((sum, item) => sum + item.satoshi, 0);
    if (requiredOutpoints) {
      const byOutpoint = new Map(collected.map(item => [`${item.txid.toLowerCase()}:${item.vout}`, item]));
      if (requiredOutpoints.every(outpoint => byOutpoint.has(outpoint))) return requiredOutpoints.map(outpoint => byOutpoint.get(outpoint)!);
    } else if (!collectAll && safeSats >= minimumSats) return [...collected].sort(compareSpendableUtxos);
    if (pageScannedCount === 0 && hasMore) {
      throw new Error(`Safe UTXO scan is incomplete: the indexer stopped at ${scannedCount} address outputs. No transaction was signed or broadcast.`);
    }
    if (!hasMore) { scanComplete = true; break; }
    cursor = nextCursor!;
  }
  const safeSats = collected.reduce((sum, item) => sum + item.satoshi, 0);
  if (requiredOutpoints) {
    const byOutpoint = new Map(collected.map(item => [`${item.txid.toLowerCase()}:${item.vout}`, item]));
    const missing = requiredOutpoints.filter(outpoint => !byOutpoint.has(outpoint));
    if (missing.length) throw new Error(`The live safe-UTXO index did not verify every exact PSBT input (${missing.join(", ")}). No transaction was signed or broadcast.`);
    return requiredOutpoints.map(outpoint => byOutpoint.get(outpoint)!);
  }
  // Never silently return a partial set if the Worker cursor limit is reached.
  // An incomplete scan could omit fee UTXOs and misstate the address's safe balance.
  if (collectAll && !scanComplete) {
    const scannedLabel = sourceTotal === null ? String(scannedCount) : `${scannedCount}/${sourceTotal}`;
    throw new Error(`Safe UTXO scan is incomplete: verified ${scannedLabel} address outputs (Worker cursor limit ${MAX_SPENDABLE_UTXO_PAGES * SPENDABLE_UTXO_PAGE_SIZE}). No transaction was signed or broadcast.`);
  }
  if (!options.allowInsufficientSafeBalance && safeSats < minimumSats) {
    const scannedLabel = sourceTotal === null ? String(scannedCount) : `${scannedCount}/${sourceTotal}`;
    const zeroSafeBalanceHint = safeSats === 0 ? " No fee-safe UTXO was found. If this address only has its inscription output, fund the same network address with a separate confirmed BTC/FB output, then refresh; never spend the inscription output as fees." : "";
    const rejectionSummary = UTXO_REJECTION_KEYS
      .filter(key => rejectionTotals[key] > 0)
      .map(key => `${UTXO_REJECTION_LABELS[key]}: ${rejectionTotals[key]}`)
      .join("; ");
    const diagnosticHint = rejectionSummary ? ` Motifs de rejet UniSat/Worker: ${rejectionSummary}.` : "";
    const rejectedValueSummary = (Object.keys(rejectionSatsTotals) as (keyof UtxoRejectionSats)[])
      .filter(key => rejectionSatsTotals[key] > 0)
      .map(key => `${UTXO_REJECTION_LABELS[key]}: ${rejectionSatsTotals[key].toLocaleString("en-US")} sats`)
      .join("; ");
    const rejectedValueHint = rejectedValueSummary ? ` Valeur des sorties rejetées par motif: ${rejectedValueSummary}.` : "";
    throw new InsufficientSafeUtxosError(`UniSat/Worker verified only ${safeSats.toLocaleString("en-US")} sats across ${collected.length} safe UTXOs after scanning ${scannedLabel} UniSat available outputs (Worker cursor limit ${MAX_SPENDABLE_UTXO_PAGES * SPENDABLE_UTXO_PAGE_SIZE}; protocol-asset outputs are excluded from this fee-safe scan). Minimum required: ${minimumSats.toLocaleString("en-US")} sats. No payment was started.${diagnosticHint}${rejectedValueHint}${zeroSafeBalanceHint}`);
  }
  return [...collected].sort(compareSpendableUtxos);
}

/** Recheck the exact PSBT inputs with the Fractal Worker before the Local Vault signs or broadcasts. */
export async function confirmSpendableUtxos(network: string, address: string, minimumSats: number, utxos: Array<Pick<SpendableUtxo, "txid" | "vout" | "satoshi" | "scriptPk" | "sourceCursor">>): Promise<WorkerSafeUtxoAttestation> {
  const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : network === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : null;
  if (!chain || !address || !Number.isSafeInteger(minimumSats) || minimumSats <= 0 || !Array.isArray(utxos) || utxos.length < 1 || utxos.length > 20) {
    throw new Error("The UTXO set to confirm with the Worker is invalid.");
  }
  const result = await requestJson<Partial<WorkerSafeUtxoConfirmationResponse>>(
    `${LIVE_DATA_API_BASE}/api/spendable-utxos/confirm`,
    15_000,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain,
        address,
        minimumSats,
        utxos: utxos.map(utxo => ({ txid: utxo.txid, vout: utxo.vout, satoshi: utxo.satoshi, scriptPk: utxo.scriptPk, ...(Number.isSafeInteger(utxo.sourceCursor) ? { sourceCursor: utxo.sourceCursor } : {}) })),
      }),
    },
  );
  if (
    result.chain !== chain || result.address !== address || result.minimumSats !== minimumSats ||
    !Number.isSafeInteger(result.safeSats) || !Number.isSafeInteger(result.verifiedUtxoCount) ||
    result.verifiedUtxoCount !== utxos.length || typeof result.sufficient !== "boolean" || typeof result.confirmedAt !== "string"
  ) throw new Error(`The Worker did not return a complete attestation for the selected ${network} UTXOs.`);
  if (!result.sufficient || result.safeSats! < minimumSats) {
    throw new InsufficientSafeUtxosError(`The Worker confirmed only ${result.safeSats!.toLocaleString("en-US")} safe sats across the PSBT inputs; ${minimumSats.toLocaleString("en-US")} sats are required. No payment can be approved.`);
  }
  return result as WorkerSafeUtxoAttestation;
}

export async function confirmFractalSpendableUtxos(address: string, minimumSats: number, utxos: Array<Pick<SpendableUtxo, "txid" | "vout" | "satoshi" | "scriptPk" | "sourceCursor">>): Promise<WorkerSafeUtxoAttestation> {
  return confirmSpendableUtxos("FRACTAL_BITCOIN_MAINNET", address, minimumSats, utxos);
}

export async function validateMempoolAddress(network: string, address: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Unsupported mainnet network.");
  try {
    if (typeof address !== "string" || !address.trim() || address.trim().length > 100) throw new Error("Invalid address");
    // Bitcoin and Fractal mainnet share address encodings. Decode locally so an
    // explorer/API outage cannot block signing; this does not contact the network.
    bitcoin.address.toOutputScript(address.trim(), bitcoin.networks.bitcoin);
  } catch {
    throw new Error(`L’adresse destinataire n’est pas valide pour ${config.label}.`);
  }
}

export async function trackMempoolTransaction(txid: string, network: string, onUpdate?: (receipt: MempoolReceipt) => void) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("No Mempool endpoint is configured for this network.");
  const explorerUrl = `${config.explorer}${encodeURIComponent(txid)}`;
  const emit = (status: MempoolReceipt["status"], message: string, blockHeight: number | null = null) => {
    const receipt = { txid, network: config.label, status, message, blockHeight, explorerUrl, checkedAt: new Date().toISOString() } satisfies MempoolReceipt;
    onUpdate?.(receipt); return receipt;
  };
  emit("checking", "Searching for the transaction in Mempool…");
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      // Read the transaction from the selected network Mempool API.
      // A missing transaction is not reported as pending; it is retried below.
      const tx = await requestJson<{ status?: { confirmed?: boolean; block_height?: number } }>(config.api + "/api/tx/" + encodeURIComponent(txid), 10_000);
      if (tx.status?.confirmed) return emit("confirmed", "Transaction confirmée sur la chaîne.", typeof tx.status.block_height === "number" ? tx.status.block_height : null);
      if (tx.status && tx.status.confirmed === false) emit("pending", "Transaction visible dans le mempool du réseau sélectionné, en attente de confirmation.");
      else throw new Error("Mempool n’a pas fourni un statut de transaction vérifiable.");
    } catch (error) {
      emit("error", error instanceof Error ? `${error.message}. Nouvelle tentative automatique.` : "Mempool est temporairement indisponible. Nouvelle tentative automatique.");
    }
    await new Promise(resolve => window.setTimeout(resolve, 10_000));
  }
  return emit("timeout", "No confirmation after 30 minutes. Verify la transaction dans Mempool.");
}
