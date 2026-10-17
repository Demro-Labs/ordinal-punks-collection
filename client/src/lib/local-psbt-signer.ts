import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { getMempoolConfig } from "@/lib/mempool";

bitcoin.initEccLib(ecc);
const NETWORK = bitcoin.networks.bitcoin;
const MAX_INPUTS = 20;
const MAX_OUTPUTS = 20;
const MAX_FEE_RATE = 1_000;

export type LocalPsbtReview = {
  psbtHex: string;
  inputCount: number;
  outputCount: number;
  inputSats: number;
  outputSats: number;
  feeSats: number;
  feeRateSatVb: number | null;
  outputs: Array<{ address: string; valueSats: number }>;
};

function hexBytes(value: string, label: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error(`${label} invalide.`);
  return Buffer.from(value, "hex");
}
function localNativeScript(wallet: OrdiWalletRecord) {
  const address = wallet.addresses["native-segwit"];
  if (!address) throw new Error("L’adresse Native SegWit du coffre est introuvable.");
  const script = bitcoin.address.toOutputScript(address.address, NETWORK);
  return { address, script };
}
function parsePsbt(psbtHex: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(psbtHex) || psbtHex.length > 2_000_000) throw new Error("PSBT invalide ou trop volumineux.");
  try { return bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK }); } catch { throw new Error("Impossible de décoder ce PSBT."); }
}
function inputValue(input: { witnessUtxo?: { value: bigint; script: Uint8Array }; nonWitnessUtxo?: Uint8Array }) {
  if (!input.witnessUtxo) throw new Error("Chaque entrée doit contenir witnessUtxo; aucune signature n’a été produite.");
  const value = Number(input.witnessUtxo.value);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Valeur d’entrée PSBT invalide.");
  return value;
}
export function reviewLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord): LocalPsbtReview {
  const psbt = parsePsbt(psbtHex);
  if (psbt.inputCount < 1 || psbt.inputCount > MAX_INPUTS) throw new Error("Le PSBT doit contenir entre 1 et 20 entrées.");
  if (psbt.txOutputs.length < 1 || psbt.txOutputs.length > MAX_OUTPUTS) throw new Error("Le PSBT doit contenir entre 1 et 20 sorties.");
  const { script } = localNativeScript(wallet);
  let inputSats = 0;
  for (const input of psbt.data.inputs) {
    inputSats += inputValue(input);
    if (!input.witnessUtxo || !Buffer.from(input.witnessUtxo.script).equals(script)) throw new Error("Ce PSBT contient une entrée qui n’appartient pas à l’adresse Native SegWit du coffre.");
    if (input.nonWitnessUtxo) throw new Error("Les entrées non-witness ne sont pas acceptées par le signer local.");
  }
  const outputs = psbt.txOutputs.map(output => {
    const value = Number(output.value);
    if (!Number.isSafeInteger(value) || value < 546) throw new Error("Le PSBT contient une sortie sous le seuil dust.");
    let address = "script:" + Buffer.from(output.script).toString("hex");
    try { address = bitcoin.address.fromOutputScript(output.script, NETWORK); } catch { /* OP_RETURN ou script non adressable */ }
    return { address, valueSats: value };
  });
  const outputSats = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  const feeSats = inputSats - outputSats;
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) throw new Error("Le PSBT doit avoir des frais positifs.");
  const feeRateSatVb = null;
  if (feeRateSatVb !== null && feeRateSatVb > MAX_FEE_RATE) throw new Error("Le taux de frais dépasse la limite de sécurité locale.");
  return { psbtHex, inputCount: psbt.inputCount, outputCount: outputs.length, inputSats, outputSats, feeSats, feeRateSatVb, outputs };
}

export function signLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = reviewLocalPsbt(psbtHex, wallet);
  if (current.psbtHex.toLowerCase() !== review.psbtHex.toLowerCase()) throw new Error("Le PSBT a changé depuis la revue; aucune signature n’a été produite.");
  const { address, script } = localNativeScript(wallet);
  const privateKey = hexBytes(address.privateKey, "Clé privée locale");
  if (!ecc.isPrivate(privateKey)) throw new Error("La clé privée locale n’est pas valide.");
  const signer = {
    publicKey: hexBytes(address.publicKey, "Clé publique locale"),
    sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, privateKey)),
  };
  const psbt = parsePsbt(psbtHex);
  psbt.data.inputs.forEach((input, index) => {
    if (!input.witnessUtxo || !Buffer.from(input.witnessUtxo.script).equals(script)) throw new Error("Entrée locale inattendue; signature annulée.");
    psbt.signInput(index, signer);
  });
  const signed = psbt.toHex();
  if (signed.toLowerCase() === psbtHex.toLowerCase()) throw new Error("Aucune signature n’a été ajoutée au PSBT.");
  return signed;
}

export function finalizeLocalPsbt(signedPsbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = reviewLocalPsbt(signedPsbtHex, wallet);
  if (current.inputCount !== review.inputCount || current.outputCount !== review.outputCount || current.inputSats !== review.inputSats || current.outputSats !== review.outputSats || current.feeSats !== review.feeSats) throw new Error("Le PSBT signé ne correspond plus à la revue; aucune diffusion.");
  const psbt = parsePsbt(signedPsbtHex);
  try { psbt.validateSignaturesOfAllInputs((publicKey, hash, signature) => ecc.verify(hash, publicKey, signature)); psbt.finalizeAllInputs(); } catch { throw new Error("Signature locale absente ou invalide; aucune diffusion."); }
  const tx = psbt.extractTransaction(true);
  if (tx.ins.length !== review.inputCount || tx.outs.length !== review.outputCount) throw new Error("La transaction finale ne correspond pas à la revue.");
  return { rawTxHex: tx.toHex(), txid: tx.getId().toLowerCase() };
}

export async function broadcastLocalPsbt(network: OrdiNetwork, rawTxHex: string, expectedTxid: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Réseau non supporté pour la diffusion.");
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex) || !/^[a-f0-9]{64}$/.test(expectedTxid)) throw new Error("Transaction locale invalide.");
  const response = await fetch(`${config.api}/api/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawTxHex });
  const returned = (await response.text()).replace(/^\"|\"$/g, "").toLowerCase();
  if (!response.ok || returned !== expectedTxid) throw new Error(`Diffusion incertaine. Vérifiez le TXID ${expectedTxid} dans Mempool avant toute nouvelle tentative.`);
  return returned;
}
