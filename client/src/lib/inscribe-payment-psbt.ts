import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { confirmFractalSpendableUtxos, getMempoolConfig, getSpendableUtxos, type WorkerSafeUtxoAttestation } from "@/lib/mempool";
import { LIVE_DATA_API_BASE } from "@/lib/live";

const MIN_CHANGE_SATS = 1_200;
const MAX_FEE_RATE_SAT_VB = 1_000;
const MAX_INPUTS = 20;
const RBF_SEQUENCE = 0xfffffffd;
const NETWORK = bitcoin.networks.bitcoin;

const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalWithBuffer.Buffer) globalWithBuffer.Buffer = Buffer;
bitcoin.initEccLib(ecc);

type SpendType = "legacy" | "nested-segwit" | "native-segwit" | "taproot";
export type InscribePaymentInput = {
  txid: string;
  vout: number;
  valueSats: number;
  scriptHex: string;
  rawTxHex: string;
  spendType: SpendType;
  redeemScriptHex?: string;
  tapInternalKeyHex?: string;
};
export type InscribePaymentOutput = { scriptHex: string; valueSats: number; role: "payment" | "change" };
export type InscribePaymentPlan = {
  psbtHex: string;
  network: string;
  walletAddress: string;
  paymentAddress: string;
  paymentSats: number;
  publicKeyHex: string;
  feeRateSatVb: number;
  feeSats: number;
  estimatedVsize: number;
  totalInputSats: number;
  inputs: InscribePaymentInput[];
  outputs: InscribePaymentOutput[];
  workerAttestation?: WorkerSafeUtxoAttestation;
};

export function hasSufficientWorkerUtxoAttestation(plan: InscribePaymentPlan | null | undefined) {
  if (!plan) return false;
  if (plan.network !== "FRACTAL_BITCOIN_MAINNET") return true;
  const requiredSats = plan.paymentSats + plan.feeSats;
  const attestation = plan.workerAttestation;
  return Number.isSafeInteger(requiredSats) && Boolean(attestation && attestation.sufficient === true && attestation.chain === "fractal" &&
    attestation.address === plan.walletAddress && attestation.minimumSats === requiredSats && attestation.safeSats >= requiredSats &&
    attestation.verifiedUtxoCount === plan.inputs.length);
}

export class InscribePaymentBroadcastUnclearError extends Error {
  readonly txid: string;
  constructor(txid: string, detail: string) {
    super(`BROADCAST_OUTCOME_UNCLEAR: ${detail}. Verify ${txid} dans Mempool avant toute nouvelle tentative.`);
    this.name = "InscribePaymentBroadcastUnclearError";
    this.txid = txid;
  }
}

function hexBytes(hex: string, label: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error(`${label} is not valid hexadecimal.`);
  return Buffer.from(hex, "hex");
}
function publicKeyBytes(publicKeyHex: string) {
  const key = hexBytes(publicKeyHex, "The UniSat public key");
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3) || !ecc.isPoint(key)) {
    throw new Error("UniSat did not provide a valid compressed public key.");
  }
  return key;
}
function equalBytes(left: Uint8Array, right: Uint8Array) {
  return Buffer.from(left).equals(Buffer.from(right));
}
function scriptFromAddress(address: string, label: string) {
  try { return Buffer.from(bitcoin.address.toOutputScript(address, NETWORK)); }
  catch { throw new Error(`Address ${label} is invalid or outside the Bitcoin/Fractal mainnet.`); }
}

async function requestText(url: string, init?: RequestInit, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
    return body.trim();
  } finally { window.clearTimeout(timer); }
}

async function validatedScript(api: string, address: string, label: string) {
  const expected = scriptFromAddress(address, label);
  const body = await requestText(`${api}/api/v1/validate-address/${encodeURIComponent(address)}`);
  let result: { isvalid?: boolean; address?: string; scriptPubKey?: string };
  try { result = JSON.parse(body) as typeof result; }
  catch { throw new Error(`Mempool did not return JSON validation for address ${label}.`); }
  if (!result.isvalid || typeof result.scriptPubKey !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(result.scriptPubKey) || !equalBytes(expected, hexBytes(result.scriptPubKey, `script ${label}`))) {
    throw new Error(`Address ${label} or its script does not match the selected Mempool network.`);
  }
  return expected;
}

function walletTemplates(publicKey: Buffer) {
  const native = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: NETWORK });
  const nativeScript = Buffer.from(native.output!);
  const nested = bitcoin.payments.p2sh({ redeem: native, network: NETWORK });
  const tapInternalKey = Buffer.from(bitcoin.toXOnly(publicKey));
  const taproot = bitcoin.payments.p2tr({ internalPubkey: tapInternalKey, network: NETWORK });
  return [
    { type: "legacy" as const, script: Buffer.from(bitcoin.payments.p2pkh({ pubkey: publicKey, network: NETWORK }).output!) },
    { type: "nested-segwit" as const, script: Buffer.from(nested.output!), redeemScript: nativeScript },
    { type: "native-segwit" as const, script: nativeScript },
    { type: "taproot" as const, script: Buffer.from(taproot.output!), tapInternalKey },
  ];
}

function outputVsize(script: Uint8Array) { return 8 + (script.length < 0xfd ? 1 : script.length <= 0xffff ? 3 : 5) + script.length; }
function dustThreshold(script: Uint8Array) {
  if ((script.length === 22 && script[0] === 0x00 && script[1] === 0x14) || (script.length === 34 && script[0] === 0x00 && script[1] === 0x20)) return 294;
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 330;
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14) return 540;
  return 546;
}
function inputVsize(input: InscribePaymentInput) {
  return input.spendType === "legacy" ? 150 : input.spendType === "nested-segwit" ? 93 : input.spendType === "taproot" ? 59 : 69;
}
function estimateVsize(inputs: InscribePaymentInput[], scripts: Uint8Array[]) {
  return 11 + inputs.reduce((sum, input) => sum + inputVsize(input), 0) + scripts.reduce((sum, script) => sum + outputVsize(script), 0);
}
function addInput(psbt: bitcoin.Psbt, input: InscribePaymentInput) {
  const common = { hash: input.txid, index: input.vout, sequence: RBF_SEQUENCE };
  if (input.spendType === "legacy") {
    psbt.addInput({ ...common, nonWitnessUtxo: hexBytes(input.rawTxHex, "The previous transaction") });
  } else {
    psbt.addInput({
      ...common,
      witnessUtxo: { script: hexBytes(input.scriptHex, "Le script UTXO"), value: BigInt(input.valueSats) },
      ...(input.redeemScriptHex ? { redeemScript: hexBytes(input.redeemScriptHex, "Le redeem script") } : {}),
      ...(input.tapInternalKeyHex ? { tapInternalKey: hexBytes(input.tapInternalKeyHex, "The Taproot internal key") } : {}),
    });
  }
}

function prepareInput(utxo: Awaited<ReturnType<typeof getSpendableUtxos>>[number], rawTxHex: string, walletScript: Buffer, templates: ReturnType<typeof walletTemplates>): InscribePaymentInput {
  const txid = utxo.txid.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(utxo.vout) || utxo.vout < 0) throw new Error("The service Worker a fourni un outpoint invalide.");
  const previous = bitcoin.Transaction.fromHex(rawTxHex);
  if (previous.getId().toLowerCase() !== txid) throw new Error("The Mempool transaction bytes do not match the safe UTXO TXID.");
  const output = previous.outs[utxo.vout];
  if (!output) throw new Error("Mempool ne trouve pas la sortie UTXO fournie par le Worker.");
  const valueSats = Number(output.value);
  if (!Number.isSafeInteger(valueSats) || valueSats !== utxo.satoshi || !equalBytes(output.script, hexBytes(utxo.scriptPk, "Le script UTXO du Worker")) || !equalBytes(output.script, walletScript)) {
    throw new Error("The safe output value or script does not match Mempool and the UniSat address.");
  }
  const template = templates.find(item => equalBytes(item.script, output.script));
  if (!template) throw new Error("The UTXO cannot be controlled by the active UniSat key with a supported script.");
  return {
    txid, vout: utxo.vout, valueSats, scriptHex: Buffer.from(output.script).toString("hex"), rawTxHex, spendType: template.type,
    ...(template.type === "nested-segwit" ? { redeemScriptHex: template.redeemScript.toString("hex") } : {}),
    ...(template.type === "taproot" ? { tapInternalKeyHex: template.tapInternalKey.toString("hex") } : {}),
  };
}

function buildPlan(params: {
  network: string; walletAddress: string; paymentAddress: string; paymentSats: number; feeRateSatVb: number;
  publicKeyHex: string; walletScript: Buffer; paymentScript: Buffer; candidates: InscribePaymentInput[];
}): InscribePaymentPlan {
  const { network, walletAddress, paymentAddress, paymentSats, feeRateSatVb, publicKeyHex, walletScript, paymentScript } = params;
  if (!Number.isSafeInteger(paymentSats) || paymentSats <= 0) throw new Error("The UniSat receipt amount is invalid.");
  if (paymentSats < dustThreshold(paymentScript)) throw new Error("The amount requested by UniSat is below the payment address dust threshold.");
  if (!Number.isFinite(feeRateSatVb) || feeRateSatVb < 1 || feeRateSatVb > MAX_FEE_RATE_SAT_VB) throw new Error("The Mempool rate is outside safe limits.");
  const unique = new Map<string, InscribePaymentInput>();
  for (const item of params.candidates) {
    const key = `${item.txid}:${item.vout}`;
    if (unique.has(key)) throw new Error("The Worker returned the same UTXO twice; no payment is prepared.");
    unique.set(key, item);
  }
  const candidates = Array.from(unique.values()).sort((a, b) => b.valueSats - a.valueSats).slice(0, MAX_INPUTS);
  const inputs: InscribePaymentInput[] = [];
  let chosenInputs: InscribePaymentInput[] | undefined;
  let feeSats = 0;
  let changeSats = 0;
  let estimatedVsize = 0;
  for (const candidate of candidates) {
    inputs.push(candidate);
    const total = inputs.reduce((sum, input) => sum + input.valueSats, 0);
    if (!Number.isSafeInteger(total)) throw new Error("The total inputs exceed safe satoshi precision.");
    const withChangeVsize = estimateVsize(inputs, [paymentScript, walletScript]);
    const withChangeFee = Math.ceil(withChangeVsize * feeRateSatVb);
    const possibleChange = total - paymentSats - withChangeFee;
    if (possibleChange >= MIN_CHANGE_SATS) {
      chosenInputs = [...inputs]; feeSats = withChangeFee; changeSats = possibleChange; estimatedVsize = withChangeVsize; break;
    }
    const noChangeVsize = estimateVsize(inputs, [paymentScript]);
    const minimumFee = Math.ceil(noChangeVsize * feeRateSatVb);
    const actualFee = total - paymentSats;
    const maxFeeOverpay = Math.max(200, Math.ceil(feeRateSatVb * 25));
    if (actualFee >= minimumFee && actualFee - minimumFee <= maxFeeOverpay) {
      chosenInputs = [...inputs]; feeSats = actualFee; estimatedVsize = noChangeVsize; changeSats = 0; break;
    }
  }
  if (!chosenInputs) throw new Error("Confirmed safe UTXOs do not cover the amount, fees, and a non-dust change output. No PSBT was sent to UniSat.");
  const totalInputSats = chosenInputs.reduce((sum, input) => sum + input.valueSats, 0);
  const outputs: InscribePaymentOutput[] = [{ scriptHex: paymentScript.toString("hex"), valueSats: paymentSats, role: "payment" }];
  if (changeSats > 0) outputs.push({ scriptHex: walletScript.toString("hex"), valueSats: changeSats, role: "change" });
  if (totalInputSats - outputs.reduce((sum, output) => sum + output.valueSats, 0) !== feeSats) throw new Error("Internal accounting mismatch; no PSBT is created.");
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.setVersion(2);
  for (const input of chosenInputs) addInput(psbt, input);
  for (const output of outputs) psbt.addOutput({ script: hexBytes(output.scriptHex, "Le script de sortie"), value: BigInt(output.valueSats) });
  return { psbtHex: psbt.toHex(), network, walletAddress, paymentAddress, paymentSats, publicKeyHex, feeRateSatVb, feeSats, estimatedVsize, totalInputSats, inputs: chosenInputs, outputs };
}

export async function prepareInscribePaymentPsbt(params: {
  network: string; walletAddress: string; paymentAddress: string; paymentSats: number; feeRateSatVb: number; publicKeyHex: string;
}): Promise<InscribePaymentPlan> {
  const mempool = getMempoolConfig(params.network);
  if (!mempool) throw new Error("No Mempool is configured for this mainnet.");
  const publicKey = publicKeyBytes(params.publicKeyHex);
  const [walletScript, paymentScript] = await Promise.all([
    validatedScript(mempool.api, params.walletAddress, "wallet"),
    validatedScript(mempool.api, params.paymentAddress, "paiement"),
  ]);
  if (equalBytes(walletScript, paymentScript)) throw new Error("The receipt payment address is identical to the wallet script; no PSBT is prepared.");
  const templates = walletTemplates(publicKey);
  if (!templates.some(item => equalBytes(item.script, walletScript))) throw new Error("The UniSat address does not match the active key on a supported P2PKH, P2SH-SegWit, SegWit, or Taproot format.");
  const chainName = params.network === "BITCOIN_MAINNET" ? "bitcoin" : "fractal";
  const fetchCandidates = async (minimumSats: number) => {
    const utxos = await getSpendableUtxos(params.network, params.walletAddress, minimumSats);
    const ordered = [...utxos].sort((a, b) => b.satoshi - a.satoshi).slice(0, MAX_INPUTS);
    const inputs = await Promise.all(ordered.map(async utxo => {
      const rawTxHex = await requestText(`${mempool.api}/api/tx/${encodeURIComponent(utxo.txid)}/hex`);
      if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex)) throw new Error("Mempool a renvoyé une transaction précédente invalide.");
      return prepareInput(utxo, rawTxHex, walletScript, templates);
    }));
    return inputs;
  };
  const firstMinimum = params.paymentSats + 1;
  const candidates = await fetchCandidates(firstMinimum);
  const confirmPlan = async (plan: InscribePaymentPlan) => {
    if (params.network !== "FRACTAL_BITCOIN_MAINNET") return plan;
    const minimumSats = plan.paymentSats + plan.feeSats;
    if (!Number.isSafeInteger(minimumSats)) throw new Error("The minimum payment amount exceeds safe satoshi precision.");
    const workerAttestation = await confirmFractalSpendableUtxos(plan.walletAddress, minimumSats, plan.inputs.map(input => ({
      txid: input.txid, vout: input.vout, satoshi: input.valueSats, scriptPk: input.scriptHex,
    })));
    return { ...plan, workerAttestation };
  };
  try {
    return await confirmPlan(buildPlan({ ...params, walletScript, paymentScript, candidates }));
  } catch (firstError) {
    if (firstError instanceof Error && firstError.name === "InsufficientSafeUtxosError") throw firstError;
    const expandedMinimum = params.paymentSats + Math.ceil(params.feeRateSatVb * 250) + MIN_CHANGE_SATS;
    if (expandedMinimum <= firstMinimum) throw firstError;
    const expanded = await fetchCandidates(expandedMinimum);
    return await confirmPlan(buildPlan({ ...params, walletScript, paymentScript, candidates: expanded }));
  }
}

export function getInscribePaymentSignOptions(plan: InscribePaymentPlan, address: string) {
  return {
    autoFinalized: false,
    toSignInputs: plan.inputs.map((input, index) => ({ index, address, publicKey: plan.publicKeyHex, ...(input.spendType === "taproot" ? { useTweakedSigner: true } : {}) })),
  };
}

function extractAndVerifySignedPayment(signedPsbtHex: string, plan: InscribePaymentPlan) {
  const signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex, { network: NETWORK });
  if (signedPsbt.inputCount !== plan.inputs.length || signedPsbt.txOutputs.length !== plan.outputs.length) throw new Error("UniSat returned a PSBT with an unexpected number of inputs/outputs; no broadcast.");
  for (let index = 0; index < plan.inputs.length; index += 1) {
    const item = signedPsbt.data.inputs[index];
    const planned = plan.inputs[index];
    const previous = bitcoin.Transaction.fromHex(planned.rawTxHex);
    const previousOutput = previous.outs[planned.vout];
    if (!previousOutput) throw new Error("The signed UTXO output does not exist in its previous transaction.");
    if (planned.spendType === "legacy") {
      if (!item.nonWitnessUtxo || !equalBytes(item.nonWitnessUtxo, hexBytes(planned.rawTxHex, "The previous transaction planifiée"))) throw new Error("UniSat changed an input non-witness proof; no broadcast.");
    } else if (!item.witnessUtxo || item.witnessUtxo.value !== BigInt(planned.valueSats) || !equalBytes(item.witnessUtxo.script, hexBytes(planned.scriptHex, "The planned UTXO script"))) {
      throw new Error("UniSat changed an input witness value or script; no broadcast.");
    }
    if (planned.spendType === "nested-segwit" && (!item.redeemScript || !equalBytes(item.redeemScript, hexBytes(planned.redeemScriptHex!, "The planned redeem script")))) throw new Error("UniSat changed le redeem script P2SH; no broadcast.");
    if (planned.spendType === "taproot") {
      const signature = item.tapKeySig;
      if (!signature || !item.tapInternalKey || !equalBytes(item.tapInternalKey, hexBytes(planned.tapInternalKeyHex!, "The Taproot internal key planifiée")) || item.tapScriptSig?.length || item.partialSig?.length || (signature.length !== 64 && !(signature.length === 65 && signature[64] === 1)) || (item.sighashType !== undefined && item.sighashType !== (signature.length === 64 ? bitcoin.Transaction.SIGHASH_DEFAULT : signature[64]))) throw new Error("UniSat Taproot signature is missing or unsupported; no broadcast.");
    } else {
      const signatures = item.partialSig;
      if (!signatures || signatures.length !== 1 || item.tapKeySig || item.tapScriptSig?.length || !equalBytes(signatures[0].pubkey, hexBytes(plan.publicKeyHex, "The planned public key")) || bitcoin.script.signature.decode(signatures[0].signature).hashType !== bitcoin.Transaction.SIGHASH_ALL || (item.sighashType !== undefined && item.sighashType !== bitcoin.Transaction.SIGHASH_ALL)) throw new Error("UniSat signature missing or unsupported; no broadcast.");
    }
  }
  let valid = false;
  try {
    valid = signedPsbt.validateSignaturesOfAllInputs((key, hash, signature) => key.length === 32 ? ecc.verifySchnorr(hash, key, signature) : ecc.verify(hash, key, signature));
  } catch { valid = false; }
  if (!valid) throw new Error("The signed PSBT contains a missing or invalid signature; no broadcast.");
  try { signedPsbt.finalizeAllInputs(); }
  catch { throw new Error("UniSat signatures cannot be safely finalized; no broadcast."); }
  const transaction = signedPsbt.extractTransaction(true);
  if (transaction.ins.length !== plan.inputs.length || transaction.outs.length !== plan.outputs.length || transaction.version !== 2 || transaction.locktime !== 0) throw new Error("The signed transaction differs from the exact presented plan.");
  for (let index = 0; index < plan.inputs.length; index += 1) {
    const actual = transaction.ins[index]; const expected = plan.inputs[index];
    if (Buffer.from(actual.hash).reverse().toString("hex") !== expected.txid || actual.index !== expected.vout || actual.sequence !== RBF_SEQUENCE) throw new Error("UniSat changed an input, ordering, or RBF; no broadcast.");
  }
  let outputTotal = 0;
  for (let index = 0; index < plan.outputs.length; index += 1) {
    const actual = transaction.outs[index]; const expected = plan.outputs[index];
    if (!equalBytes(actual.script, hexBytes(expected.scriptHex, "The planned output script")) || actual.value !== BigInt(expected.valueSats)) throw new Error("UniSat changed the reviewed amount, address, or change; no broadcast.");
    outputTotal += Number(actual.value);
  }
  const actualFee = plan.totalInputSats - outputTotal;
  if (!Number.isSafeInteger(actualFee) || actualFee !== plan.feeSats || actualFee < Math.ceil(plan.feeRateSatVb * transaction.virtualSize())) throw new Error("Actual fees after signing do not match the receipt/displayed rate; no broadcast.");
  return transaction.toHex();
}

export async function broadcastSignedInscribePayment(params: {
  signedPsbtHex: string; plan: InscribePaymentPlan; provider: {
    getAccounts: () => Promise<string[]>; getChain: () => Promise<{ enum?: string }>; getPublicKey: () => Promise<string>;
  }; isCurrentAttempt?: () => boolean;
}) {
  const { signedPsbtHex, plan, provider } = params;
  const [accounts, chain, publicKey] = await Promise.all([provider.getAccounts(), provider.getChain(), provider.getPublicKey()]);
  if (!accounts.includes(plan.walletAddress) || chain.enum !== plan.network || publicKey.toLowerCase() !== plan.publicKeyHex.toLowerCase()) throw new Error("Le compte, la clé ou le réseau UniSat a changé après signature; no transaction was broadcast.");
  const rawTxHex = extractAndVerifySignedPayment(signedPsbtHex, plan);
  const expectedTxid = bitcoin.Transaction.fromHex(rawTxHex).getId().toLowerCase();
  const mempool = getMempoolConfig(plan.network);
  if (!mempool) throw new Error("Mempool non configuré pour ce réseau; no broadcast.");
  if (params.isCurrentAttempt && !params.isCurrentAttempt()) throw new Error("UNISAT_SIGNATURE_STALE: le parcours mobile a été quitté avant l’envoi; no broadcast.");
  let returned: string;
  try {
    returned = await requestText(`${mempool.api}/api/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawTxHex }, 20_000);
  } catch (error) {
    throw new InscribePaymentBroadcastUnclearError(expectedTxid, error instanceof Error ? error.message : String(error));
  }
  const txid = returned.replace(/^"|"$/g, "").toLowerCase();
  if (txid !== expectedTxid) throw new InscribePaymentBroadcastUnclearError(expectedTxid, `Mempool did not confirmé le TXID attendu (retour ${txid || "vide"})`);
  return { txid, rawTxHex };
}
