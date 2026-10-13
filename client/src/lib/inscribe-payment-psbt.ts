import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { getMempoolConfig, getSpendableUtxos } from "@/lib/mempool";
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
};

export class InscribePaymentBroadcastUnclearError extends Error {
  readonly txid: string;
  constructor(txid: string, detail: string) {
    super(`BROADCAST_OUTCOME_UNCLEAR: ${detail}. Vérifiez ${txid} dans Mempool avant toute nouvelle tentative.`);
    this.name = "InscribePaymentBroadcastUnclearError";
    this.txid = txid;
  }
}

function hexBytes(hex: string, label: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error(`${label} n’est pas un hexadécimal valide.`);
  return Buffer.from(hex, "hex");
}
function publicKeyBytes(publicKeyHex: string) {
  const key = hexBytes(publicKeyHex, "La clé publique UniSat");
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3) || !ecc.isPoint(key)) {
    throw new Error("UniSat n’a pas fourni une clé publique comprimée valide.");
  }
  return key;
}
function equalBytes(left: Uint8Array, right: Uint8Array) {
  return Buffer.from(left).equals(Buffer.from(right));
}
function scriptFromAddress(address: string, label: string) {
  try { return Buffer.from(bitcoin.address.toOutputScript(address, NETWORK)); }
  catch { throw new Error(`L’adresse ${label} est invalide ou hors réseau principal Bitcoin/Fractal.`); }
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
  catch { throw new Error(`Mempool n’a pas renvoyé une validation JSON pour l’adresse ${label}.`); }
  if (!result.isvalid || typeof result.scriptPubKey !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(result.scriptPubKey) || !equalBytes(expected, hexBytes(result.scriptPubKey, `script ${label}`))) {
    throw new Error(`L’adresse ${label} ou son script ne correspond pas au réseau Mempool sélectionné.`);
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
    psbt.addInput({ ...common, nonWitnessUtxo: hexBytes(input.rawTxHex, "La transaction précédente") });
  } else {
    psbt.addInput({
      ...common,
      witnessUtxo: { script: hexBytes(input.scriptHex, "Le script UTXO"), value: BigInt(input.valueSats) },
      ...(input.redeemScriptHex ? { redeemScript: hexBytes(input.redeemScriptHex, "Le redeem script") } : {}),
      ...(input.tapInternalKeyHex ? { tapInternalKey: hexBytes(input.tapInternalKeyHex, "La clé interne Taproot") } : {}),
    });
  }
}

function prepareInput(utxo: Awaited<ReturnType<typeof getSpendableUtxos>>[number], rawTxHex: string, walletScript: Buffer, templates: ReturnType<typeof walletTemplates>): InscribePaymentInput {
  const txid = utxo.txid.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(utxo.vout) || utxo.vout < 0) throw new Error("Le service Worker a fourni un outpoint invalide.");
  const previous = bitcoin.Transaction.fromHex(rawTxHex);
  if (previous.getId().toLowerCase() !== txid) throw new Error("Les octets de transaction Mempool ne correspondent pas au TXID de l’UTXO sûr.");
  const output = previous.outs[utxo.vout];
  if (!output) throw new Error("Mempool ne trouve pas la sortie UTXO fournie par le Worker.");
  const valueSats = Number(output.value);
  if (!Number.isSafeInteger(valueSats) || valueSats !== utxo.satoshi || !equalBytes(output.script, hexBytes(utxo.scriptPk, "Le script UTXO du Worker")) || !equalBytes(output.script, walletScript)) {
    throw new Error("La valeur ou le script de la sortie sûre ne correspond pas à Mempool et à l’adresse UniSat.");
  }
  const template = templates.find(item => equalBytes(item.script, output.script));
  if (!template) throw new Error("L’UTXO n’est pas contrôlable par la clé UniSat active avec un script pris en charge.");
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
  if (!Number.isSafeInteger(paymentSats) || paymentSats <= 0) throw new Error("Le montant du reçu UniSat est invalide.");
  if (paymentSats < dustThreshold(paymentScript)) throw new Error("Le montant demandé par UniSat est inférieur au seuil anti-poussière de l’adresse de paiement.");
  if (!Number.isFinite(feeRateSatVb) || feeRateSatVb < 1 || feeRateSatVb > MAX_FEE_RATE_SAT_VB) throw new Error("Le taux Mempool est hors des limites sûres.");
  const unique = new Map<string, InscribePaymentInput>();
  for (const item of params.candidates) {
    const key = `${item.txid}:${item.vout}`;
    if (unique.has(key)) throw new Error("Le Worker a renvoyé deux fois le même UTXO; aucun paiement n’est préparé.");
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
    if (!Number.isSafeInteger(total)) throw new Error("Le total des entrées dépasse la précision sûre des satoshis.");
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
  if (!chosenInputs) throw new Error("Les UTXO sûrs confirmés ne couvrent pas le montant, les frais et une monnaie non poussiéreuse. Aucun PSBT n’a été envoyé à UniSat.");
  const totalInputSats = chosenInputs.reduce((sum, input) => sum + input.valueSats, 0);
  const outputs: InscribePaymentOutput[] = [{ scriptHex: paymentScript.toString("hex"), valueSats: paymentSats, role: "payment" }];
  if (changeSats > 0) outputs.push({ scriptHex: walletScript.toString("hex"), valueSats: changeSats, role: "change" });
  if (totalInputSats - outputs.reduce((sum, output) => sum + output.valueSats, 0) !== feeSats) throw new Error("Écart de comptabilité interne; aucun PSBT n’est créé.");
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
  if (!mempool) throw new Error("Aucun Mempool configuré pour ce réseau principal.");
  const publicKey = publicKeyBytes(params.publicKeyHex);
  const [walletScript, paymentScript] = await Promise.all([
    validatedScript(mempool.api, params.walletAddress, "wallet"),
    validatedScript(mempool.api, params.paymentAddress, "paiement"),
  ]);
  if (equalBytes(walletScript, paymentScript)) throw new Error("L’adresse de paiement du reçu est identique au script du wallet; aucun PSBT n’est préparé.");
  const templates = walletTemplates(publicKey);
  if (!templates.some(item => equalBytes(item.script, walletScript))) throw new Error("L’adresse UniSat ne correspond pas à la clé active sur un format P2PKH, P2SH-SegWit, SegWit ou Taproot pris en charge.");
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
  try {
    return buildPlan({ ...params, walletScript, paymentScript, candidates });
  } catch (firstError) {
    const expandedMinimum = params.paymentSats + Math.ceil(params.feeRateSatVb * 250) + MIN_CHANGE_SATS;
    if (expandedMinimum <= firstMinimum) throw firstError;
    const expanded = await fetchCandidates(expandedMinimum);
    return buildPlan({ ...params, walletScript, paymentScript, candidates: expanded });
  }
}

export function getInscribePaymentSignOptions(plan: InscribePaymentPlan, address: string) {
  return {
    autoFinalized: false,
    toSignInputs: plan.inputs.map((input, index) => ({ index, address, ...(input.spendType === "taproot" ? { useTweakedSigner: true } : {}) })),
  };
}

function extractAndVerifySignedPayment(signedPsbtHex: string, plan: InscribePaymentPlan) {
  const signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex, { network: NETWORK });
  if (signedPsbt.inputCount !== plan.inputs.length || signedPsbt.txOutputs.length !== plan.outputs.length) throw new Error("UniSat a renvoyé un PSBT avec un nombre d’entrées/sorties inattendu; aucune diffusion.");
  for (let index = 0; index < plan.inputs.length; index += 1) {
    const item = signedPsbt.data.inputs[index];
    const planned = plan.inputs[index];
    const previous = bitcoin.Transaction.fromHex(planned.rawTxHex);
    const previousOutput = previous.outs[planned.vout];
    if (!previousOutput) throw new Error("La sortie UTXO signée n’existe pas dans sa transaction précédente.");
    if (planned.spendType === "legacy") {
      if (!item.nonWitnessUtxo || !equalBytes(item.nonWitnessUtxo, hexBytes(planned.rawTxHex, "La transaction précédente planifiée"))) throw new Error("UniSat a modifié la preuve non-witness d’une entrée; aucune diffusion.");
    } else if (!item.witnessUtxo || item.witnessUtxo.value !== BigInt(planned.valueSats) || !equalBytes(item.witnessUtxo.script, hexBytes(planned.scriptHex, "Le script UTXO planifié"))) {
      throw new Error("UniSat a modifié la valeur ou le script witness d’une entrée; aucune diffusion.");
    }
    if (planned.spendType === "nested-segwit" && (!item.redeemScript || !equalBytes(item.redeemScript, hexBytes(planned.redeemScriptHex!, "Le redeem script planifié")))) throw new Error("UniSat a modifié le redeem script P2SH; aucune diffusion.");
    if (planned.spendType === "taproot") {
      const signature = item.tapKeySig;
      if (!signature || !item.tapInternalKey || !equalBytes(item.tapInternalKey, hexBytes(planned.tapInternalKeyHex!, "La clé interne Taproot planifiée")) || item.tapScriptSig?.length || item.partialSig?.length || (signature.length !== 64 && !(signature.length === 65 && signature[64] === 1)) || (item.sighashType !== undefined && item.sighashType !== (signature.length === 64 ? bitcoin.Transaction.SIGHASH_DEFAULT : signature[64]))) throw new Error("Signature Taproot UniSat absente ou non prise en charge; aucune diffusion.");
    } else {
      const signatures = item.partialSig;
      if (!signatures || signatures.length !== 1 || item.tapKeySig || item.tapScriptSig?.length || !equalBytes(signatures[0].pubkey, hexBytes(plan.publicKeyHex, "La clé publique planifiée")) || bitcoin.script.signature.decode(signatures[0].signature).hashType !== bitcoin.Transaction.SIGHASH_ALL || (item.sighashType !== undefined && item.sighashType !== bitcoin.Transaction.SIGHASH_ALL)) throw new Error("Signature UniSat absente ou non prise en charge; aucune diffusion.");
    }
  }
  let valid = false;
  try {
    valid = signedPsbt.validateSignaturesOfAllInputs((key, hash, signature) => key.length === 32 ? ecc.verifySchnorr(hash, key, signature) : ecc.verify(hash, key, signature));
  } catch { valid = false; }
  if (!valid) throw new Error("Le PSBT signé contient une signature manquante ou invalide; aucune diffusion.");
  try { signedPsbt.finalizeAllInputs(); }
  catch { throw new Error("Les signatures UniSat ne peuvent pas être finalisées de manière sûre; aucune diffusion."); }
  const transaction = signedPsbt.extractTransaction(true);
  if (transaction.ins.length !== plan.inputs.length || transaction.outs.length !== plan.outputs.length || transaction.version !== 2 || transaction.locktime !== 0) throw new Error("La transaction signée diffère du plan exact présenté.");
  for (let index = 0; index < plan.inputs.length; index += 1) {
    const actual = transaction.ins[index]; const expected = plan.inputs[index];
    if (Buffer.from(actual.hash).reverse().toString("hex") !== expected.txid || actual.index !== expected.vout || actual.sequence !== RBF_SEQUENCE) throw new Error("UniSat a modifié une entrée, l’ordre ou RBF; aucune diffusion.");
  }
  let outputTotal = 0;
  for (let index = 0; index < plan.outputs.length; index += 1) {
    const actual = transaction.outs[index]; const expected = plan.outputs[index];
    if (!equalBytes(actual.script, hexBytes(expected.scriptHex, "Le script de sortie planifié")) || actual.value !== BigInt(expected.valueSats)) throw new Error("UniSat a modifié le montant, l’adresse ou la monnaie examinés; aucune diffusion.");
    outputTotal += Number(actual.value);
  }
  const actualFee = plan.totalInputSats - outputTotal;
  if (!Number.isSafeInteger(actualFee) || actualFee !== plan.feeSats || actualFee < Math.ceil(plan.feeRateSatVb * transaction.virtualSize())) throw new Error("Les frais réels après signature ne correspondent pas au reçu/au taux affiché; aucune diffusion.");
  return transaction.toHex();
}

export async function broadcastSignedInscribePayment(params: {
  signedPsbtHex: string; plan: InscribePaymentPlan; provider: {
    getAccounts: () => Promise<string[]>; getChain: () => Promise<{ enum?: string }>; getPublicKey: () => Promise<string>;
  }; isCurrentAttempt?: () => boolean;
}) {
  const { signedPsbtHex, plan, provider } = params;
  const [accounts, chain, publicKey] = await Promise.all([provider.getAccounts(), provider.getChain(), provider.getPublicKey()]);
  if (!accounts.includes(plan.walletAddress) || chain.enum !== plan.network || publicKey.toLowerCase() !== plan.publicKeyHex.toLowerCase()) throw new Error("Le compte, la clé ou le réseau UniSat a changé après signature; aucune transaction n’a été diffusée.");
  const rawTxHex = extractAndVerifySignedPayment(signedPsbtHex, plan);
  const expectedTxid = bitcoin.Transaction.fromHex(rawTxHex).getId().toLowerCase();
  const mempool = getMempoolConfig(plan.network);
  if (!mempool) throw new Error("Mempool non configuré pour ce réseau; aucune diffusion.");
  if (params.isCurrentAttempt && !params.isCurrentAttempt()) throw new Error("UNISAT_SIGNATURE_STALE: le parcours mobile a été quitté avant l’envoi; aucune diffusion.");
  let returned: string;
  try {
    returned = await requestText(`${mempool.api}/api/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawTxHex }, 20_000);
  } catch (error) {
    throw new InscribePaymentBroadcastUnclearError(expectedTxid, error instanceof Error ? error.message : String(error));
  }
  const txid = returned.replace(/^"|"$/g, "").toLowerCase();
  if (txid !== expectedTxid) throw new InscribePaymentBroadcastUnclearError(expectedTxid, `Mempool n’a pas confirmé le TXID attendu (retour ${txid || "vide"})`);
  return { txid, rawTxHex };
}
