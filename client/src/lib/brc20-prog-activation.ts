import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";

const NETWORK = bitcoin.networks.bitcoin;
const MAX_FEE_RATE = 1_000;
const MAX_INPUTS = 20;
const MIN_CHANGE = 600;
const RBF_SEQUENCE = 0xfffffffd;
const ACTIVATION_MARKER = Buffer.from("BRC20PROG", "ascii");
const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globalWithBuffer.Buffer) globalWithBuffer.Buffer = Buffer;
bitcoin.initEccLib(ecc);

export type Brc20ProgOutpoint = { txid: string; vout: number; valueSats: number; scriptHex: string; rawTxHex: string };
export type Brc20ProgActivationPlan = {
  psbtHex: string;
  feeRateSatVb: number;
  feeSats: number;
  estimatedVsize: number;
  totalInputSats: number;
  changeSats: number;
  inscriptionId: string;
  inscriptionOutpoint: string;
  inputs: Array<{ txid: string; vout: number; valueSats: number; scriptHex: string; spendType: "legacy" | "nested-segwit" | "native-segwit" | "taproot"; rawTxHex: string; redeemScriptHex?: string; tapInternalKeyHex?: string }>;
  outputs: Array<{ scriptHex: string; valueSats: number; role: "activation" | "change" }>;
};

type PreparedInput = Brc20ProgActivationPlan["inputs"][number];

function bytes(hex: string, label: string) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error(`${label} doit être une suite hexadécimale valide.`);
  return Buffer.from(hex, "hex");
}
function sameBytes(left: Uint8Array, right: Uint8Array) { return Buffer.from(left).equals(Buffer.from(right)); }
function parseLocation(value: string | undefined) {
  const match = value?.match(/^([a-f0-9]{64}):(\d+):(\d+)$/i);
  if (!match) throw new Error("UniSat n’a pas fourni un emplacement d’inscription valide.");
  const vout = Number(match[2]);
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(vout) || vout < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("L’emplacement de l’inscription est hors limites.");
  return { txid: match[1].toLowerCase(), vout, offset };
}
function walletTemplates(publicKeyHex: string) {
  const publicKey = bytes(publicKeyHex, "Clé publique UniSat");
  if (publicKey.length !== 33 || (publicKey[0] !== 2 && publicKey[0] !== 3) || !ecc.isPoint(publicKey)) throw new Error("UniSat n’a pas fourni une clé publique compressée valide.");
  const native = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: NETWORK });
  const nativeScript = Buffer.from(native.output!);
  const nested = bitcoin.payments.p2sh({ redeem: native, network: NETWORK });
  const tapInternalKey = Buffer.from(bitcoin.toXOnly(publicKey));
  const taproot = bitcoin.payments.p2tr({ internalPubkey: tapInternalKey, network: NETWORK });
  return {
    publicKey,
    scripts: [
      { type: "legacy" as const, script: Buffer.from(bitcoin.payments.p2pkh({ pubkey: publicKey, network: NETWORK }).output!) },
      { type: "nested-segwit" as const, script: Buffer.from(nested.output!), redeemScript: nativeScript },
      { type: "native-segwit" as const, script: nativeScript },
      { type: "taproot" as const, script: Buffer.from(taproot.output!), tapInternalKey },
    ],
  };
}
function prepareInput(ref: Brc20ProgOutpoint, templates: ReturnType<typeof walletTemplates>["scripts"]): PreparedInput {
  if (!/^[a-f0-9]{64}$/i.test(ref.txid) || !Number.isSafeInteger(ref.vout) || ref.vout < 0) throw new Error("UniSat a fourni un UTXO invalide.");
  const previous = bitcoin.Transaction.fromHex(ref.rawTxHex);
  if (previous.getId().toLowerCase() !== ref.txid.toLowerCase()) throw new Error("La transaction précédente ne correspond pas au TXID de l’UTXO.");
  const output = previous.outs[ref.vout];
  if (!output) throw new Error("La sortie déclarée par UniSat n’existe pas dans la transaction précédente.");
  const valueSats = Number(output.value);
  if (!Number.isSafeInteger(valueSats) || valueSats <= 0 || valueSats !== ref.valueSats || !sameBytes(output.script, bytes(ref.scriptHex, "Script UTXO"))) throw new Error("La valeur ou le script de l’UTXO ne correspond pas à la transaction Bitcoin.");
  const template = templates.find(item => sameBytes(item.script, output.script));
  if (!template) throw new Error("L’UTXO n’est pas contrôlable par la clé UniSat active avec un type de script pris en charge.");
  return {
    txid: ref.txid.toLowerCase(), vout: ref.vout, valueSats, scriptHex: Buffer.from(output.script).toString("hex"), rawTxHex: ref.rawTxHex,
    spendType: template.type,
    ...(template.type === "nested-segwit" ? { redeemScriptHex: template.redeemScript.toString("hex") } : {}),
    ...(template.type === "taproot" ? { tapInternalKeyHex: template.tapInternalKey.toString("hex") } : {}),
  };
}
function inputVsize(input: PreparedInput) { return input.spendType === "legacy" ? 150 : input.spendType === "nested-segwit" ? 93 : input.spendType === "taproot" ? 59 : 69; }
function outputVsize(script: Uint8Array) { return 8 + (script.length < 0xfd ? 1 : 3) + script.length; }
function addInput(psbt: bitcoin.Psbt, input: PreparedInput) {
  const common = { hash: input.txid, index: input.vout, sequence: RBF_SEQUENCE };
  if (input.spendType === "legacy") {
    psbt.addInput({ ...common, nonWitnessUtxo: bytes(input.rawTxHex, "Transaction précédente") });
    return;
  }
  psbt.addInput({
    ...common,
    witnessUtxo: { script: bytes(input.scriptHex, "Script témoin UTXO"), value: BigInt(input.valueSats) },
    ...(input.redeemScriptHex ? { redeemScript: bytes(input.redeemScriptHex, "Redeem script") } : {}),
    ...(input.tapInternalKeyHex ? { tapInternalKey: bytes(input.tapInternalKeyHex, "Clé interne Taproot") } : {}),
  });
}

/** Build a mainnet-only BRC2.0 activation PSBT. Fee UTXOs must already be independently verified as confirmed and asset-free. */
export function buildBrc20ProgActivationPsbt(params: {
  walletAddress: string;
  publicKeyHex: string;
  inscriptionId: string;
  inscriptionLocation: string;
  ownedInscriptions: Array<{ inscriptionId: string; location?: string }>;
  inscriptionOutput: Brc20ProgOutpoint;
  spendableFeeUtxos: Brc20ProgOutpoint[];
  feeRateSatVb: number;
}): Brc20ProgActivationPlan {
  if (!/^[a-f0-9]{64}i\d+$/i.test(params.inscriptionId)) throw new Error("ID d’inscription BRC2.0 invalide.");
  if (!Number.isFinite(params.feeRateSatVb) || params.feeRateSatVb < 1 || params.feeRateSatVb > MAX_FEE_RATE) throw new Error("Le taux de frais Bitcoin est hors des limites autorisées.");
  const location = parseLocation(params.inscriptionLocation);
  if (location.txid !== params.inscriptionOutput.txid.toLowerCase() || location.vout !== params.inscriptionOutput.vout || location.offset >= params.inscriptionOutput.valueSats) throw new Error("L’outpoint ou l’offset de l’inscription ne correspond pas à sa sortie Bitcoin.");
  const inscriptionOutpoint = `${location.txid}:${location.vout}`;
  for (const item of params.ownedInscriptions) {
    if (item.inscriptionId.toLowerCase() === params.inscriptionId.toLowerCase()) continue;
    const other = parseLocation(item.location);
    if (`${other.txid}:${other.vout}` === inscriptionOutpoint) throw new Error("Plusieurs inscriptions partagent cet UTXO. Activation refusée pour éviter de dépenser une autre inscription.");
  }
  const { scripts } = walletTemplates(params.publicKeyHex);
  const walletScript = Buffer.from(bitcoin.address.toOutputScript(params.walletAddress, NETWORK));
  if (!scripts.some(item => sameBytes(item.script, walletScript))) throw new Error("L’adresse UniSat Bitcoin ne correspond pas à la clé active.");
  const inscriptionInput = prepareInput(params.inscriptionOutput, scripts);
  if (!sameBytes(bytes(inscriptionInput.scriptHex, "Script de l’inscription"), walletScript)) throw new Error("L’UTXO d’inscription n’appartient pas au script de l’adresse UniSat active.");

  const unique = new Map<string, Brc20ProgOutpoint>();
  for (const item of params.spendableFeeUtxos) {
    const key = `${item.txid.toLowerCase()}:${item.vout}`;
    if (key === inscriptionOutpoint) continue;
    if (unique.has(key)) throw new Error("Le service UTXO a retourné un doublon.");
    unique.set(key, item);
  }
  const feeCandidates = Array.from(unique.values()).map(item => prepareInput(item, scripts)).filter(item => sameBytes(bytes(item.scriptHex, "Script des frais"), walletScript)).sort((a, b) => b.valueSats - a.valueSats).slice(0, MAX_INPUTS - 1);
  if (feeCandidates.length === 0) throw new Error("Aucun UTXO Bitcoin confirmé, sans actif et contrôlé par ce wallet n’est disponible pour les frais.");

  const activationScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, ACTIVATION_MARKER]);
  const walletOutputSize = outputVsize(walletScript);
  let chosen: PreparedInput[] | null = null;
  let feeSats = 0;
  let estimatedVsize = 0;
  let changeSats = 0;
  const selected: PreparedInput[] = [];
  for (const candidate of feeCandidates) {
    selected.push(candidate);
    const inputs = [inscriptionInput, ...selected];
    const vsize = 12 + inputs.reduce((sum, input) => sum + inputVsize(input), 0) + outputVsize(activationScript) + walletOutputSize;
    const fee = Math.ceil(vsize * params.feeRateSatVb);
    const total = inputs.reduce((sum, input) => sum + input.valueSats, 0);
    const change = total - fee;
    if (Number.isSafeInteger(total) && change >= MIN_CHANGE) {
      chosen = [...inputs]; feeSats = fee; estimatedVsize = vsize; changeSats = change; break;
    }
  }
  if (!chosen) throw new Error("Les UTXO sûrs ne couvrent pas les frais et une monnaie non-dust. Aucun PSBT n’a été créé.");

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.setVersion(2);
  chosen.forEach(input => addInput(psbt, input));
  psbt.addOutput({ script: activationScript, value: BigInt(0) });
  psbt.addOutput({ script: walletScript, value: BigInt(changeSats) });
  const totalInputSats = chosen.reduce((sum, input) => sum + input.valueSats, 0);
  if (totalInputSats - changeSats !== feeSats) throw new Error("Écart comptable interne; aucun PSBT n’a été créé.");
  return {
    psbtHex: psbt.toHex(), feeRateSatVb: params.feeRateSatVb, feeSats, estimatedVsize, totalInputSats, changeSats,
    inscriptionId: params.inscriptionId, inscriptionOutpoint,
    inputs: chosen,
    outputs: [
      { scriptHex: Buffer.from(activationScript).toString("hex"), valueSats: 0, role: "activation" },
      { scriptHex: walletScript.toString("hex"), valueSats: changeSats, role: "change" },
    ],
  };
}

/** Ensure UniSat returned a finalized transaction with exactly the planned inputs and outputs. */
export function extractVerifiedBrc20ProgActivation(signedPsbtHex: string, plan: Brc20ProgActivationPlan) {
  let signed: bitcoin.Psbt;
  try { signed = bitcoin.Psbt.fromHex(signedPsbtHex, { network: NETWORK }); }
  catch { throw new Error("UniSat a retourné un PSBT illisible. Aucune transaction n’a été diffusée."); }
  const planned = bitcoin.Psbt.fromHex(plan.psbtHex, { network: NETWORK });
  if (signed.version !== planned.version || signed.locktime !== planned.locktime || signed.txInputs.length !== planned.txInputs.length || signed.txOutputs.length !== planned.txOutputs.length) throw new Error("UniSat a modifié les entrées ou sorties prévues. Aucune transaction n’a été diffusée.");
  for (let index = 0; index < planned.txInputs.length; index += 1) {
    const expected = planned.txInputs[index];
    const actual = signed.txInputs[index];
    if (!sameBytes(actual.hash, expected.hash) || actual.index !== expected.index || actual.sequence !== expected.sequence) throw new Error("UniSat a modifié une entrée après signature. Aucune transaction n’a été diffusée.");
  }
  for (let index = 0; index < planned.txOutputs.length; index += 1) {
    const expected = planned.txOutputs[index];
    const actual = signed.txOutputs[index];
    if (!sameBytes(actual.script, expected.script) || actual.value !== expected.value) throw new Error("UniSat a modifié une sortie après signature. Aucune transaction n’a été diffusée.");
  }
  const tx = signed.extractTransaction();
  if (tx.ins.length !== plan.inputs.length || tx.outs.length !== plan.outputs.length) throw new Error("La transaction signée ne correspond pas au plan d’activation.");
  for (let index = 0; index < plan.outputs.length; index += 1) {
    const expected = plan.outputs[index];
    const output = tx.outs[index];
    if (Number(output.value) !== expected.valueSats || Buffer.from(output.script).toString("hex") !== expected.scriptHex) throw new Error("UniSat a modifié une sortie après signature. Aucune transaction n’a été diffusée.");
  }
  return { txHex: tx.toHex(), txid: tx.getId() };
}

export const BRC20_PROG_ACTIVATION_SCRIPT_HEX = Buffer.from(bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, ACTIVATION_MARKER])).toString("hex");
