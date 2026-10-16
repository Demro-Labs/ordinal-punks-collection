import { getMempoolConfig, type MempoolReceipt } from "./mempool";

export type NativeNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";

export type NativeFbReceipt = {
  txid: string;
  networkEnum: NativeNetwork;
  network: string;
  sender: string;
  recipient: string;
  amountSats: number;
  feeRate: number;
  feeSource: string;
  createdAt: string;
  mempool: MempoolReceipt;
};

const RECEIPT_PREFIX = "native-mainnet-send:v2:";
const LEGACY_FRACTAL_PREFIX = "fractal-mobile-fb-send:v1:";
const MEMPOOL_STATUSES = new Set(["checking", "pending", "confirmed", "timeout", "error"]);

export function getNativeFbReceiptStorageKey(address: string, network: NativeNetwork) {
  return `${RECEIPT_PREFIX}${network}:${address.toLowerCase()}`;
}

export function getNativeFbOutcomeUnclearStorageKey(address: string, network: NativeNetwork) {
  return `${getNativeFbReceiptStorageKey(address, network)}:unclear`;
}

export function getLegacyFractalReceiptStorageKey(address: string) {
  return `${LEGACY_FRACTAL_PREFIX}${address.toLowerCase()}`;
}

export function getLegacyFractalOutcomeUnclearStorageKey(address: string) {
  return `${getLegacyFractalReceiptStorageKey(address)}:unclear`;
}

export function readNativeFbOutcomeUnclear(
  address: string,
  network: NativeNetwork,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  const currentKey = getNativeFbOutcomeUnclearStorageKey(address, network);
  if (storage.getItem(currentKey) === "1") return true;
  if (network !== "FRACTAL_BITCOIN_MAINNET") return false;
  const legacyKey = getLegacyFractalOutcomeUnclearStorageKey(address);
  if (storage.getItem(legacyKey) !== "1") return false;
  storage.setItem(currentKey, "1");
  storage.removeItem(legacyKey);
  return true;
}

export function parseNativeFbReceipt(
  raw: string | null,
  address: string,
  network: NativeNetwork,
  allowLegacyFractal = false,
): NativeFbReceipt | null {
  const config = getMempoolConfig(network);
  if (!raw || !config) return null;
  try {
    const value = JSON.parse(raw) as Partial<NativeFbReceipt> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const isLegacyFractal = allowLegacyFractal && network === "FRACTAL_BITCOIN_MAINNET" && value.networkEnum === undefined && value.network === config.label;
    if ((value.networkEnum !== network && !isLegacyFractal) || value.network !== config.label) return null;
    if (
      typeof value.txid !== "string" || !/^[a-f0-9]{64}$/i.test(value.txid) ||
      typeof value.sender !== "string" || value.sender.toLowerCase() !== address.toLowerCase() ||
      typeof value.recipient !== "string" || !value.recipient ||
      !Number.isSafeInteger(value.amountSats) || value.amountSats! <= 0 ||
      typeof value.feeRate !== "number" || !Number.isFinite(value.feeRate) || value.feeRate <= 0 ||
      typeof value.feeSource !== "string" || typeof value.createdAt !== "string"
    ) return null;
    const mempool = value.mempool as Partial<MempoolReceipt> | undefined;
    if (
      !mempool || mempool.txid !== value.txid || mempool.network !== config.label ||
      typeof mempool.status !== "string" || !MEMPOOL_STATUSES.has(mempool.status) ||
      typeof mempool.message !== "string" ||
      !(mempool.blockHeight === null || (typeof mempool.blockHeight === "number" && Number.isSafeInteger(mempool.blockHeight))) ||
      mempool.explorerUrl !== `${config.explorer}${value.txid}` || typeof mempool.checkedAt !== "string"
    ) return null;
    return { ...value, networkEnum: network, network: config.label, mempool: mempool as MempoolReceipt } as NativeFbReceipt;
  } catch {
    return null;
  }
}
