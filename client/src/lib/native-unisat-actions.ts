import { getSpendableUtxos } from "@/lib/mempool";
export type UniSatTxResult = string | { txid?: string };

type UniSatBalance = { confirmed?: number; unconfirmed?: number; total?: number };
type UniSatBalanceV2 = { available?: number; unavailable?: number; total?: number };


export type NativeUniSatProvider = {
  sendInscription?: (recipient: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<UniSatTxResult>;
  sendBitcoin?: (recipient: string, satoshis: number, options?: { feeRate?: number }) => Promise<UniSatTxResult>;
  getBalance?: () => Promise<UniSatBalance>;
  getBalanceV2?: () => Promise<UniSatBalanceV2>;
  getBitcoinUtxos?: (cursor: number, size: number) => Promise<unknown>;
};

export type NativeUniSatRuneProvider = {
  sendRunes?: (
    recipient: string,
    runeid: string,
    amount: string,
    options?: { feeRate?: number }
  ) => Promise<unknown>;
};

export type MobileNativePaymentFallbackGate = {
  isMobileUniSat: boolean;
  hasReceipt: boolean;
  hasPaymentPlan: boolean;
  hasWorkerAttestation: boolean;
  hasPaymentTxid: boolean;
};

export function canUseMobileNativePaymentFallback(gate: MobileNativePaymentFallbackGate) {
  return gate.isMobileUniSat && gate.hasReceipt && gate.hasPaymentPlan && gate.hasWorkerAttestation && !gate.hasPaymentTxid;
}

const TXID_PATTERN = /^[a-f0-9]{64}$/i;

export type MobileUtxoOperation = "ordinal-transfer" | "fb-transfer" | "inscribe-payment";
export type MobileUtxoErrorGuidance = { message: string; definitelyNotBroadcast: boolean };

function getWalletErrorText(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; shortMessage?: unknown; reason?: unknown };
    for (const detail of [value.message, value.shortMessage, value.reason]) {
      if (typeof detail === "string" && detail.trim()) return detail.trim();
    }
  }
  return "";
}

/** Turn insufficient mobile wallet funds into actionable guidance without guessing transaction status. */
export function getMobileUtxoErrorGuidance(error: unknown, operation: MobileUtxoOperation): MobileUtxoErrorGuidance | null {
  const detail = getWalletErrorText(error);
  const insufficient = /(?:insufficient|not enough|insuffisant|insuffisante|insuffisants|insuffisantes)/i.test(detail)
    && /(?:utxos?|funds?|balance|sats?|fees?|solde|fonds)/i.test(detail);
  if (!insufficient) return null;

  const definitelyNotBroadcast = /no transaction was signed or broadcast|no transaction was broadcast|no (?:payment|transfer) was sent|aucune transaction n[’']a été (?:signée|diffusée)/i.test(detail);
  if (operation === "ordinal-transfer" && /Insufficient safe fee UTXO for this Ordinal transfer/i.test(detail)) {
    return { message: detail, definitelyNotBroadcast };
  }
  const action = operation === "ordinal-transfer"
    ? "Insufficient safe fee UTXOs for this Ordinal transfer. The Ordinal must remain outside fee funds. Add sats from the displayed network in a separate confirmed UTXO with no inscription."
    : operation === "fb-transfer"
      ? "Insufficient spendable balance for the FB amount and fees. Add FB sats in a separate confirmed UTXO with no inscription on the Fractal address."
      : "Insufficient spendable balance to pay this Inscribe receipt and fees. Add sats in a separate confirmed UTXO with no inscription on the same address and network. Keep the existing receipt; do not create a new order.";
  const outcome = definitelyNotBroadcast
    ? "No transaction was signed or broadcast."
    : "The wallet did not confirm the outcome; check UniSat and Mempool before retrying because the transaction may already have been sent.";
  return { message: `${action} ${outcome}`, definitelyNotBroadcast };
}

function requireTxid(result: unknown, action: string) {
  const txid =
    typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? (result as { txid?: unknown }).txid
        : null;
  if (typeof txid !== "string" || !TXID_PATTERN.test(txid)) {
    throw new Error(`UniSat did not return a valid transaction ID after the native ${action}. Check UniSat activity and Mempool before retrying.`);
  }
  return txid.toLowerCase();
}

/** Mobile-only preflight: require one confirmed, verified asset-free fee UTXO separate from the Ordinal. */
export async function ensureNativeInscriptionFeeBalance(
  networkEnum: string,
  address: string,
  inscription: { location?: string },
  feeRate: number,
) {
  const networkLabel = networkEnum === "BITCOIN_MAINNET"
    ? "Bitcoin"
    : networkEnum === "FRACTAL_BITCOIN_MAINNET" ? "Fractal Bitcoin" : "selected network";
  const feeAsset = networkEnum === "BITCOIN_MAINNET" ? "BTC" : "FB";
  // Conservative estimate for the transfer plus a non-dust change output.
  const minimumFeeBalance = Math.max(1_000, Math.ceil(feeRate * 350) + 600);
  const location = typeof inscription.location === "string" ? inscription.location : "";
  const inscriptionOutpoint = location.match(/^([a-f0-9]{64}):(\d+)(?::\d+)?$/i);
  let verifiedUtxos: Awaited<ReturnType<typeof getSpendableUtxos>>;
  try {
    // The Worker verifies confirmation, no inscriptions, no Runes/Alkanes, and current spendability.
    verifiedUtxos = await getSpendableUtxos(networkEnum, address, minimumFeeBalance, { mobile: true });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not verify a safe fee UTXO on ${networkLabel} for ${address}. Add at least ${minimumFeeBalance.toLocaleString()} ${feeAsset} sats to this address in a separate confirmed UTXO with no inscription, Runes, or Alkanes, then check again. No transaction was signed or broadcast. Verification detail: ${detail}`,
    );
  }
  const feeUtxos = verifiedUtxos.filter(utxo =>
    !inscriptionOutpoint || `${utxo.txid}:${utxo.vout}`.toLowerCase() !== `${inscriptionOutpoint[1]}:${inscriptionOutpoint[2]}`.toLowerCase(),
  );
  const largestSafeUtxo = feeUtxos.reduce((largest, utxo) => Math.max(largest, utxo.satoshi), 0);
  if (largestSafeUtxo < minimumFeeBalance) {
    const additional = minimumFeeBalance - largestSafeUtxo;
    throw new Error(
      `Insufficient safe fee UTXO for this Ordinal transfer on ${networkLabel}. The Ordinal must remain outside fee funds. Add at least ${additional.toLocaleString()} more ${feeAsset} sats to ${address} so one separate UTXO reaches ${minimumFeeBalance.toLocaleString()} sats; it must be confirmed and contain no inscription, Runes, or Alkanes. No transaction was signed or broadcast.`,
    );
  }
}

/** Verify confirmed, asset-free funds before native BTC/FB payments. */
export async function ensureNativePaymentBalance(
  networkEnum: string,
  address: string,
  amountSats: number,
  feeRate: number,
  operation: Exclude<MobileUtxoOperation, "ordinal-transfer">,
  options: { mobile?: boolean } = {},
) {
  const networkLabel = networkEnum === "BITCOIN_MAINNET" ? "Bitcoin" : networkEnum === "FRACTAL_BITCOIN_MAINNET" ? "Fractal Bitcoin" : "selected network";
  const feeAsset = networkEnum === "BITCOIN_MAINNET" ? "BTC" : "FB";
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error(`Invalid ${operation} amount or fee rate; no transaction was signed or broadcast.`);
  }
  const minimumSats = amountSats + Math.ceil(feeRate * 250) + 600;
  let verifiedUtxos: Awaited<ReturnType<typeof getSpendableUtxos>>;
  try {
    verifiedUtxos = await getSpendableUtxos(networkEnum, address, minimumSats, { mobile: options.mobile === true });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not verify safe ${feeAsset} UTXOs for this ${operation} on ${networkLabel}. Add confirmed ${feeAsset} sats in uninscribed UTXOs, then check again. No transaction was signed or broadcast. Verification detail: ${detail}`);
  }
  const safeSats = verifiedUtxos.reduce((total, utxo) => total + utxo.satoshi, 0);
  if (safeSats < minimumSats) {
    throw new Error(`Insufficient safe ${feeAsset} UTXOs for this ${operation} on ${networkLabel}. Required: ${minimumSats.toLocaleString()} sats; verified: ${safeSats.toLocaleString()} sats. No transaction was signed or broadcast.`);
  }
}
/** Ask UniSat itself to construct, review, sign, and broadcast an inscription transfer.
 * Keep the bridge call synchronous for UniSat Mobile's user-gesture requirement.
 */
export function sendNativeUniSatInscription(
  provider: NativeUniSatProvider,
  toAddress: string,
  inscriptionId: string,
  feeRate: number,
) {
  if (!provider.sendInscription) return Promise.reject(new Error("This UniSat context does not expose native sendInscription; no transfer was sent."));
  if (!toAddress || !/^[a-f0-9]{64}i\d+$/i.test(inscriptionId) || !Number.isFinite(feeRate) || feeRate <= 0) {
    return Promise.reject(new Error("Invalid native UniSat inscription transfer parameters; no transfer was sent."));
  }
  return provider.sendInscription(toAddress, inscriptionId, { feeRate }).then(result => requireTxid(result, "inscription transfer"));
}

/** Ask UniSat itself to construct, review, sign, and broadcast a Rune transfer. */
export function sendNativeUniSatRunes(
  provider: NativeUniSatRuneProvider,
  toAddress: string,
  runeid: string,
  amount: string,
  feeRate: number,
) {
  if (!provider.sendRunes) {
    return Promise.reject(
      new Error("This UniSat context does not expose native sendRunes; no transfer was sent.")
    );
  }
  if (!toAddress || !runeid || !amount.trim() || !Number.isFinite(feeRate) || feeRate <= 0) {
    return Promise.reject(new Error("Invalid native UniSat Rune transfer parameters; no transfer was sent."));
  }
  // Invoke synchronously inside the caller's explicit tap for UniSat Mobile.
  return provider
    .sendRunes(toAddress, runeid, amount, { feeRate })
    .then(result => requireTxid(result, "Rune transfer"));
}

/** Ask UniSat itself to construct, review, sign, and broadcast the inscription-order payment.
 * Keep the bridge call synchronous for UniSat Mobile's user-gesture requirement.
 */
export function sendNativeUniSatBitcoinPayment(
  provider: NativeUniSatProvider,
  toAddress: string,
  satoshis: number,
  feeRate: number,
) {
  if (!provider.sendBitcoin) return Promise.reject(new Error("This UniSat context does not expose native sendBitcoin; no payment was sent."));
  if (!toAddress || !Number.isSafeInteger(satoshis) || satoshis <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    return Promise.reject(new Error("Invalid native UniSat payment parameters; no payment was sent."));
  }
  // Use UniSat's documented positional signature on every platform. Invoke it
  // synchronously inside the tap handler so mobile can open its approval UI.
  return provider.sendBitcoin(toAddress, satoshis, { feeRate })
    .then(tx => requireTxid(tx, "Bitcoin payment"));
}
