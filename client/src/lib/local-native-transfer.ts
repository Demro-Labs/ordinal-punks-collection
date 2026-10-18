import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import type { OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { getRecommendedFeeEstimate, getSpendableUtxos, validateMempoolAddress, type SpendableUtxo } from "@/lib/mempool";
import { parseFbAmountToSats } from "@/lib/native-fb-send";

const MAX_INPUTS = 20;
const DUST_SATS = 546;
const MAX_FEE_RATE = 1_000;
const NETWORK = bitcoin.networks.bitcoin;

export type LocalNativeTransferPlan = {
  psbtHex: string;
  network: OrdiNetwork;
  recipient: string;
  amountSats: number;
  feeSats: number;
  feeRateSatVb: number;
  inputSats: number;
  changeSats: number;
  inputs: Array<Pick<SpendableUtxo, "txid" | "vout" | "satoshi">>;
};

function estimatedVsize(inputCount: number, outputCount: number) {
  return 10 + inputCount * 69 + outputCount * 31;
}

function selectInputs(utxos: SpendableUtxo[], amountSats: number, feeRateSatVb: number) {
  const selected: SpendableUtxo[] = [];
  let total = 0;
  for (const utxo of utxos) {
    if (selected.length >= MAX_INPUTS) break;
    selected.push(utxo);
    total += utxo.satoshi;
    const feeWithChange = Math.ceil(estimatedVsize(selected.length, 2) * feeRateSatVb);
    if (total >= amountSats + feeWithChange) break;
  }
  if (total < amountSats + Math.ceil(estimatedVsize(selected.length, 2) * feeRateSatVb)) {
    throw new Error(`Solde confirmé sans actifs insuffisant : ${total.toLocaleString("en-US")} sats disponibles pour ${amountSats.toLocaleString("en-US")} sats plus les frais. Aucun transfert n’a été signé.`);
  }
  return selected;
}

export async function prepareLocalNativeTransfer(
  network: OrdiNetwork,
  wallet: OrdiWalletRecord,
  recipient: string,
  amount: string,
): Promise<LocalNativeTransferPlan> {
  const normalizedRecipient = recipient.trim();
  const amountSats = parseFbAmountToSats(amount);
  if (!amountSats) throw new Error("Saisissez un montant BTC/FB positif avec au plus 8 décimales.");
  if (!normalizedRecipient || normalizedRecipient.length > 100) throw new Error("L’adresse destinataire est invalide.");
  const native = wallet.addresses["native-segwit"];
  if (!native) throw new Error("L’adresse Native SegWit du coffre est introuvable.");

  await validateMempoolAddress(network, normalizedRecipient);
  const estimate = await getRecommendedFeeEstimate(network);
  const feeRateSatVb = Math.ceil(estimate.feeRate);
  if (!Number.isSafeInteger(feeRateSatVb) || feeRateSatVb < 1 || feeRateSatVb > MAX_FEE_RATE) throw new Error("Le taux de frais live est invalide; aucun transfert n’a été préparé.");

  const reserve = Math.ceil(estimatedVsize(MAX_INPUTS, 2) * feeRateSatVb);
  const utxos = await getSpendableUtxos(network, native.address, amountSats + reserve);
  const selected = selectInputs(utxos, amountSats, feeRateSatVb);
  const inputSats = selected.reduce((sum, item) => sum + item.satoshi, 0);
  const withChangeFee = Math.ceil(estimatedVsize(selected.length, 2) * feeRateSatVb);
  const provisionalChange = inputSats - amountSats - withChangeFee;
  const outputCount = provisionalChange >= DUST_SATS ? 2 : 1;
  const feeSats = outputCount === 2 ? withChangeFee : inputSats - amountSats;
  const changeSats = outputCount === 2 ? inputSats - amountSats - feeSats : 0;
  if (feeSats <= 0 || !Number.isSafeInteger(feeSats) || (outputCount === 2 && changeSats < DUST_SATS)) throw new Error("La sélection des UTXO ne permet pas de créer une transaction sûre.");

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  for (const utxo of selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: Buffer.from(utxo.scriptPk, "hex"), value: BigInt(utxo.satoshi) },
    });
  }
  psbt.addOutput({ address: normalizedRecipient, value: BigInt(amountSats) });
  if (changeSats > 0) psbt.addOutput({ address: native.address, value: BigInt(changeSats) });

  return {
    psbtHex: psbt.toHex(), network, recipient: normalizedRecipient, amountSats, feeSats, feeRateSatVb,
    inputSats, changeSats, inputs: selected.map(({ txid, vout, satoshi }) => ({ txid, vout, satoshi })),
  };
}
