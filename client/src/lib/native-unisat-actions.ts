export type UniSatTxResult = string | { txid?: string };

export type NativeUniSatProvider = {
  sendInscription?: (recipient: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<UniSatTxResult>;
  sendBitcoin?: (recipient: string, satoshis: number, options?: { feeRate?: number }) => Promise<UniSatTxResult>;
};

const TXID_PATTERN = /^[a-f0-9]{64}$/i;

function requireTxid(result: UniSatTxResult, action: string) {
  const txid = typeof result === "string" ? result : result?.txid;
  if (!txid || !TXID_PATTERN.test(txid)) {
    throw new Error(`UniSat did not return a valid transaction ID after the native ${action}. Check UniSat activity and Mempool before retrying.`);
  }
  return txid.toLowerCase();
}

/** Ask UniSat itself to construct, review, sign, and broadcast an inscription transfer. */
export async function sendNativeUniSatInscription(
  provider: NativeUniSatProvider,
  recipient: string,
  inscriptionId: string,
  feeRate: number,
) {
  if (!provider.sendInscription) throw new Error("This UniSat context does not expose native sendInscription; no transfer was sent.");
  if (!recipient || !/^[a-f0-9]{64}i\d+$/i.test(inscriptionId) || !Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error("Invalid native UniSat inscription transfer parameters; no transfer was sent.");
  }
  const result = await provider.sendInscription(recipient, inscriptionId, { feeRate });
  return requireTxid(result, "inscription transfer");
}

/** Ask UniSat itself to construct, review, sign, and broadcast the inscription-order payment. */
export async function sendNativeUniSatBitcoinPayment(
  provider: NativeUniSatProvider,
  recipient: string,
  satoshis: number,
  feeRate: number,
) {
  if (!provider.sendBitcoin) throw new Error("This UniSat context does not expose native sendBitcoin; no payment was sent.");
  if (!recipient || !Number.isSafeInteger(satoshis) || satoshis <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error("Invalid native UniSat payment parameters; no payment was sent.");
  }
  const result = await provider.sendBitcoin(recipient, satoshis, { feeRate });
  return requireTxid(result, "Bitcoin payment");
}
