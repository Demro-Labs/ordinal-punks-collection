import { LIVE_DATA_API_BASE } from "@/lib/live";

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
        const message = typeof failure?.error === "string" ? failure.error : `Live API HTTP ${response.status}`;
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
  const query = new URLSearchParams({ chain: network, txid });
  return requestText(`${LIVE_DATA_API_BASE}/api/mempool/tx-hex?${query}`);
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
    const direct = await requestJson<{ halfHourFee?: number; fastestFee?: number; hourFee?: number; economyFee?: number; minimumFee?: number }>(`${LIVE_DATA_API_BASE}/api/mempool/fees?chain=${encodeURIComponent(network)}`);
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

export type SpendableUtxo = { address: string; txid: string; vout: number; satoshi: number; scriptPk: string; height: number; inscriptionsRunesAlkanesChecked: true; isLowFee: boolean; isOpInRBF: boolean; inscriptions: [] };
export class InsufficientSafeUtxosError extends Error {
  constructor(message: string) { super(message); this.name = "InsufficientSafeUtxosError"; }
}
export type WorkerSafeUtxoAttestation = {
  chain: "fractal";
  address: string;
  minimumSats: number;
  safeSats: number;
  sufficient: true;
  verifiedUtxoCount: number;
  confirmedAt: string;
};
type WorkerSafeUtxoConfirmationResponse = Omit<WorkerSafeUtxoAttestation, "sufficient"> & { sufficient: boolean };
const SPENDABLE_UTXO_PAGE_SIZE = 25;
const MAX_SPENDABLE_UTXO_PAGES = 20;
const UTXO_REJECTION_KEYS = [
  "identityMismatch", "invalidValue", "invalidScript", "unconfirmedOrInvalidHeight", "invalidFlags",
  "hasInscriptionOrUnknown", "detailMismatch", "spentOrUnknown", "hasRunes", "hasAlkanes",
] as const;
type UtxoRejectionDiagnostics = Record<typeof UTXO_REJECTION_KEYS[number], number>;
const UTXO_REJECTION_LABELS: Record<typeof UTXO_REJECTION_KEYS[number], string> = {
  identityMismatch: "adresse/outpoint incohérent",
  invalidValue: "valeur inférieure à 600 sats ou invalide",
  invalidScript: "script de sortie absent ou hexadécimal invalide",
  unconfirmedOrInvalidHeight: "sortie non confirmée/hauteur invalide",
  invalidFlags: "métadonnées de sécurité invalides",
  hasInscriptionOrUnknown: "inscription présente ou statut inconnu",
  detailMismatch: "détail UTXO incohérent",
  spentOrUnknown: "sortie dépensée ou état inconnu",
  hasRunes: "Rune détectée",
  hasAlkanes: "Alkane détecté",
};

/** Fetch confirmed, non-asset UTXOs; a low-fee/RBF history does not make a confirmed output replaceable. */
export async function getSpendableUtxos(network: string, address: string, minimumSats: number, options: { mobile?: boolean; requiredOutpoints?: string[] } = {}): Promise<SpendableUtxo[]> {
  const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : network === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : null;
  if (!chain || !address || !Number.isSafeInteger(minimumSats) || minimumSats <= 0) {
    throw new Error("Invalid network, address, or amount for spendable UTXO verification.");
  }
  const normalizedOutpoints = options.requiredOutpoints?.map(value => value.toLowerCase());
  const requiredOutpoints = normalizedOutpoints ? normalizedOutpoints.filter((value, index) => normalizedOutpoints.indexOf(value) === index) : null;
  if (requiredOutpoints && (requiredOutpoints.length !== options.requiredOutpoints!.length || requiredOutpoints.length < 1 || requiredOutpoints.some(value => !/^[a-f0-9]{64}:\d+$/.test(value)))) {
    throw new Error("The required PSBT outpoints are invalid or duplicated.");
  }
  const collected: SpendableUtxo[] = [];
  let cursor = 0;
  let scannedCount = 0;
  let sourceTotal: number | null = null;
  const rejectionTotals: UtxoRejectionDiagnostics = {
    identityMismatch: 0, invalidValue: 0, invalidScript: 0, unconfirmedOrInvalidHeight: 0, invalidFlags: 0,
    hasInscriptionOrUnknown: 0, detailMismatch: 0, spentOrUnknown: 0, hasRunes: 0, hasAlkanes: 0,
  };
  for (let pageNumber = 0; pageNumber < MAX_SPENDABLE_UTXO_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({ chain, address, cursor: String(cursor), size: String(SPENDABLE_UTXO_PAGE_SIZE) });
    if (options.mobile) query.set("mobile", "1");
    type SpendableUtxoPage = {
      chain?: string; address?: string; cursor?: number; nextCursor?: number; total?: number; scannedCount?: number;
      utxo?: Array<Record<string, unknown>>;
      diagnostics?: Partial<UtxoRejectionDiagnostics>;
    };
    const page: SpendableUtxoPage = await requestJson<SpendableUtxoPage>(`${LIVE_DATA_API_BASE}/api/spendable-utxos?${query}`, 15_000);
    const pageScannedCount = page.scannedCount;
    const nextCursor = page.nextCursor;
    const total = page.total;
    if (
      page.chain !== chain || page.address !== address || page.cursor !== cursor || !Array.isArray(page.utxo) ||
      !Number.isSafeInteger(pageScannedCount) || pageScannedCount! < 0 || pageScannedCount! > SPENDABLE_UTXO_PAGE_SIZE ||
      !Number.isSafeInteger(nextCursor) || nextCursor !== cursor + pageScannedCount! ||
      !Number.isSafeInteger(total) || total! < 0 || nextCursor! > total! || page.utxo.length > pageScannedCount!
    ) {
      throw new Error("The server did not confirm a consistent safe-UTXO page for this address.");
    }
    scannedCount += pageScannedCount!;
    sourceTotal = total!;
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
    const safe = page.utxo.filter((item): item is SpendableUtxo =>
      item.address === address && typeof item.txid === "string" && /^[a-f0-9]{64}$/i.test(item.txid) &&
      typeof item.vout === "number" && Number.isSafeInteger(item.vout) && item.vout >= 0 &&
      typeof item.satoshi === "number" && Number.isSafeInteger(item.satoshi) && item.satoshi >= 600 &&
      typeof item.scriptPk === "string" && /^(?:[a-f0-9]{2})+$/i.test(item.scriptPk) &&
      typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0 &&
      item.inscriptionsRunesAlkanesChecked === true && typeof item.isLowFee === "boolean" && typeof item.isOpInRBF === "boolean" &&
      Array.isArray(item.inscriptions) && item.inscriptions.length === 0
    );
    collected.push(...safe);
    const safeSats = collected.reduce((sum, item) => sum + item.satoshi, 0);
    if (requiredOutpoints) {
      const byOutpoint = new Map(collected.map(item => [`${item.txid.toLowerCase()}:${item.vout}`, item]));
      if (requiredOutpoints.every(outpoint => byOutpoint.has(outpoint))) return requiredOutpoints.map(outpoint => byOutpoint.get(outpoint)!);
    } else if (safeSats >= minimumSats) return collected;
    if (pageScannedCount === 0 || nextCursor === total) break;
    cursor = nextCursor!;
  }
  const safeSats = collected.reduce((sum, item) => sum + item.satoshi, 0);
  if (requiredOutpoints) {
    const byOutpoint = new Map(collected.map(item => [`${item.txid.toLowerCase()}:${item.vout}`, item]));
    const missing = requiredOutpoints.filter(outpoint => !byOutpoint.has(outpoint));
    if (missing.length) throw new Error(`The live safe-UTXO index did not verify every exact PSBT input (${missing.join(", ")}). No transaction was signed or broadcast.`);
    return requiredOutpoints.map(outpoint => byOutpoint.get(outpoint)!);
  }
  if (safeSats < minimumSats) {
    const scannedLabel = sourceTotal === null ? String(scannedCount) : `${scannedCount}/${sourceTotal}`;
    const zeroSafeBalanceHint = safeSats === 0 ? " No fee-safe UTXO was found. If this address only has its inscription output, fund the same network address with a separate confirmed BTC/FB output, then refresh; never spend the inscription output as fees." : "";
    const rejectionSummary = UTXO_REJECTION_KEYS
      .filter(key => rejectionTotals[key] > 0)
      .map(key => `${UTXO_REJECTION_LABELS[key]}: ${rejectionTotals[key]}`)
      .join("; ");
    const diagnosticHint = rejectionSummary ? ` Motifs de rejet UniSat/Worker: ${rejectionSummary}.` : "";
    throw new InsufficientSafeUtxosError(`UniSat/Worker verified only ${safeSats.toLocaleString("en-US")} sats across ${collected.length} safe UTXOs after scanning ${scannedLabel} UniSat address outputs (limit ${MAX_SPENDABLE_UTXO_PAGES * SPENDABLE_UTXO_PAGE_SIZE}; protocol-asset outputs are checked and excluded from fee inputs). Minimum required: ${minimumSats.toLocaleString("en-US")} sats. No payment was started.${diagnosticHint}${zeroSafeBalanceHint}`);
  }
  return collected;
}

/** Recheck the exact PSBT inputs with the Fractal Worker before UniSat is asked to sign or pay. */
export async function confirmFractalSpendableUtxos(address: string, minimumSats: number, utxos: Array<Pick<SpendableUtxo, "txid" | "vout" | "satoshi" | "scriptPk">>): Promise<WorkerSafeUtxoAttestation> {
  if (!address || !Number.isSafeInteger(minimumSats) || minimumSats <= 0 || !Array.isArray(utxos) || utxos.length < 1 || utxos.length > 20) {
    throw new Error("The UTXO set to confirm with the Worker is invalid.");
  }
  const result = await requestJson<Partial<WorkerSafeUtxoConfirmationResponse>>(
    `${LIVE_DATA_API_BASE}/api/spendable-utxos/confirm`,
    15_000,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "fractal",
        address,
        minimumSats,
        utxos: utxos.map(utxo => ({ txid: utxo.txid, vout: utxo.vout, satoshi: utxo.satoshi, scriptPk: utxo.scriptPk })),
      }),
    },
  );
  if (
    result.chain !== "fractal" || result.address !== address || result.minimumSats !== minimumSats ||
    !Number.isSafeInteger(result.safeSats) || !Number.isSafeInteger(result.verifiedUtxoCount) ||
    result.verifiedUtxoCount !== utxos.length || typeof result.sufficient !== "boolean" || typeof result.confirmedAt !== "string"
  ) throw new Error("The Worker did not return a complete attestation for the selected Fractal UTXOs.");
  if (!result.sufficient || result.safeSats! < minimumSats) {
    throw new InsufficientSafeUtxosError(`The Worker confirmed only ${result.safeSats!.toLocaleString("en-US")} safe sats across the PSBT inputs; ${minimumSats.toLocaleString("en-US")} sats are required. No payment can be approved.`);
  }
  return result as WorkerSafeUtxoAttestation;
}

export async function validateMempoolAddress(network: string, address: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Unsupported mainnet network.");
  const query = new URLSearchParams({ chain: network, address });
  const result = await requestJson<{ isvalid?: boolean }>(`${LIVE_DATA_API_BASE}/api/mempool/validate-address?${query}`);
  if (!result.isvalid) throw new Error(`L’adresse destinataire n’est pas valide pour ${config.label}.`);
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
      const query = new URLSearchParams({ chain: network, txid });
      const status = await requestJson<{ confirmed?: boolean; block_height?: number }>(`${LIVE_DATA_API_BASE}/api/mempool/tx-status?${query}`, 10_000);
      if (status.confirmed) return emit("confirmed", "Transaction confirmed on-chain.", typeof status.block_height === "number" ? status.block_height : null);
      emit("pending", "Transaction visible dans le mempool, en attente de confirmation.");
    } catch (error) {
      emit("error", error instanceof Error ? `${error.message}. Nouvelle tentative automatique.` : "Mempool est temporairement indisponible. Nouvelle tentative automatique.");
    }
    await new Promise(resolve => window.setTimeout(resolve, 10_000));
  }
  return emit("timeout", "No confirmation after 30 minutes. Verify la transaction dans Mempool.");
}
