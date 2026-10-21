export type Brc20TransferIdentity = {
  site: "punks" | "pokedex";
  address: string;
  network: string;
  ticker: string;
  kind: "classic" | "prog";
};

export type Brc20TransferProgress = Brc20TransferIdentity & {
  version: 1;
  amount: string;
  recipient: string;
  orderId: string;
  payAddress: string;
  payAmount: number;
  feeRate: number;
  paymentStarted: boolean;
  paymentTxid: string;
  inscriptionId: string;
  transferStarted: boolean;
  transferTxid: string;
};

export type Brc20TransferNextAction =
  | "prepare"
  | "pay"
  | "check-order"
  | "send-inscription"
  | "verify-transfer"
  | "complete";

export function getBrc20TransferStorageKey(identity: Brc20TransferIdentity) {
  const parts = [identity.site, identity.address.toLowerCase(), identity.network, identity.kind, identity.ticker.toLowerCase()];
  return `brc20-transfer:v1:${parts.map(part => encodeURIComponent(part)).join(":")}`;
}

export function buildBrc20TransferInscription(ticker: string, amount: string) {
  return JSON.stringify({ p: "brc-20", op: "transfer", tick: ticker, amt: amount });
}

export function getBrc20TransferNextAction(progress: Brc20TransferProgress | null): Brc20TransferNextAction {
  if (!progress?.orderId) return "prepare";
  if (progress.transferTxid) return "complete";
  if (progress.transferStarted) return "verify-transfer";
  if (progress.inscriptionId) return "send-inscription";
  if (progress.paymentStarted || progress.paymentTxid) return "check-order";
  return "pay";
}

const isPositiveDecimal = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
const isTxid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

export function isValidBrc20InscriptionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}i\d+$/i.test(value);
}

export function isConsistentBrc20PaymentState(state: {
  paymentStarted: unknown;
  paymentTxid: unknown;
  inscriptionId: unknown;
}): boolean {
  if (typeof state.paymentStarted !== "boolean") return false;
  const paymentTxid = state.paymentTxid ?? "";
  const inscriptionId = state.inscriptionId ?? "";
  if (
    (paymentTxid !== "" && !isTxid(paymentTxid)) ||
    (inscriptionId !== "" && !isValidBrc20InscriptionId(inscriptionId)) ||
    ((paymentTxid !== "" || inscriptionId !== "") && !state.paymentStarted)
  ) return false;
  return true;
}

export function parseBrc20TransferProgress(raw: string | null, identity: Brc20TransferIdentity): Brc20TransferProgress | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<Brc20TransferProgress> | null;
    if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1) return null;
    if (
      data.site !== identity.site ||
      typeof data.address !== "string" || data.address.toLowerCase() !== identity.address.toLowerCase() ||
      data.network !== identity.network || data.kind !== identity.kind ||
      typeof data.ticker !== "string" || data.ticker.toLowerCase() !== identity.ticker.toLowerCase() ||
      !isPositiveDecimal(data.amount) || typeof data.recipient !== "string" || !data.recipient ||
      typeof data.orderId !== "string" || !data.orderId || typeof data.payAddress !== "string" || !data.payAddress ||
      typeof data.payAmount !== "number" || !Number.isSafeInteger(data.payAmount) || data.payAmount <= 0 ||
      typeof data.feeRate !== "number" || !Number.isFinite(data.feeRate) || data.feeRate <= 0 ||
      typeof data.paymentStarted !== "boolean" || typeof data.transferStarted !== "boolean"
    ) return null;
    const paymentTxid = data.paymentTxid ?? "";
    const inscriptionId = data.inscriptionId ?? "";
    const transferTxid = data.transferTxid ?? "";
    if (
      !isConsistentBrc20PaymentState({ paymentStarted: data.paymentStarted, paymentTxid, inscriptionId }) ||
      (transferTxid !== "" && !isTxid(transferTxid)) ||
      (data.transferStarted && !inscriptionId) ||
      (transferTxid !== "" && !data.transferStarted)
    ) return null;
    return {
      version: 1,
      site: identity.site,
      address: identity.address,
      network: identity.network,
      ticker: identity.ticker,
      kind: identity.kind,
      amount: data.amount,
      recipient: data.recipient,
      orderId: data.orderId,
      payAddress: data.payAddress,
      payAmount: data.payAmount,
      feeRate: data.feeRate,
      paymentStarted: data.paymentStarted,
      paymentTxid,
      inscriptionId,
      transferStarted: data.transferStarted,
      transferTxid,
    };
  } catch {
    return null;
  }
}
