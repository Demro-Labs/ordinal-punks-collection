import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";

bitcoin.initEccLib(ecc);

type RawProviderUtxo = {
  txid?: unknown;
  vout?: unknown;
  value?: unknown;
  satoshis?: unknown;
  amount?: unknown;
  inscriptions?: unknown;
  inscription?: unknown;
};

export type MobilePaymentProvider = {
  getBitcoinUtxos?: (cursor: number, size: number) => Promise<unknown>;
  signPsbt?: (psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number; address?: string }> }) => Promise<string>;
  pushTx?: (options: { rawtx: string }) => Promise<string | { txid?: string }>;
};

const DUST = 546;
const MAX_UTXOS = 100;

function extractUtxos(value: unknown): RawProviderUtxo[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === "object") as RawProviderUtxo[];
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.list)) return object.list.filter(item => item && typeof item === "object") as RawProviderUtxo[];
  if (Array.isArray(object.utxos)) return object.utxos.filter(item => item && typeof item === "object") as RawProviderUtxo[];
  return [];
}

function numberValue(value: RawProviderUtxo) {
  const result = Number(value.value ?? value.satoshis ?? value.amount ?? 0);
  return Number.isSafeInteger(result) ? result : 0;
}

function isInscribed(value: RawProviderUtxo) {
  return Boolean(value.inscription) || (Array.isArray(value.inscriptions) && value.inscriptions.length > 0);
}

export async function sendMobilePayment(params: {
  provider: MobilePaymentProvider;
  senderAddress: string;
  payAddress: string;
  amount: number;
  feeRate: number;
}) {
  const { provider, senderAddress, payAddress, amount, feeRate } = params;
  if (!provider.getBitcoinUtxos || !provider.signPsbt || !provider.pushTx) {
    throw new Error("Cette version d’UniSat mobile ne fournit pas signPsbt/pushTx dans le navigateur intégré.");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error("Montant ou fee rate invalide pour la transaction mobile.");
  }

  const network = bitcoin.networks.bitcoin;
  const senderScript = bitcoin.address.toOutputScript(senderAddress, network);
  const raw = await provider.getBitcoinUtxos(0, MAX_UTXOS);
  const candidates = extractUtxos(raw)
    .filter(item => !isInscribed(item))
    .map(item => ({
      txid: typeof item.txid === "string" ? item.txid.toLowerCase() : "",
      vout: Number(item.vout),
      value: numberValue(item),
    }))
    .filter(item => /^[a-f0-9]{64}$/.test(item.txid) && Number.isSafeInteger(item.vout) && item.vout >= 0 && item.value >= DUST)
    .sort((left, right) => right.value - left.value);

  if (!candidates.length) throw new Error("UniSat mobile n’a retourné aucun UTXO disponible pour payer la commande.");

  let selected: typeof candidates = [];
  let change = 0;
  let funded = false;
  for (const candidate of candidates) {
    selected = [...selected, candidate];
    const estimatedVbytes = 10 + selected.length * 110 + 2 * 34;
    const fee = Math.ceil(estimatedVbytes * feeRate);
    const possibleChange = selected.reduce((sum, item) => sum + item.value, 0) - amount - fee;
    if (possibleChange >= DUST) {
      change = possibleChange;
      funded = true;
      break;
    }
    const feeWithoutChange = Math.ceil((10 + selected.length * 110 + 34) * feeRate);
    const remainder = selected.reduce((sum, item) => sum + item.value, 0) - amount - feeWithoutChange;
    if (remainder >= 0 && remainder <= Math.max(200, Math.ceil(feeRate * 25))) {
      change = 0;
      funded = true;
      break;
    }
  }

  if (!selected.length || !funded) {
    throw new Error("Solde UniSat mobile insuffisant après exclusion des UTXO contenant des inscriptions.");
  }

  const psbt = new bitcoin.Psbt({ network });
  selected.forEach(item => psbt.addInput({
    hash: item.txid,
    index: item.vout,
    witnessUtxo: { script: senderScript, value: BigInt(item.value) },
  }));
  psbt.addOutput({ address: payAddress, value: BigInt(amount) });
  if (change >= DUST) psbt.addOutput({ address: senderAddress, value: BigInt(change) });

  const signedHex = await provider.signPsbt(psbt.toHex(), {
    autoFinalized: true,
    toSignInputs: selected.map((_, index) => ({ index, address: senderAddress })),
  });
  if (typeof signedHex !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(signedHex)) {
    throw new Error("UniSat mobile n’a pas retourné de PSBT signé valide.");
  }

  const signed = bitcoin.Psbt.fromHex(signedHex, { network });
  const rawTx = signed.extractTransaction().toHex();
  const pushed = await provider.pushTx({ rawtx: rawTx });
  const txid = typeof pushed === "string" ? pushed : pushed?.txid;
  if (!txid || !/^[a-f0-9]{64}$/i.test(txid)) throw new Error("UniSat mobile n’a pas retourné de TXID après diffusion.");
  return txid;
}
