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

export async function getRecommendedFeeRate(network: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Sélectionnez Bitcoin mainnet ou Fractal Bitcoin mainnet dans UniSat.");
  const fees = await requestJson<{ fastestFee?: number; halfHourFee?: number; hourFee?: number; minimumFee?: number }>(`${config.api}/api/v1/fees/recommended`);
  const value = fees.halfHourFee ?? fees.fastestFee ?? fees.hourFee ?? fees.minimumFee;
  if (!Number.isFinite(value) || Number(value) <= 0) throw new Error("Mempool n’a pas renvoyé de fee rate valide.");
  return Math.max(1, Math.ceil(Number(value)));
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
