import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { AddressType, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { getMempoolRawTransaction, getRecommendedFeeEstimate, getSpendableUtxos, validateMempoolAddress, type SpendableUtxo } from "@/lib/mempool";
import { parseFbAmountToSats } from "@/lib/native-fb-send";

// Ensure bitcoinjs-lib and ECC adapters see the same browser Buffer implementation
// even when this transfer builder is imported without the PSBT signer module.
const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalWithBuffer.Buffer) globalWithBuffer.Buffer = Buffer;

const MAX_INPUTS = 20;
const DUST_SATS = 546;
const MAX_FEE_RATE = 1_000;
const NETWORK = bitcoin.networks.bitcoin;
const INPUT_VBYTES: Record<AddressType, number> = {
  legacy: 148,
  "nested-segwit": 91,
  "native-segwit": 69,
  taproot: 58,
};

export type LocalNativeTransferPlan = {
  psbtHex: string;
  network: OrdiNetwork;
  addressType: AddressType;
  sourceAddress: string;
  recipient: string;
  amountSats: number;
  feeSats: number;
  feeRateSatVb: number;
  inputSats: number;
  changeSats: number;
  inputs: Array<Pick<SpendableUtxo, "txid" | "vout" | "satoshi">>;
};

function varIntSize(value: number) { return value < 0xfd ? 1 : value <= 0xffff ? 3 : 5; }
function outputVbytes(address: string) {
  const script = bitcoin.address.toOutputScript(address, NETWORK);
  return 8 + varIntSize(script.length) + script.length;
}
function estimatedVsize(inputCount: number, addressType: AddressType, outputAddresses: string[]) {
  const segwitOverhead = addressType === "legacy" ? 0 : 1;
  return 10 + segwitOverhead + inputCount * INPUT_VBYTES[addressType] + outputAddresses.reduce((sum, address) => sum + outputVbytes(address), 0);
}

function selectInputs(utxos: SpendableUtxo[], amountSats: number, feeRateSatVb: number, addressType: AddressType, recipient: string, changeAddress: string) {
  const candidates = [...utxos].sort((a, b) => b.satoshi - a.satoshi || a.txid.localeCompare(b.txid) || a.vout - b.vout);
  const selected: SpendableUtxo[] = [];
  let total = 0;
  for (const utxo of candidates) {
    if (selected.length >= MAX_INPUTS) break;
    selected.push(utxo);
    total += utxo.satoshi;
    if (!Number.isSafeInteger(total)) throw new Error("Le total des UTXO dépasse la précision sûre; aucun transfert n’a été préparé.");
    const withChangeFee = Math.ceil(estimatedVsize(selected.length, addressType, [recipient, changeAddress]) * feeRateSatVb);
    const noChangeFee = Math.ceil(estimatedVsize(selected.length, addressType, [recipient]) * feeRateSatVb);
    if (total >= amountSats + withChangeFee || (total >= amountSats + noChangeFee && total - amountSats - noChangeFee < DUST_SATS)) break;
  }
  const withChangeFee = Math.ceil(estimatedVsize(selected.length, addressType, [recipient, changeAddress]) * feeRateSatVb);
  const noChangeFee = Math.ceil(estimatedVsize(selected.length, addressType, [recipient]) * feeRateSatVb);
  if (total < amountSats + noChangeFee || (total < amountSats + withChangeFee && total - amountSats - noChangeFee >= DUST_SATS)) {
    throw new Error(`Solde confirmé sans actifs insuffisant : ${total.toLocaleString("en-US")} sats disponibles pour ${amountSats.toLocaleString("en-US")} sats plus les frais. Aucun transfert n’a été signé.`);
  }
  return selected;
}

export async function prepareLocalNativeTransfer(
  network: OrdiNetwork,
  wallet: OrdiWalletRecord,
  addressType: AddressType,
  recipient: string,
  amount: string,
): Promise<LocalNativeTransferPlan> {
  const account = wallet.addresses[addressType];
  if (!account?.address || !account.publicKey || !account.privateKey) throw new Error("La clé locale de l’adresse source est indisponible.");
  const normalizedRecipient = recipient.trim();
  const amountSats = parseFbAmountToSats(amount);
  if (!amountSats || amountSats < DUST_SATS) throw new Error("Le montant doit être positif et supérieur au seuil de poussière Bitcoin/Fractal (546 sats).");
  if (!normalizedRecipient || normalizedRecipient.length > 100) throw new Error("L’adresse destinataire est invalide.");
  const sourceScript = bitcoin.address.toOutputScript(account.address, NETWORK);
  const sourcePublicKey = Buffer.from(account.publicKey, "hex");
  if (!Buffer.from(ecc.pointFromScalar(Buffer.from(account.privateKey, "hex"), true) ?? []).equals(sourcePublicKey)) throw new Error("La clé privée ne correspond pas à l’adresse source du coffre.");

  await validateMempoolAddress(network, normalizedRecipient);
  const estimate = await getRecommendedFeeEstimate(network);
  const feeRateSatVb = Math.ceil(estimate.feeRate);
  if (!Number.isSafeInteger(feeRateSatVb) || feeRateSatVb < 1 || feeRateSatVb > MAX_FEE_RATE) throw new Error("Le taux de frais live est invalide; aucun transfert n’a été préparé.");

  // Collect the complete verified safe set, then let selectInputs calculate fees for the actual inputs.
  // Reserving fees for MAX_INPUTS here rejects fundable transfers when the wallet has less than a 20-input reserve.
  const utxos = await getSpendableUtxos(network, account.address, 1, { collectAll: true });
  const selected = selectInputs(utxos, amountSats, feeRateSatVb, addressType, normalizedRecipient, account.address);
  for (const utxo of selected) {
    if (utxo.address !== account.address || !Buffer.from(utxo.scriptPk, "hex").equals(sourceScript)) throw new Error("Un UTXO sûr ne correspond pas au script de l’adresse source sélectionnée; aucun transfert n’a été construit.");
  }
  const inputSats = selected.reduce((sum, item) => sum + item.satoshi, 0);
  const withChangeFee = Math.ceil(estimatedVsize(selected.length, addressType, [normalizedRecipient, account.address]) * feeRateSatVb);
  const provisionalChange = inputSats - amountSats - withChangeFee;
  const outputCount = provisionalChange >= DUST_SATS ? 2 : 1;
  const feeSats = outputCount === 2 ? withChangeFee : inputSats - amountSats;
  const changeSats = outputCount === 2 ? inputSats - amountSats - feeSats : 0;
  if (feeSats <= 0 || !Number.isSafeInteger(feeSats) || (outputCount === 2 && changeSats < DUST_SATS)) throw new Error("La sélection des UTXO ne permet pas de créer une transaction sûre.");

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  for (const utxo of selected) {
    const baseInput = { hash: utxo.txid, index: utxo.vout, sequence: 0xfffffffd };
    if (addressType === "legacy") {
      const previousTxHex = await getMempoolRawTransaction(network, utxo.txid);
      const previousTx = bitcoin.Transaction.fromHex(previousTxHex);
      const previousOutput = previousTx.outs[utxo.vout];
      if (previousTx.getId().toLowerCase() !== utxo.txid.toLowerCase() || !previousOutput || Number(previousOutput.value) !== utxo.satoshi || !Buffer.from(previousOutput.script).equals(sourceScript)) {
        throw new Error(`La transaction précédente de l’UTXO ${utxo.txid}:${utxo.vout} ne correspond pas aux données Mempool et à l’indexeur.`);
      }
      psbt.addInput({ ...baseInput, nonWitnessUtxo: Buffer.from(previousTxHex, "hex") });
    } else {
      const witnessUtxo = { script: Buffer.from(utxo.scriptPk, "hex"), value: BigInt(utxo.satoshi) };
      if (addressType === "nested-segwit") {
        const redeem = bitcoin.payments.p2wpkh({ pubkey: sourcePublicKey, network: NETWORK }).output;
        if (!redeem) throw new Error("Impossible de dériver le redeem script Nested SegWit.");
        psbt.addInput({ ...baseInput, witnessUtxo, redeemScript: redeem });
      } else if (addressType === "taproot") {
        psbt.addInput({ ...baseInput, witnessUtxo, tapInternalKey: Buffer.from(ecc.xOnlyPointFromPoint(sourcePublicKey)) });
      } else {
        psbt.addInput({ ...baseInput, witnessUtxo });
      }
    }
  }
  psbt.addOutput({ address: normalizedRecipient, value: BigInt(amountSats) });
  if (changeSats > 0) psbt.addOutput({ address: account.address, value: BigInt(changeSats) });

  return {
    psbtHex: psbt.toHex(), network, addressType, sourceAddress: account.address, recipient: normalizedRecipient, amountSats, feeSats, feeRateSatVb,
    inputSats, changeSats, inputs: selected.map(({ txid, vout, satoshi }) => ({ txid, vout, satoshi })),
  };
}
