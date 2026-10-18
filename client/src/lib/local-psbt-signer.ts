import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { getMempoolConfig, getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";

bitcoin.initEccLib(ecc);
const NETWORK = bitcoin.networks.bitcoin;
const MAX_INPUTS = 20;
const MAX_OUTPUTS = 20;
const MAX_FEE_RATE = 1_000;

type ReviewedInput = { txid: string; vout: number; valueSats: number; scriptHex: string };
type ReviewedOutput = { address: string; valueSats: number; scriptHex: string };
export type LocalPsbtReview = {
  psbtHex: string;
  network: OrdiNetwork;
  inputCount: number;
  outputCount: number;
  inputSats: number;
  outputSats: number;
  feeSats: number;
  feeRateSatVb: number;
  inputs: ReviewedInput[];
  outputs: ReviewedOutput[];
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
function inputOutpoint(input: { hash: Uint8Array; index: number }): { txid: string; vout: number } {
  return { txid: Buffer.from(input.hash).reverse().toString("hex"), vout: input.index };
}
function outpointKey(input: { txid: string; vout: number }) { return `${input.txid.toLowerCase()}:${input.vout}`; }
function varIntSize(value: number) { return value < 0xfd ? 1 : value <= 0xffff ? 3 : 5; }
function assertSameReview(left: LocalPsbtReview, right: LocalPsbtReview) {
  if (left.psbtHex.toLowerCase() !== right.psbtHex.toLowerCase() || left.network !== right.network ||
    left.inputSats !== right.inputSats || left.outputSats !== right.outputSats || left.feeSats !== right.feeSats ||
    JSON.stringify(left.inputs) !== JSON.stringify(right.inputs) || JSON.stringify(left.outputs) !== JSON.stringify(right.outputs)) {
    throw new Error("The PSBT, UTXOs or reviewed transaction details changed; no signature or broadcast.");
  }
}
async function verifyInputs(network: OrdiNetwork, walletAddress: string, inputs: ReviewedInput[], minimumSats: number) {
  const safe = await getSpendableUtxos(network, walletAddress, minimumSats, { requiredOutpoints: inputs.map(outpointKey) });
  const safeByOutpoint = new Map(safe.map(item => [outpointKey(item), item]));
  for (const input of inputs) {
    const match = safeByOutpoint.get(outpointKey(input));
    if (!match || match.address !== walletAddress || match.satoshi !== input.valueSats || match.scriptPk.toLowerCase() !== input.scriptHex.toLowerCase()) {
      throw new Error(`Input ${input.txid}:${input.vout} is not a confirmed, asset-free UTXO for this vault on ${network}. Nothing was signed or broadcast.`);
    }
  }
}
function assertRawTransaction(rawTxHex: string, expectedTxid: string, review: LocalPsbtReview) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex) || !/^[a-f0-9]{64}$/.test(expectedTxid)) throw new Error("Invalid local transaction.");
  let tx: bitcoin.Transaction;
  try { tx = bitcoin.Transaction.fromHex(rawTxHex); } catch { throw new Error("The finalized transaction is invalid."); }
  if (tx.getId().toLowerCase() !== expectedTxid.toLowerCase() || tx.ins.length !== review.inputs.length || tx.outs.length !== review.outputs.length) {
    throw new Error("The finalized transaction does not match the reviewed TXID, inputs or outputs.");
  }
  tx.ins.forEach((input, index) => {
    const expected = review.inputs[index];
    if (Buffer.from(input.hash).reverse().toString("hex") !== expected.txid || input.index !== expected.vout) throw new Error("The finalized transaction changed its reviewed input set.");
  });
  let outputSats = 0;
  tx.outs.forEach((output, index) => {
    const expected = review.outputs[index];
    if (!Buffer.from(output.script).equals(Buffer.from(expected.scriptHex, "hex")) || Number(output.value) !== expected.valueSats) throw new Error("The finalized transaction changed a reviewed output.");
    outputSats += Number(output.value);
  });
  if (review.inputSats - outputSats !== review.feeSats) throw new Error("The finalized transaction fee differs from the review.");
  return tx;
}

/** Review is intentionally limited to plain Native SegWit BTC spends. Protocol/asset PSBTs are rejected. */
export async function reviewLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord, network: OrdiNetwork): Promise<LocalPsbtReview> {
  if (network !== "BITCOIN_MAINNET" && network !== "FRACTAL_BITCOIN_MAINNET") throw new Error("Unsupported Local Vault network.");
  const psbt = parsePsbt(psbtHex);
  if (psbt.inputCount < 1 || psbt.inputCount > MAX_INPUTS) throw new Error("The PSBT must contain between 1 and 20 inputs.");
  if (psbt.txOutputs.length < 1 || psbt.txOutputs.length > MAX_OUTPUTS) throw new Error("The PSBT must contain between 1 and 20 outputs.");
  const { address, script } = localNativeScript(wallet);
  let inputSats = 0;
  const seen = new Set<string>();
  const inputs: ReviewedInput[] = [];
  for (let index = 0; index < psbt.data.inputs.length; index += 1) {
    const item = psbt.data.inputs[index];
    const txInput = psbt.txInputs[index];
    if (!item.witnessUtxo || item.nonWitnessUtxo || !Buffer.from(item.witnessUtxo.script).equals(script)) throw new Error("Only Native SegWit inputs belonging to the active local vault are supported.");
    if (item.sighashType !== undefined && item.sighashType !== bitcoin.Transaction.SIGHASH_ALL) throw new Error("Only SIGHASH_ALL is supported by this Local Vault signer.");
    const valueSats = Number(item.witnessUtxo.value);
    if (!Number.isSafeInteger(valueSats) || valueSats <= 0) throw new Error("Invalid PSBT input value.");
    const outpoint = inputOutpoint(txInput);
    const key = outpointKey(outpoint);
    if (seen.has(key)) throw new Error("The PSBT contains a duplicate input outpoint.");
    seen.add(key);
    inputSats += valueSats;
    inputs.push({ ...outpoint, valueSats, scriptHex: Buffer.from(item.witnessUtxo.script).toString("hex") });
  }
  if (!Number.isSafeInteger(inputSats)) throw new Error("The PSBT input total exceeds safe integer bounds.");
  await verifyInputs(network, address.address, inputs, inputSats);

  const outputs: ReviewedOutput[] = [];
  for (const output of psbt.txOutputs) {
    const valueSats = Number(output.value);
    if (!Number.isSafeInteger(valueSats) || valueSats < 546) throw new Error("The PSBT contains an output below the conservative dust threshold.");
    let outputAddress: string;
    try { outputAddress = bitcoin.address.fromOutputScript(output.script, NETWORK); }
    catch { throw new Error("This generic signer rejects OP_RETURN, inscription, Rune, Alkane and other non-address protocol outputs."); }
    await validateMempoolAddress(network, outputAddress);
    outputs.push({ address: outputAddress, valueSats, scriptHex: Buffer.from(output.script).toString("hex") });
  }
  const outputSats = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  if (!Number.isSafeInteger(outputSats)) throw new Error("The PSBT output total exceeds safe integer bounds.");
  const feeSats = inputSats - outputSats;
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) throw new Error("The PSBT must have a positive fee.");
  const estimatedVsize = Math.ceil(10 + inputs.length * 69 + outputs.reduce((sum, output) => {
    const scriptLength = output.scriptHex.length / 2;
    return sum + 8 + varIntSize(scriptLength) + scriptLength;
  }, 0));
  const feeRateSatVb = feeSats / estimatedVsize;
  if (!Number.isFinite(feeRateSatVb) || feeRateSatVb > MAX_FEE_RATE) throw new Error("The estimated fee rate exceeds the Local Vault safety limit.");
  return { psbtHex, network, inputCount: psbt.inputCount, outputCount: outputs.length, inputSats, outputSats, feeSats, feeRateSatVb, inputs, outputs };
}

export async function signLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = await reviewLocalPsbt(psbtHex, wallet, review.network);
  assertSameReview(current, review);
  const { address, script } = localNativeScript(wallet);
  const privateKey = hexBytes(address.privateKey, "Local private key");
  if (!ecc.isPrivate(privateKey)) throw new Error("The local private key is invalid.");
  const signer = { publicKey: hexBytes(address.publicKey, "Local public key"), sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, privateKey)) };
  const psbt = parsePsbt(psbtHex);
  psbt.data.inputs.forEach((input, index) => {
    if (!input.witnessUtxo || !Buffer.from(input.witnessUtxo.script).equals(script) || input.partialSig?.length || input.tapKeySig || input.tapScriptSig?.length) throw new Error("Unexpected or already signed input; signing was cancelled.");
    psbt.signInput(index, signer);
  });
  const signed = psbt.toHex();
  if (signed.toLowerCase() === psbtHex.toLowerCase()) throw new Error("No signature was added to the PSBT.");
  return signed;
}

export async function finalizeLocalPsbt(signedPsbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = await reviewLocalPsbt(signedPsbtHex, wallet, review.network);
  assertSameReview({ ...current, psbtHex: review.psbtHex }, review);
  const psbt = parsePsbt(signedPsbtHex);
  try { psbt.validateSignaturesOfAllInputs((publicKey, hash, signature) => ecc.verify(hash, publicKey, signature)); psbt.finalizeAllInputs(); }
  catch { throw new Error("Local signature is missing or invalid; nothing was broadcast."); }
  const tx = psbt.extractTransaction(true);
  const rawTxHex = tx.toHex();
  const txid = tx.getId().toLowerCase();
  assertRawTransaction(rawTxHex, txid, review);
  return { rawTxHex, txid };
}

export async function broadcastLocalPsbt(network: OrdiNetwork, rawTxHex: string, expectedTxid: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  if (review.network !== network) throw new Error("The selected network changed after review.");
  const tx = assertRawTransaction(rawTxHex, expectedTxid, review);
  const { address } = localNativeScript(wallet);
  await verifyInputs(network, address.address, review.inputs, review.inputSats);
  const config = getMempoolConfig(network);
  if (!config) throw new Error("Network is not supported for broadcast.");
  const response = await fetch(`${config.api}/api/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: tx.toHex() });
  const returned = (await response.text()).replace(/^\"|\"$/g, "").toLowerCase();
  if (!response.ok || returned !== expectedTxid.toLowerCase()) throw new Error(`Broadcast outcome may be uncertain. Check TXID ${expectedTxid} in Mempool before retrying.`);
  return returned;
}
