import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { AddressType, OrdiAddress, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";
import { LIVE_DATA_API_BASE } from "@/lib/live";

bitcoin.initEccLib(ecc);
const NETWORK = bitcoin.networks.bitcoin;
const MAX_INPUTS = 20;
const MAX_OUTPUTS = 20;
const MAX_FEE_RATE = 1_000;
const ADDRESS_TYPES: AddressType[] = ["legacy", "nested-segwit", "native-segwit", "taproot"];
const INPUT_VBYTES: Record<AddressType, number> = { legacy: 148, "nested-segwit": 91, "native-segwit": 69, taproot: 58 };

type ReviewedInput = { txid: string; vout: number; valueSats: number; scriptHex: string };
type ReviewedOutput = { address: string; valueSats: number; scriptHex: string };
export type LocalPsbtReview = {
  psbtHex: string;
  network: OrdiNetwork;
  addressType: AddressType;
  sourceAddress: string;
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
function scriptForAccount(account: OrdiAddress) {
  return bitcoin.address.toOutputScript(account.address, NETWORK);
}
function accountScriptMap(wallet: OrdiWalletRecord) {
  return new Map(ADDRESS_TYPES.map(type => {
    const account = wallet.addresses[type];
    if (!account?.address || !account.publicKey || !account.privateKey) throw new Error(`Le compte local ${type} est incomplet.`);
    return [Buffer.from(scriptForAccount(account)).toString("hex"), { type, account }] as const;
  }));
}
function parsePsbt(psbtHex: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(psbtHex) || psbtHex.length > 2_000_000) throw new Error("PSBT invalide ou trop volumineux.");
  try { return bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK }); } catch { throw new Error("Impossible de décoder ce PSBT."); }
}
function inputOutpoint(input: { hash: Uint8Array; index: number }): { txid: string; vout: number } {
  return { txid: Buffer.from(input.hash).reverse().toString("hex"), vout: input.index };
}
function outpointKey(input: { txid: string; vout: number }) { return `${input.txid.toLowerCase()}:${input.vout}`; }
function varIntSize(value: number) { return value < 0xfd ? 1 : value <= 0xffff ? 3 : 5; }
function estimatedVsize(addressType: AddressType, inputCount: number, outputs: ReviewedOutput[]) {
  const segwitOverhead = addressType === "legacy" ? 0 : 1;
  return Math.ceil(10 + segwitOverhead + inputCount * INPUT_VBYTES[addressType] + outputs.reduce((sum, output) => {
    const scriptLength = output.scriptHex.length / 2;
    return sum + 8 + varIntSize(scriptLength) + scriptLength;
  }, 0));
}
function assertSameReview(left: LocalPsbtReview, right: LocalPsbtReview) {
  if (left.psbtHex.toLowerCase() !== right.psbtHex.toLowerCase() || left.network !== right.network || left.addressType !== right.addressType || left.sourceAddress !== right.sourceAddress ||
    left.inputSats !== right.inputSats || left.outputSats !== right.outputSats || left.feeSats !== right.feeSats ||
    JSON.stringify(left.inputs) !== JSON.stringify(right.inputs) || JSON.stringify(left.outputs) !== JSON.stringify(right.outputs)) {
    throw new Error("Le PSBT, les UTXO ou les détails examinés ont changé; aucune signature ni diffusion.");
  }
}
async function verifyInputs(network: OrdiNetwork, walletAddress: string, inputs: ReviewedInput[], minimumSats: number) {
  const safe = await getSpendableUtxos(network, walletAddress, minimumSats, { requiredOutpoints: inputs.map(outpointKey) });
  const safeByOutpoint = new Map(safe.map(item => [outpointKey(item), item]));
  for (const input of inputs) {
    const match = safeByOutpoint.get(outpointKey(input));
    if (!match || match.address !== walletAddress || match.satoshi !== input.valueSats || match.scriptPk.toLowerCase() !== input.scriptHex.toLowerCase()) {
      throw new Error(`L’entrée ${input.txid}:${input.vout} n’est pas un UTXO confirmé et sans actif pour ce coffre sur ${network}. Rien n’a été signé ni diffusé.`);
    }
  }
}
function transactionInputValueAndScript(item: bitcoin.Psbt["data"]["inputs"][number], outpoint: { txid: string; vout: number }) {
  if (item.witnessUtxo && item.nonWitnessUtxo) throw new Error("Le PSBT mélange les preuves UTXO witness et non-witness.");
  if (item.witnessUtxo) return { value: Number(item.witnessUtxo.value), script: Buffer.from(item.witnessUtxo.script) };
  if (item.nonWitnessUtxo) {
    let previousTx: bitcoin.Transaction;
    try { previousTx = bitcoin.Transaction.fromBuffer(Buffer.from(item.nonWitnessUtxo)); } catch { throw new Error("La transaction précédente Legacy est invalide."); }
    const previousOutput = previousTx.outs[outpoint.vout];
    if (previousTx.getId().toLowerCase() !== outpoint.txid || !previousOutput) throw new Error("La transaction précédente ne correspond pas à l’entrée Legacy du PSBT.");
    return { value: Number(previousOutput.value), script: Buffer.from(previousOutput.script) };
  }
  throw new Error("Une entrée du PSBT ne contient pas de preuve UTXO complète.");
}
function validateInputType(item: bitcoin.Psbt["data"]["inputs"][number], type: AddressType, account: OrdiAddress) {
  const publicKey = Buffer.from(account.publicKey, "hex");
  if (type === "legacy") {
    if (!item.nonWitnessUtxo || item.witnessUtxo || item.redeemScript || item.witnessScript || item.tapInternalKey || item.tapLeafScript?.length) throw new Error("La preuve de l’entrée Legacy est incomplète ou d’un type inattendu.");
    return;
  }
  if (!item.witnessUtxo || item.nonWitnessUtxo || item.witnessScript) throw new Error("Une entrée SegWit doit fournir uniquement son UTXO witness.");
  if (type === "nested-segwit") {
    const expectedRedeem = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: NETWORK }).output;
    if (!expectedRedeem || !item.redeemScript || !Buffer.from(item.redeemScript).equals(expectedRedeem)) throw new Error("Le redeem script Nested SegWit ne correspond pas au coffre.");
    if (item.tapInternalKey || item.tapLeafScript?.length) throw new Error("Une entrée Nested SegWit contient des métadonnées Taproot inattendues.");
    return;
  }
  if (type === "native-segwit") {
    if (item.redeemScript || item.tapInternalKey || item.tapLeafScript?.length) throw new Error("Une entrée Native SegWit contient des métadonnées script inattendues.");
    return;
  }
  const expectedInternalKey = Buffer.from(ecc.xOnlyPointFromPoint(publicKey));
  if (!item.tapInternalKey || !Buffer.from(item.tapInternalKey).equals(expectedInternalKey) || item.redeemScript || item.witnessScript || item.tapLeafScript?.length || item.tapScriptSig?.length || item.tapMerkleRoot) {
    throw new Error("Seule une dépense Taproot key-path sans arbre de script est prise en charge.");
  }
}
function assertRawTransaction(rawTxHex: string, expectedTxid: string, review: LocalPsbtReview) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex) || !/^[a-f0-9]{64}$/.test(expectedTxid)) throw new Error("Transaction locale invalide.");
  let tx: bitcoin.Transaction;
  try { tx = bitcoin.Transaction.fromHex(rawTxHex); } catch { throw new Error("La transaction finalisée est invalide."); }
  if (tx.getId().toLowerCase() !== expectedTxid.toLowerCase() || tx.ins.length !== review.inputs.length || tx.outs.length !== review.outputs.length) {
    throw new Error("La transaction finalisée ne correspond pas au TXID, aux entrées ou aux sorties examinés.");
  }
  tx.ins.forEach((input, index) => {
    const expected = review.inputs[index];
    if (Buffer.from(input.hash).reverse().toString("hex") !== expected.txid || input.index !== expected.vout) throw new Error("Les entrées finalisées diffèrent de l’examen.");
  });
  let outputSats = 0;
  tx.outs.forEach((output, index) => {
    const expected = review.outputs[index];
    if (!Buffer.from(output.script).equals(Buffer.from(expected.scriptHex, "hex")) || Number(output.value) !== expected.valueSats) throw new Error("Une sortie finalisée diffère de l’examen.");
    outputSats += Number(output.value);
  });
  if (review.inputSats - outputSats !== review.feeSats) throw new Error("Les frais finaux diffèrent de l’examen.");
  return tx;
}

/** Examine uniquement des sorties BTC/FB ordinaires; les PSBT de protocoles restent rejetés. */
export async function reviewLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord, network: OrdiNetwork): Promise<LocalPsbtReview> {
  if (network !== "BITCOIN_MAINNET" && network !== "FRACTAL_BITCOIN_MAINNET") throw new Error("Réseau Local Vault non pris en charge.");
  const psbt = parsePsbt(psbtHex);
  if (psbt.inputCount < 1 || psbt.inputCount > MAX_INPUTS) throw new Error("Le PSBT doit contenir entre 1 et 20 entrées.");
  if (psbt.txOutputs.length < 1 || psbt.txOutputs.length > MAX_OUTPUTS) throw new Error("Le PSBT doit contenir entre 1 et 20 sorties.");
  const scriptMap = accountScriptMap(wallet);
  let inputSats = 0;
  const seen = new Set<string>();
  const inputs: ReviewedInput[] = [];
  let addressType: AddressType | null = null;
  let sourceAddress: string | null = null;
  for (let index = 0; index < psbt.data.inputs.length; index += 1) {
    const item = psbt.data.inputs[index];
    const txInput = psbt.txInputs[index];
    const outpoint = inputOutpoint(txInput);
    const key = outpointKey(outpoint);
    if (seen.has(key)) throw new Error("Le PSBT contient une entrée UTXO dupliquée.");
    seen.add(key);
    const prevout = transactionInputValueAndScript(item, outpoint);
    const scriptHex = prevout.script.toString("hex");
    const match = scriptMap.get(scriptHex);
    if (!match) throw new Error("Toutes les entrées doivent appartenir au même compte d’adresse du coffre local.");
    if (addressType && addressType !== match.type) throw new Error("Le PSBT mélange plusieurs types d’adresse; créez une transaction par compte.");
    addressType = match.type;
    sourceAddress = match.account.address;
    validateInputType(item, match.type, match.account);
    if (item.sighashType !== undefined) {
      const allowed = match.type === "taproot" ? [bitcoin.Transaction.SIGHASH_DEFAULT, bitcoin.Transaction.SIGHASH_ALL] : [bitcoin.Transaction.SIGHASH_ALL];
      if (!allowed.includes(item.sighashType)) throw new Error("Le PSBT utilise un type de signature SIGHASH non pris en charge.");
    }
    if (match.type !== "taproot" && (item.tapKeySig || item.tapScriptSig?.length || item.tapLeafScript?.length)) throw new Error("Une entrée non-Taproot contient des signatures Taproot inattendues.");
    const valueSats = prevout.value;
    if (!Number.isSafeInteger(valueSats) || valueSats <= 0) throw new Error("Valeur d’entrée PSBT invalide.");
    inputSats += valueSats;
    inputs.push({ ...outpoint, valueSats, scriptHex });
  }
  if (!addressType || !sourceAddress || !Number.isSafeInteger(inputSats)) throw new Error("Impossible de déterminer le compte source du PSBT.");
  await verifyInputs(network, sourceAddress, inputs, inputSats);

  const outputs: ReviewedOutput[] = [];
  for (const output of psbt.txOutputs) {
    const valueSats = Number(output.value);
    if (!Number.isSafeInteger(valueSats) || valueSats < 546) throw new Error("Le PSBT contient une sortie sous le seuil de poussière prudent.");
    let outputAddress: string;
    try { outputAddress = bitcoin.address.fromOutputScript(output.script, NETWORK); }
    catch { throw new Error("Ce signataire BTC/FB ordinaire rejette OP_RETURN et les sorties de protocole Ordinals, Rune, Alkane ou BRC-20."); }
    await validateMempoolAddress(network, outputAddress);
    outputs.push({ address: outputAddress, valueSats, scriptHex: Buffer.from(output.script).toString("hex") });
  }
  const outputSats = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  if (!Number.isSafeInteger(outputSats)) throw new Error("Le total de sortie dépasse la précision sûre.");
  const feeSats = inputSats - outputSats;
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) throw new Error("Le PSBT doit avoir des frais positifs.");
  const vsize = estimatedVsize(addressType, inputs.length, outputs);
  const feeRateSatVb = feeSats / vsize;
  if (!Number.isFinite(feeRateSatVb) || feeRateSatVb > MAX_FEE_RATE) throw new Error("Le taux de frais estimé dépasse la limite de sécurité du Local Vault.");
  return { psbtHex, network, addressType, sourceAddress, inputCount: psbt.inputCount, outputCount: outputs.length, inputSats, outputSats, feeSats, feeRateSatVb, inputs, outputs };
}

function signerForAccount(account: OrdiAddress, type: AddressType) {
  const publicKey = hexBytes(account.publicKey, "Clé publique locale");
  const privateKey = hexBytes(account.privateKey, "Clé privée locale");
  if (publicKey.length !== 33 || privateKey.length !== 32 || !ecc.isPrivate(privateKey) || !Buffer.from(ecc.pointFromScalar(privateKey, true) ?? []).equals(publicKey)) throw new Error("La clé privée locale ne correspond pas à l’adresse examinée.");
  // bitcoinjs-lib supplies Uint8Array hashes; normalize all secp256k1 inputs to this
  // app's Buffer implementation before crossing the ECC adapter boundary.
  const baseSigner = { publicKey, sign: (hash: Uint8Array) => Buffer.from(ecc.sign(Buffer.from(hash), Buffer.from(privateKey))) };
  if (type !== "taproot") return baseSigner;
  const parityAdjustedKey = publicKey[0] === 3 ? Buffer.from(ecc.privateNegate(privateKey)) : privateKey;
  const tapTweak = bitcoin.crypto.taggedHash("TapTweak", bitcoin.toXOnly(publicKey));
  const tweakedPrivateKey = ecc.privateAdd(parityAdjustedKey, tapTweak);
  if (!tweakedPrivateKey) throw new Error("Impossible de dériver la clé Taproot signataire.");
  const tweakedPublicKey = ecc.pointFromScalar(tweakedPrivateKey, true);
  if (!tweakedPublicKey) throw new Error("Impossible de dériver la clé publique Taproot signataire.");
  return { publicKey: Buffer.from(tweakedPublicKey), sign: (hash: Uint8Array) => Buffer.from(ecc.sign(Buffer.from(hash), Buffer.from(tweakedPrivateKey))), signSchnorr: (hash: Uint8Array) => Buffer.from(ecc.signSchnorr(Buffer.from(hash), Buffer.from(tweakedPrivateKey))) };
}

export async function signLocalPsbt(psbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = await reviewLocalPsbt(psbtHex, wallet, review.network);
  assertSameReview(current, review);
  const account = wallet.addresses[review.addressType];
  if (!account || account.address !== review.sourceAddress) throw new Error("Le compte source a changé depuis l’examen.");
  const signer = signerForAccount(account, review.addressType);
  const psbt = parsePsbt(psbtHex);
  psbt.data.inputs.forEach((input, index) => {
    if (input.partialSig?.length || input.tapKeySig || input.tapScriptSig?.length) throw new Error("Une signature est déjà présente; la signature a été annulée.");
    psbt.signInput(index, signer, review.addressType === "taproot" ? [bitcoin.Transaction.SIGHASH_DEFAULT, bitcoin.Transaction.SIGHASH_ALL] : [bitcoin.Transaction.SIGHASH_ALL]);
  });
  const signed = psbt.toHex();
  if (signed.toLowerCase() === psbtHex.toLowerCase()) throw new Error("Aucune signature n’a été ajoutée au PSBT.");
  return signed;
}

export async function finalizeLocalPsbt(signedPsbtHex: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  const current = await reviewLocalPsbt(signedPsbtHex, wallet, review.network);
  assertSameReview({ ...current, psbtHex: review.psbtHex }, review);
  const psbt = parsePsbt(signedPsbtHex);
  const signatureVerifier = review.addressType === "taproot"
    ? (publicKey: Uint8Array, hash: Uint8Array, signature: Uint8Array) => ecc.verifySchnorr(Buffer.from(hash), Buffer.from(publicKey), Buffer.from(signature))
    : (publicKey: Uint8Array, hash: Uint8Array, signature: Uint8Array) => ecc.verify(Buffer.from(hash), Buffer.from(publicKey), Buffer.from(signature));
  try { psbt.validateSignaturesOfAllInputs(signatureVerifier); psbt.finalizeAllInputs(); }
  catch { throw new Error("La signature locale est absente ou invalide; rien n’a été diffusé."); }
  const tx = psbt.extractTransaction(true);
  const rawTxHex = tx.toHex();
  const txid = tx.getId().toLowerCase();
  assertRawTransaction(rawTxHex, txid, review);
  return { rawTxHex, txid };
}

export async function broadcastLocalPsbt(network: OrdiNetwork, rawTxHex: string, expectedTxid: string, wallet: OrdiWalletRecord, review: LocalPsbtReview) {
  if (review.network !== network) throw new Error("Le réseau sélectionné a changé depuis l’examen.");
  const tx = assertRawTransaction(rawTxHex, expectedTxid, review);
  const account = wallet.addresses[review.addressType];
  if (!account || account.address !== review.sourceAddress) throw new Error("Le compte source a changé depuis l’examen.");
  await verifyInputs(network, account.address, review.inputs, review.inputSats);
  const query = new URLSearchParams({ chain: network });
  const response = await fetch(`${LIVE_DATA_API_BASE}/api/mempool/tx?${query}`, { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: tx.toHex(), cache: "no-store" });
  const result = await response.json().catch(() => null) as { txid?: string; error?: string } | null;
  const returned = typeof result?.txid === "string" ? result.txid.toLowerCase() : "";
  if (!response.ok || returned !== expectedTxid.toLowerCase()) throw new Error(`Résultat de diffusion incertain. Vérifiez le TXID ${expectedTxid} dans Mempool avant de réessayer${result?.error ? ` (${result.error})` : ""}.`);
  return returned;
}
