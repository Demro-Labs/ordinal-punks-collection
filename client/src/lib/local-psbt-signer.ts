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
  if (!address) throw new Error("The vault Native SegWit address was not found.");
  const script = bitcoin.address.toOutputScript(address.address, NETWORK);
  return { address, script };
}
function parsePsbt(psbtHex: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(psbtHex) || psbtHex.length > 2_000_000) throw new Error("PSBT invalide ou trop volumineux.");
  try { return bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK }); } catch { throw new Error("Unable to decode this PSBT."); }
}
function inputValue(input: { witnessUtxo?: { value: bigint; script: Uint8Array }; nonWitnessUtxo?: Uint8Array }) {
  if (!input.witnessUtxo) throw new Error("Every input must include witnessUtxo; no signature was created.");
  const value = Number(input.witnessUtxo.value);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid PSBT input value.");
  return value;
}
export function reviewLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord): LocalPsbtReview {
  const psbt = parsePsbt(psbtHex);
  if (psbt.inputCount < 1 || psbt.inputCount > MAX_INPUTS) throw new Error("The PSBT must contain between 1 and 20 inputs.");
  if (psbt.txOutputs.length < 1 || psbt.txOutputs.length > MAX_OUTPUTS) throw new Error("The PSBT must contain between 1 and 20 outputs.");
  const { script } = localNativeScript(wallet);
  let inputSats = 0;
  for (const input of psbt.data.inputs) {
    inputSats += inputValue(input);
    if (!input.witnessUtxo || !Buffer.from(input.witnessUtxo.script).equals(script)) throw new Error("This PSBT contains an input that does not belong to the vault Native SegWit address.");
    if (input.nonWitnessUtxo) throw new Error("Non-witness inputs are not accepted by the local signer.");
  }
  const outputs = psbt.txOutputs.map(output => {
    const value = Number(output.value);
    if (!Number.isSafeInteger(value) || value < 546) throw new Error("The PSBT contains an output below the dust threshold.");
    let address = "script:" + Buffer.from(output.script).toString("hex");
    try { address = bitcoin.address.fromOutputScript(output.script, NETWORK); } catch { /* OP_RETURN ou script non adressable */ }
    return { address, valueSats: value };
  });
  const outputSats = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  const feeSats = inputSats - outputSats;
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) throw new Error("The PSBT must have a positive fee.");
  const feeRateSatVb = null;
  if (feeRateSatVb !== null && feeRateSatVb > MAX_FEE_RATE) throw new Error("The fee rate exceeds the local safety limit.");
  return { psbtHex, inputCount: psbt.inputCount, outputCount: outputs.length, inputSats, outputSats, feeSats, feeRateSatVb, outputs };
}

export function signLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = reviewLocalPsbt(psbtHex, wallet);
  if (current.psbtHex.toLowerCase() !== review.psbtHex.toLowerCase()) throw new Error("The PSBT changed after review; no signature was created.");
  const { address, script } = localNativeScript(wallet);
  const privateKey = hexBytes(address.privateKey, "Local private key");
  if (!ecc.isPrivate(privateKey)) throw new Error("The local private key is invalid.");
  const signer = {
    publicKey: hexBytes(address.publicKey, "Local public key"),
    sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, privateKey)),
  };
  const psbt = parsePsbt(psbtHex);
  psbt.data.inputs.forEach((input, index) => {
    if (!input.witnessUtxo || !Buffer.from(input.witnessUtxo.script).equals(script)) throw new Error("Unexpected local input; signing was cancelled.");
    psbt.signInput(index, signer);
  });
  const signed = psbt.toHex();
  if (signed.toLowerCase() === psbtHex.toLowerCase()) throw new Error("No signature was added to the PSBT.");
  return signed;
}

export function finalizeLocalPsbt(signedPsbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = reviewLocalPsbt(signedPsbtHex, wallet);
  if (current.inputCount !== review.inputCount || current.outputCount !== review.outputCount || current.inputSats !== review.inputSats || current.outputSats !== review.outputSats || current.feeSats !== review.feeSats) throw new Error("The signed PSBT no longer matches the review; nothing was broadcast.");
  const psbt = parsePsbt(signedPsbtHex);
  try { psbt.validateSignaturesOfAllInputs((publicKey, hash, signature) => ecc.verify(hash, publicKey, signature)); psbt.finalizeAllInputs(); } catch { throw new Error("Local signature is missing or invalid; nothing was broadcast."); }
  const tx = psbt.extractTransaction(true);
  if (tx.ins.length !== review.inputCount || tx.outs.length !== review.outputCount) throw new Error("The final transaction does not match the review.");
  return { rawTxHex: tx.toHex(), txid: tx.getId().toLowerCase() };
}

export async function broadcastLocalPsbt(network: OrdiNetwork, rawTxHex: string, expectedTxid: string) {
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Network is not supported for broadcast.");
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex) || !/^[a-f0-9]{64}$/.test(expectedTxid)) throw new Error("Invalid local transaction.");
  const response = await fetch(`${config.api}/api/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawTxHex });
  const returned = (await response.text()).replace(/^\"|\"$/g, "").toLowerCase();
  if (!response.ok || returned !== expectedTxid) throw new Error(`Broadcast status is uncertain. Check TXID ${expectedTxid} in Mempool before retrying.`);
  return returned;
}
