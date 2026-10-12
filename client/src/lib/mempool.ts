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

async function requestJson<T>(url: string, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Mempool HTTP ${response.status}`);
    return await response.json() as T;
  } finally { window.clearTimeout(timer); }
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
  if (strategy === "maximum-of-mempool-and-unisat") return "Mempool + UniSat (taux live le plus élevé)";
  return sources.mempool.available ? "Mempool seul (UniSat indisponible)" : "UniSat seul (Mempool indisponible)";
}

/** Server-side consensus: compare the live Mempool and UniSat estimates without exposing the UniSat API key. */
export async function getRecommendedFeeEstimate(network: string): Promise<FeeEstimate> {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Sélectionnez Bitcoin mainnet ou Fractal Bitcoin mainnet dans UniSat.");
  const query = new URLSearchParams({ chain: network, target: "halfHour" });
  const result = await requestJson<FeeEstimate & { error?: string }>(`${LIVE_DATA_API_BASE}/api/fees/recommended?${query}`, 10_000);
  if (!Number.isFinite(result.feeRate) || result.feeRate < 1 || result.feeRate > 10_000 || result.network !== network || result.target !== "halfHour") {
    throw new Error(result.error || "Les estimateurs de frais Mempool/UniSat n’ont pas renvoyé de taux valide.");
  }
  return result;
}

export async function getRecommendedFeeRate(network: string) {
  const estimate = await getRecommendedFeeEstimate(network);
  return Math.ceil(estimate.feeRate);
}

export type SpendableUtxo = { address: string; txid: string; vout: number; satoshi: number; scriptPk: string; inscriptionsRunesAlkanesChecked: true; isLowFee: false; isOpInRBF: false; inscriptions: [] };

/** Fetch only confirmed, non-asset UTXOs verified by the server-side UniSat indexer. */
export async function getSpendableUtxos(network: string, address: string, minimumSats: number): Promise<SpendableUtxo[]> {
  const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : network === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : null;
  if (!chain || !address || !Number.isSafeInteger(minimumSats) || minimumSats <= 0) {
    throw new Error("Réseau, adresse ou montant invalide pour vérifier les UTXO dépensables.");
  }

  const collected: SpendableUtxo[] = [];
  let cursor: number = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const query: URLSearchParams = new URLSearchParams({ chain, address, cursor: String(cursor), size: "25" });
    type SpendableUtxoPage = {
      chain?: string; address?: string; nextCursor?: number; total?: number; scannedCount?: number;
      utxo?: Array<Record<string, unknown>>;
    };
    const page: SpendableUtxoPage = await requestJson<SpendableUtxoPage>(`${LIVE_DATA_API_BASE}/api/spendable-utxos?${query}`, 15_000);
    if (page.chain !== chain || page.address !== address || !Array.isArray(page.utxo)) {
      throw new Error("Le serveur n’a pas confirmé la liste d’UTXO sûre pour cette adresse.");
    }

    const safe = page.utxo.filter((item): item is SpendableUtxo =>
      item.address === address && typeof item.txid === "string" && /^[a-f0-9]{64}$/i.test(item.txid) &&
      typeof item.vout === "number" && Number.isSafeInteger(item.vout) && item.vout >= 0 &&
      typeof item.satoshi === "number" && Number.isSafeInteger(item.satoshi) && item.satoshi >= 600 &&
      typeof item.scriptPk === "string" && /^(?:[a-f0-9]{2})+$/i.test(item.scriptPk) &&
      item.inscriptionsRunesAlkanesChecked === true && item.isLowFee === false && item.isOpInRBF === false &&
      Array.isArray(item.inscriptions) && item.inscriptions.length === 0
    );
    collected.push(...safe);
    if (collected.reduce((sum, item) => sum + item.satoshi, 0) >= minimumSats) return collected;

    const nextCursor = Number(page.nextCursor);
    const total = Number(page.total);
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor || !Number.isSafeInteger(total) || nextCursor >= total || Number(page.scannedCount) <= 0) break;
    cursor = nextCursor;
  }
  if (collected.reduce((sum, item) => sum + item.satoshi, 0) < minimumSats) {
    throw new Error("Le serveur UniSat n’a pas confirmé assez d’UTXO sûrs pour couvrir le montant et les frais. Aucun paiement n’a été lancé.");
  }
  return collected;
}

export async function validateMempoolAddress(network: string, address: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Réseau principal non pris en charge.");
  const result = await requestJson<{ isvalid?: boolean }>(`${config.api}/api/v1/validate-address/${encodeURIComponent(address)}`);
  if (!result.isvalid) throw new Error(`L’adresse destinataire n’est pas valide pour ${config.label}.`);
}

export async function trackMempoolTransaction(txid: string, network: string, onUpdate?: (receipt: MempoolReceipt) => void) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Aucun endpoint Mempool n’est configuré pour ce réseau.");
  const explorerUrl = `${config.explorer}${encodeURIComponent(txid)}`;
  const emit = (status: MempoolReceipt["status"], message: string, blockHeight: number | null = null) => {
    const receipt = { txid, network: config.label, status, message, blockHeight, explorerUrl, checkedAt: new Date().toISOString() } satisfies MempoolReceipt;
    onUpdate?.(receipt); return receipt;
  };
  emit("checking", "Recherche de la transaction dans Mempool…");
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const status = await requestJson<{ confirmed?: boolean; block_height?: number }>(`${config.api}/api/tx/${encodeURIComponent(txid)}/status`, 10_000);
      if (status.confirmed) return emit("confirmed", "Transaction confirmée on-chain.", typeof status.block_height === "number" ? status.block_height : null);
      emit("pending", "Transaction visible dans le mempool, en attente de confirmation.");
    } catch (error) {
      emit("error", error instanceof Error ? `${error.message}. Nouvelle tentative automatique.` : "Mempool est temporairement indisponible. Nouvelle tentative automatique.");
    }
    await new Promise(resolve => window.setTimeout(resolve, 10_000));
  }
  return emit("timeout", "Aucune confirmation après 30 minutes. Vérifiez la transaction dans Mempool.");
}
