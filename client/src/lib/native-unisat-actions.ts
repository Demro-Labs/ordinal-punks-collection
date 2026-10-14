export type UniSatTxResult = string | { txid?: string };

type UniSatBalance = { confirmed?: number; unconfirmed?: number; total?: number };
type UniSatBalanceV2 = { available?: number; unavailable?: number; total?: number };

type FeeUtxo = { txid?: unknown; vout?: unknown };

export type NativeUniSatProvider = {
  sendInscription?: (recipient: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<UniSatTxResult>;
  sendBitcoin?: (recipient: string, satoshis: number, options?: { feeRate?: number }) => Promise<UniSatTxResult>;
  getBalance?: () => Promise<UniSatBalance>;
  getBalanceV2?: () => Promise<UniSatBalanceV2>;
  getBitcoinUtxos?: (cursor: number, size: number) => Promise<unknown>;
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
  const action = operation === "ordinal-transfer"
    ? "UTXO de frais sûrs insuffisants pour ce transfert Ordinal. L’Ordinal doit rester hors des fonds utilisés pour les frais. Ajoute des sats du réseau affiché dans un UTXO distinct, confirmé et sans inscription."
    : operation === "fb-transfer"
      ? "Solde dépensable insuffisant pour le montant FB et les frais. Ajoute des sats FB dans un UTXO distinct, confirmé et sans inscription sur l’adresse Fractal."
      : "Solde dépensable insuffisant pour payer ce reçu Inscribe et les frais. Ajoute des sats dans un UTXO distinct, confirmé et sans inscription sur la même adresse et le même réseau. Garde le reçu existant; ne crée pas une nouvelle commande.";
  const outcome = definitelyNotBroadcast
    ? "Aucune transaction n’a été signée ni diffusée."
    : "Le wallet n’a pas confirmé l’issue; vérifie UniSat et Mempool avant de réessayer, car la transaction pourrait déjà avoir été envoyée.";
  return { message: `${action} ${outcome}`, definitelyNotBroadcast };
}

/** UniSat Mobile's native Fractal inscription transfer is not used; preserve desktop and Bitcoin behavior. */
export function requiresVerifiedPsbtForMobileFractalTransfer(isMobileUniSat: boolean, networkEnum?: string) {
  return isMobileUniSat && networkEnum === "FRACTAL_BITCOIN_MAINNET";
}

function requireTxid(result: UniSatTxResult, action: string) {
  const txid = typeof result === "string" ? result : result?.txid;
  if (!txid || !TXID_PATTERN.test(txid)) {
    throw new Error(`UniSat did not return a valid transaction ID after the native ${action}. Check UniSat activity and Mempool before retrying.`);
  }
  return txid.toLowerCase();
}

/** Desktop-style fee-UTXO preflight; call only from the mobile transfer path. */
export async function ensureNativeInscriptionFeeBalance(
  provider: NativeUniSatProvider,
  networkEnum: string,
  inscription: { location?: string },
  feeRate: number,
) {
  const networkLabel = networkEnum === "BITCOIN_MAINNET"
    ? "Bitcoin"
    : networkEnum === "FRACTAL_BITCOIN_MAINNET" ? "Fractal Bitcoin" : "selected network";
  const feeAsset = networkEnum === "BITCOIN_MAINNET" ? "BTC" : "FB";
  // Reserve a conservative 350 vB for the inscription transfer plus a non-dust change output.
  const minimumFeeBalance = Math.max(1_000, Math.ceil(feeRate * 350) + 600);
  let availableBalance: number | null = null;

  if (provider.getBalanceV2) {
    const balance = await provider.getBalanceV2();
    const available = Number(balance.available ?? 0);
    if (!Number.isFinite(available) || available <= 0) {
      throw new Error(`UniSat reports no spendable ${feeAsset} fee balance on ${networkLabel}. Add a separate, non-dust ${feeAsset} UTXO before transferring.`);
    }
    availableBalance = available;
    if (available < minimumFeeBalance) {
      const additional = Math.ceil(minimumFeeBalance - available);
      throw new Error(`Insufficient spendable ${feeAsset} on ${networkLabel} for fees and non-dust change. UniSat reports ${Math.floor(available)} sats available; add about ${additional} more sats (estimated minimum ${minimumFeeBalance} sats at ${feeRate} sat/vB).`);
    }
  }

  if (provider.getBitcoinUtxos) {
    const result = await provider.getBitcoinUtxos(0, 100);
    const utxos: unknown[] = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "list" in result && Array.isArray(result.list)
        ? result.list
        : [];
    const location = typeof inscription.location === "string" ? inscription.location : "";
    const inscriptionOutpoint = location.match(/^([a-f0-9]{64}):(\d+)(?::\d+)?$/i);
    const spendableUtxos = inscriptionOutpoint
      ? utxos.filter(item => {
          if (!item || typeof item !== "object") return false;
          const utxo = item as FeeUtxo;
          return typeof utxo.txid === "string"
            && typeof utxo.vout === "number"
            && `${utxo.txid}:${utxo.vout}`.toLowerCase() !== `${inscriptionOutpoint[1]}:${inscriptionOutpoint[2]}`.toLowerCase();
        })
      : utxos;
    if (spendableUtxos.length === 0) {
      throw new Error(`No separate spendable ${feeAsset} fee UTXO is available on ${networkLabel}. The inscription output itself is reserved for the Ordinal and cannot also pay network fees; add another non-dust UTXO.`);
    }
    return;
  }

  if (availableBalance !== null) return;
  if (!provider.getBalance) return;
  const balance = await provider.getBalance();
  const confirmed = Number(balance.confirmed ?? 0);
  const unconfirmed = Number(balance.unconfirmed ?? 0);
  const total = Number(balance.total ?? confirmed + unconfirmed);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`Add a separate, spendable ${feeAsset} UTXO to this UniSat wallet to pay the ${networkLabel} network fee before transferring.`);
  }
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
