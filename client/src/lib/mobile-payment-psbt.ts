import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { getSpendableUtxos } from "@/lib/mempool";

bitcoin.initEccLib(ecc);

export type MobilePaymentProvider = {
  signPsbt?: (psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number; address?: string }> }) => Promise<string>;
  pushPsbt?: (psbtHex: string) => Promise<string | { txid?: string }>;
  pushTx?: (options: { rawtx: string }) => Promise<string | { txid?: string }>;
};

const DUST = 546;

function sameScript(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function sendMobilePayment(params: {
  provider: MobilePaymentProvider;
  senderAddress: string;
  payAddress: string;
  amount: number;
  feeRate: number;
  chain: string;
  onApprovalStarted?: () => void;
}) {
  const { provider, senderAddress, payAddress, amount, feeRate, chain, onApprovalStarted } = params;
  if (!provider.signPsbt || (!provider.pushPsbt && !provider.pushTx)) {
    throw new Error("Ce navigateur UniSat ne fournit pas la signature PSBT et la diffusion nécessaires. Aucun paiement n’a été envoyé.");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error("Montant ou fee rate invalide pour la transaction mobile. Aucun paiement n’a été envoyé.");
  }

  const network = bitcoin.networks.bitcoin;
  const senderScript = bitcoin.address.toOutputScript(senderAddress, network);
  const minimumSats = amount + Math.ceil((10 + 110 + 2 * 34) * feeRate);
  const safeUtxos = await getSpendableUtxos(chain, senderAddress, minimumSats);
  const candidates = safeUtxos
    .map(item => ({
      txid: item.txid.toLowerCase(),
      vout: item.vout,
      value: item.satoshi,
      script: Uint8Array.from(item.scriptPk.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16)),
    }))
    .filter(item =>
      /^[a-f0-9]{64}$/.test(item.txid) && Number.isSafeInteger(item.vout) && item.vout >= 0 &&
      Number.isSafeInteger(item.value) && item.value >= 600 && sameScript(item.script, senderScript)
    )
    .sort((left, right) => right.value - left.value);

  if (!candidates.length) throw new Error("Aucun UTXO sûr vérifié n’est disponible pour cette adresse. Aucun paiement n’a été envoyé.");

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
    throw new Error("Le solde des UTXO sûrs est insuffisant après calcul des frais. Aucun paiement n’a été envoyé.");
  }

  const psbt = new bitcoin.Psbt({ network });
  selected.forEach(item => psbt.addInput({
    hash: item.txid,
    index: item.vout,
    witnessUtxo: { script: item.script, value: BigInt(item.value) },
  }));
  psbt.addOutput({ address: payAddress, value: BigInt(amount) });
  if (change >= DUST) psbt.addOutput({ address: senderAddress, value: BigInt(change) });

  onApprovalStarted?.();
  const signedHex = await provider.signPsbt(psbt.toHex(), {
    autoFinalized: true,
    toSignInputs: selected.map((_, index) => ({ index, address: senderAddress })),
  });
  if (typeof signedHex !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(signedHex)) {
    throw new Error("UniSat mobile n’a pas retourné de PSBT signé valide.");
  }

  const signed = bitcoin.Psbt.fromHex(signedHex, { network });
  const rawTx = signed.extractTransaction().toHex();
  const pushed = provider.pushPsbt
    ? await provider.pushPsbt(signed.toHex())
    : await provider.pushTx!({ rawtx: rawTx });
  const txid = typeof pushed === "string" ? pushed : pushed?.txid;
  if (!txid || !/^[a-f0-9]{64}$/i.test(txid)) throw new Error("UniSat mobile n’a pas retourné de TXID après diffusion.");
  return txid;
}
