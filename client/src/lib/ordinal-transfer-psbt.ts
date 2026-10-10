import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";

const globalWithBuffer = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
};
if (!globalWithBuffer.Buffer) globalWithBuffer.Buffer = Buffer;
bitcoin.initEccLib(ecc);

const MAINNET = bitcoin.networks.bitcoin;
export const MIN_SAFE_OUTPUT_SATS = 1_200;
const MAX_FEE_RATE_SAT_VB = 1_000;
const MAX_INPUTS = 20;

export type SpendType =
  | "legacy"
  | "nested-segwit"
  | "native-segwit"
  | "taproot";
export type OutputType = SpendType | "native-segwit-script-hash";

export interface OrdinalLocation {
  inscriptionId: string;
  location?: string;
}

export interface PreviousOutputRef {
  txid: string;
  vout: number;
  rawTxHex: string;
  expectedScriptHex?: string;
  expectedValueSats?: number;
}

export interface PreparedInput extends PreviousOutputRef {
  valueSats: number;
  scriptHex: string;
  spendType: SpendType;
  redeemScriptHex?: string;
  tapInternalKeyHex?: string;
}

export interface PlannedOutput {
  scriptHex: string;
  valueSats: number;
}

export interface OrdinalTransferPlan {
  psbtHex: string;
  publicKeyHex: string;
  transactionVersion: number;
  lockTime: number;
  inputSequence: number;
  inscriptionOutpoint: string;
  inscriptionOffsetSats: number;
  recipientOutputSats: number;
  changeOutputSats: number;
  feeSats: number;
  estimatedVsize: number;
  feeRateSatVb: number;
  totalInputSats: number;
  inputs: PreparedInput[];
  outputs: PlannedOutput[];
}

function requireBytes(bytes: Uint8Array | undefined, label: string): Buffer {
  if (!bytes || bytes.length === 0)
    throw new Error(`Could not derive the ${label} script.`);
  return Buffer.from(bytes);
}

function decodeHex(hex: string, label: string): Buffer {
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex))
    throw new Error(`${label} must be valid, even-length hex.`);
  return Buffer.from(hex, "hex");
}

function publicKeyFromHex(publicKeyHex: string): Buffer {
  const publicKey = decodeHex(publicKeyHex, "UniSat public key");
  if (publicKey.length !== 33 || (publicKey[0] !== 2 && publicKey[0] !== 3)) {
    throw new Error(
      "UniSat did not return a compressed public key for the active account."
    );
  }
  if (!ecc.isPoint(publicKey))
    throw new Error("UniSat returned an invalid public key.");
  return publicKey;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return Buffer.from(left).equals(Buffer.from(right));
}

function walletSpendTemplates(publicKey: Buffer) {
  const native = bitcoin.payments.p2wpkh({
    pubkey: publicKey,
    network: MAINNET,
  });
  const nativeScript = requireBytes(native.output, "Native SegWit");
  const nested = bitcoin.payments.p2sh({ redeem: native, network: MAINNET });
  const tapInternalKey = Buffer.from(bitcoin.toXOnly(publicKey));
  const taproot = bitcoin.payments.p2tr({
    internalPubkey: tapInternalKey,
    network: MAINNET,
  });

  return [
    {
      type: "legacy" as const,
      script: requireBytes(
        bitcoin.payments.p2pkh({ pubkey: publicKey, network: MAINNET }).output,
        "Legacy"
      ),
    },
    {
      type: "nested-segwit" as const,
      script: requireBytes(nested.output, "Nested SegWit"),
      redeemScript: nativeScript,
    },
    { type: "native-segwit" as const, script: nativeScript },
    {
      type: "taproot" as const,
      script: requireBytes(taproot.output, "Taproot"),
      tapInternalKey,
    },
  ];
}

export function identifyStandardOutputScript(scriptHex: string): OutputType {
  const script = decodeHex(scriptHex, "output script");
  if (
    script.length === 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  )
    return "legacy";
  if (
    script.length === 23 &&
    script[0] === 0xa9 &&
    script[1] === 0x14 &&
    script[22] === 0x87
  ) {
    return "nested-segwit";
  }
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14)
    return "native-segwit";
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20)
    return "native-segwit-script-hash";
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20)
    return "taproot";
  throw new Error(
    "This prototype accepts only standard Legacy, SegWit v0, or Taproot output scripts."
  );
}

function parseLocation(location: string | undefined) {
  const match = location?.match(/^([a-f0-9]{64}):(\d+):(\d+)$/i);
  if (!match)
    throw new Error(
      "UniSat did not provide a valid inscription outpoint and sat offset."
    );
  const vout = Number(match[2]);
  const offsetSats = Number(match[3]);
  if (
    !Number.isSafeInteger(vout) ||
    vout < 0 ||
    !Number.isSafeInteger(offsetSats) ||
    offsetSats < 0
  ) {
    throw new Error(
      "The inscription outpoint or sat offset is outside supported bounds."
    );
  }
  return { txid: match[1].toLowerCase(), vout, offsetSats };
}

function outpoint(txid: string, vout: number) {
  return `${txid.toLowerCase()}:${vout}`;
}

function preparedInput(
  ref: PreviousOutputRef,
  publicKey: Buffer
): PreparedInput {
  if (
    !/^[a-f0-9]{64}$/i.test(ref.txid) ||
    !Number.isSafeInteger(ref.vout) ||
    ref.vout < 0
  ) {
    throw new Error("A wallet UTXO has an invalid outpoint.");
  }
  const raw = decodeHex(ref.rawTxHex, "previous transaction");
  const previousTx = bitcoin.Transaction.fromBuffer(raw);
  if (previousTx.getId().toLowerCase() !== ref.txid.toLowerCase()) {
    throw new Error(
      "A previous transaction does not match the wallet-reported outpoint."
    );
  }
  const previousOutput = previousTx.outs[ref.vout];
  if (!previousOutput)
    throw new Error(
      "A wallet UTXO refers to a missing previous transaction output."
    );
  const valueSats = Number(previousOutput.value);
  if (!Number.isSafeInteger(valueSats) || valueSats <= 0)
    throw new Error("A wallet UTXO has an invalid satoshi value.");
  if (
    ref.expectedValueSats !== undefined &&
    valueSats !== ref.expectedValueSats
  ) {
    throw new Error("The indexed spendable UTXO value does not match Mempool.");
  }
  if (
    ref.expectedScriptHex !== undefined &&
    !equalBytes(
      previousOutput.script,
      decodeHex(ref.expectedScriptHex, "indexed spendable UTXO script")
    )
  ) {
    throw new Error(
      "The indexed spendable UTXO script does not match Mempool."
    );
  }

  const template = walletSpendTemplates(publicKey).find(candidate =>
    equalBytes(candidate.script, previousOutput.script)
  );
  if (!template) {
    throw new Error(
      "A candidate input is not spendable by the active UniSat account as Legacy, Nested SegWit, Native SegWit, or Taproot."
    );
  }

  return {
    ...ref,
    txid: ref.txid.toLowerCase(),
    valueSats,
    scriptHex: Buffer.from(previousOutput.script).toString("hex"),
    spendType: template.type,
    ...(template.redeemScript
      ? { redeemScriptHex: template.redeemScript.toString("hex") }
      : {}),
    ...(template.tapInternalKey
      ? { tapInternalKeyHex: template.tapInternalKey.toString("hex") }
      : {}),
  };
}

function varIntSize(value: number) {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  return 5;
}

function inputVirtualSize(input: PreparedInput) {
  switch (input.spendType) {
    case "legacy":
      return 150;
    case "nested-segwit":
      return 93;
    case "native-segwit":
      return 69;
    case "taproot":
      return 59;
  }
}

function outputVirtualSize(scriptHex: string) {
  const script = decodeHex(scriptHex, "output script");
  return 8 + varIntSize(script.length) + script.length;
}

function estimateVsize(inputs: PreparedInput[], scripts: string[]) {
  return (
    10 +
    inputs.reduce((sum, input) => sum + inputVirtualSize(input), 0) +
    scripts.reduce((sum, script) => sum + outputVirtualSize(script), 0)
  );
}

function addPsbtInput(psbt: bitcoin.Psbt, input: PreparedInput) {
  const script = decodeHex(input.scriptHex, "input script");
  const common = { hash: input.txid, index: input.vout, sequence: 0xffffffff };
  if (input.spendType === "legacy") {
    psbt.addInput({
      ...common,
      nonWitnessUtxo: decodeHex(
        input.rawTxHex,
        "non-witness previous transaction"
      ),
    });
    return;
  }
  psbt.addInput({
    ...common,
    witnessUtxo: { script, value: BigInt(input.valueSats) },
    ...(input.redeemScriptHex
      ? {
          redeemScript: decodeHex(
            input.redeemScriptHex,
            "Nested SegWit redeem script"
          ),
        }
      : {}),
    ...(input.tapInternalKeyHex
      ? {
          tapInternalKey: decodeHex(
            input.tapInternalKeyHex,
            "Taproot internal key"
          ),
        }
      : {}),
  });
}

export function buildOrdinalTransferPsbt(params: {
  selectedInscription: OrdinalLocation;
  ownedInscriptions: OrdinalLocation[];
  inscriptionPreviousTxHex: string;
  spendableFeeUtxos: PreviousOutputRef[];
  publicKeyHex: string;
  recipientScriptHex: string;
  changeScriptHex: string;
  feeRateSatVb: number;
}): OrdinalTransferPlan {
  const { selectedInscription, ownedInscriptions, spendableFeeUtxos } = params;
  const location = parseLocation(selectedInscription.location);
  const recipientType = identifyStandardOutputScript(params.recipientScriptHex);
  const changeType = identifyStandardOutputScript(params.changeScriptHex);
  if (recipientType === "native-segwit-script-hash") {
    // P2WSH is safe as a recipient output; source inputs still require an active UniSat key/script.
  }
  if (changeType === "native-segwit-script-hash") {
    throw new Error(
      "P2WSH change is not supported by this single-key wallet prototype."
    );
  }
  if (
    !Number.isFinite(params.feeRateSatVb) ||
    params.feeRateSatVb <= 0 ||
    params.feeRateSatVb > MAX_FEE_RATE_SAT_VB
  ) {
    throw new Error(
      "The Mempool fee rate is outside the prototype's safe bounds."
    );
  }
  const publicKey = publicKeyFromHex(params.publicKeyHex);
  const inscriptionOutpoint = outpoint(location.txid, location.vout);
  const otherInscriptionsInSameOutput = ownedInscriptions.filter(
    item =>
      item.inscriptionId.toLowerCase() !==
        selectedInscription.inscriptionId.toLowerCase() &&
      (() => {
        try {
          const other = parseLocation(item.location);
          return outpoint(other.txid, other.vout) === inscriptionOutpoint;
        } catch {
          return false;
        }
      })()
  );
  if (otherInscriptionsInSameOutput.length > 0) {
    throw new Error(
      "This output contains multiple inscriptions. The prototype refuses to transfer them together or risk misrouting an Ordinal."
    );
  }

  const inscriptionInput = preparedInput(
    {
      txid: location.txid,
      vout: location.vout,
      rawTxHex: params.inscriptionPreviousTxHex,
    },
    publicKey
  );
  if (location.offsetSats >= inscriptionInput.valueSats) {
    throw new Error("The inscription sat offset is outside its source output.");
  }

  const inscribedOutpoints = new Set<string>([inscriptionOutpoint]);
  for (const item of ownedInscriptions) {
    try {
      const parsed = parseLocation(item.location);
      inscribedOutpoints.add(outpoint(parsed.txid, parsed.vout));
    } catch {
      throw new Error(
        "UniSat returned an inscription without a valid outpoint; refusing to spend wallet UTXOs."
      );
    }
  }

  const uniqueRefs = new Map<string, PreviousOutputRef>();
  for (const ref of spendableFeeUtxos) {
    const key = outpoint(ref.txid, ref.vout);
    if (inscribedOutpoints.has(key) || key === inscriptionOutpoint) continue;
    if (!uniqueRefs.has(key)) uniqueRefs.set(key, ref);
  }
  const feeCandidates = Array.from(uniqueRefs.values())
    .map(ref => preparedInput(ref, publicKey))
    .sort((left, right) => right.valueSats - left.valueSats)
    .slice(0, MAX_INPUTS - 1);

  const recipientScript = decodeHex(
    params.recipientScriptHex,
    "recipient script"
  );
  const changeScript = decodeHex(params.changeScriptHex, "change script");
  const recipientOutputSats = Math.max(
    MIN_SAFE_OUTPUT_SATS,
    location.offsetSats + 1
  );
  if (!Number.isSafeInteger(recipientOutputSats))
    throw new Error("The inscription sat offset is too large.");

  let chosenFeeInputs: PreparedInput[] | undefined;
  let changeOutputSats = 0;
  let feeSats = 0;
  let estimatedVsize = 0;
  for (let count = 1; count <= feeCandidates.length; count += 1) {
    const selected = feeCandidates.slice(0, count);
    const inputs = [inscriptionInput, ...selected];
    const totalInputSats = inputs.reduce(
      (sum, input) => sum + input.valueSats,
      0
    );
    const feeWithChange = Math.ceil(
      estimateVsize(inputs, [
        params.recipientScriptHex,
        params.changeScriptHex,
      ]) * params.feeRateSatVb
    );
    const possibleChange = totalInputSats - recipientOutputSats - feeWithChange;
    if (possibleChange >= MIN_SAFE_OUTPUT_SATS) {
      chosenFeeInputs = selected;
      changeOutputSats = possibleChange;
      feeSats = feeWithChange;
      estimatedVsize = estimateVsize(inputs, [
        params.recipientScriptHex,
        params.changeScriptHex,
      ]);
      break;
    }

    const feeWithoutChange = Math.ceil(
      estimateVsize(inputs, [params.recipientScriptHex]) * params.feeRateSatVb
    );
    const possibleFee = totalInputSats - recipientOutputSats;
    const maxNoChangeOverpay = Math.max(
      200,
      Math.ceil(params.feeRateSatVb * 25)
    );
    if (
      possibleFee >= feeWithoutChange &&
      possibleFee - feeWithoutChange <= maxNoChangeOverpay
    ) {
      chosenFeeInputs = selected;
      feeSats = possibleFee;
      estimatedVsize = estimateVsize(inputs, [params.recipientScriptHex]);
      break;
    }
  }
  if (!chosenFeeInputs) {
    throw new Error(
      "Insufficient compatible non-inscription UTXOs to fund the safe inscription output, network fee, and non-dust change. No transaction was signed or broadcast."
    );
  }

  const inputs = [inscriptionInput, ...chosenFeeInputs];
  const totalInputSats = inputs.reduce(
    (sum, input) => sum + input.valueSats,
    0
  );
  const outputs: PlannedOutput[] = [
    {
      scriptHex: params.recipientScriptHex.toLowerCase(),
      valueSats: recipientOutputSats,
    },
  ];
  if (changeOutputSats > 0)
    outputs.push({
      scriptHex: params.changeScriptHex.toLowerCase(),
      valueSats: changeOutputSats,
    });
  if (outputs.some(output => output.valueSats < MIN_SAFE_OUTPUT_SATS)) {
    throw new Error(
      "The prototype would create a dust output; refusing to construct the PSBT."
    );
  }
  if (
    totalInputSats -
      outputs.reduce((sum, output) => sum + output.valueSats, 0) !==
    feeSats
  ) {
    throw new Error(
      "Internal transaction accounting mismatch; refusing to construct the PSBT."
    );
  }

  const psbt = new bitcoin.Psbt({ network: MAINNET });
  psbt.setVersion(2);
  for (const input of inputs) addPsbtInput(psbt, input);
  for (const output of outputs) {
    psbt.addOutput({
      script: decodeHex(output.scriptHex, "transaction output script"),
      value: BigInt(output.valueSats),
    });
  }

  return {
    psbtHex: psbt.toHex(),
    publicKeyHex: publicKey.toString("hex"),
    transactionVersion: 2,
    lockTime: 0,
    inputSequence: 0xffffffff,
    inscriptionOutpoint,
    inscriptionOffsetSats: location.offsetSats,
    recipientOutputSats,
    changeOutputSats,
    feeSats,
    estimatedVsize,
    feeRateSatVb: params.feeRateSatVb,
    totalInputSats,
    inputs,
    outputs,
  };
}

export function extractAndVerifySignedOrdinalTransaction(
  signedPsbtHex: string,
  plan: OrdinalTransferPlan
) {
  const signedPsbt = bitcoin.Psbt.fromHex(signedPsbtHex, { network: MAINNET });
  if (
    signedPsbt.inputCount !== plan.inputs.length ||
    signedPsbt.txOutputs.length !== plan.outputs.length
  ) {
    throw new Error(
      "UniSat returned a signed PSBT with an unexpected number of inputs or outputs."
    );
  }
  for (let index = 0; index < plan.inputs.length; index += 1) {
    const input = signedPsbt.data.inputs[index];
    if (plan.inputs[index].spendType === "taproot") {
      const signature = input.tapKeySig;
      if (
        !signature ||
        input.tapScriptSig?.length ||
        input.partialSig?.length ||
        (signature.length !== 64 &&
          !(signature.length === 65 && signature[64] === 1)) ||
        (input.sighashType !== undefined &&
          input.sighashType !== bitcoin.Transaction.SIGHASH_DEFAULT &&
          input.sighashType !== bitcoin.Transaction.SIGHASH_ALL) ||
        (input.sighashType !== undefined &&
          input.sighashType !==
            (signature.length === 64
              ? bitcoin.Transaction.SIGHASH_DEFAULT
              : signature[64]))
      ) {
        throw new Error(
          "UniSat returned an unsupported Taproot key-path signature; refusing to broadcast."
        );
      }
    } else {
      const signatures = input.partialSig;
      if (
        !signatures ||
        signatures.length !== 1 ||
        input.tapKeySig ||
        input.tapScriptSig?.length ||
        !equalBytes(
          signatures[0].pubkey,
          decodeHex(plan.publicKeyHex, "planned signer public key")
        ) ||
        bitcoin.script.signature.decode(signatures[0].signature).hashType !==
          bitcoin.Transaction.SIGHASH_ALL ||
        (input.sighashType !== undefined &&
          input.sighashType !== bitcoin.Transaction.SIGHASH_ALL)
      ) {
        throw new Error(
          "UniSat returned an unsupported input signature; refusing to broadcast."
        );
      }
    }
  }
  let signaturesValid = false;
  try {
    signaturesValid = signedPsbt.validateSignaturesOfAllInputs(
      (publicKey, messageHash, signature) =>
        publicKey.length === 32
          ? ecc.verifySchnorr(messageHash, publicKey, signature)
          : ecc.verify(messageHash, publicKey, signature)
    );
  } catch {
    signaturesValid = false;
  }
  if (!signaturesValid) {
    throw new Error(
      "The signed PSBT contains a missing or invalid signature; refusing to broadcast."
    );
  }
  try {
    signedPsbt.finalizeAllInputs();
  } catch {
    throw new Error(
      "UniSat's signatures could not be finalized safely; refusing to broadcast."
    );
  }
  const transaction = signedPsbt.extractTransaction(true);
  if (
    transaction.ins.length !== plan.inputs.length ||
    transaction.outs.length !== plan.outputs.length ||
    transaction.version !== plan.transactionVersion ||
    transaction.locktime !== plan.lockTime
  ) {
    throw new Error(
      "The signed transaction differs from the reviewed PSBT plan."
    );
  }
  for (let index = 0; index < plan.inputs.length; index += 1) {
    const actual = transaction.ins[index];
    const expected = plan.inputs[index];
    const actualTxid = Buffer.from(actual.hash).reverse().toString("hex");
    if (
      actualTxid !== expected.txid ||
      actual.index !== expected.vout ||
      actual.sequence !== plan.inputSequence
    ) {
      throw new Error(
        "UniSat changed the planned input order; refusing to broadcast to protect the inscription sat."
      );
    }
  }
  let outputTotal = 0;
  for (let index = 0; index < plan.outputs.length; index += 1) {
    const actual = transaction.outs[index];
    const expected = plan.outputs[index];
    if (
      !equalBytes(
        actual.script,
        decodeHex(expected.scriptHex, "planned output script")
      ) ||
      actual.value !== BigInt(expected.valueSats)
    ) {
      throw new Error(
        "UniSat changed a reviewed transaction output; refusing to broadcast."
      );
    }
    if (Number(actual.value) < MIN_SAFE_OUTPUT_SATS)
      throw new Error(
        "The signed transaction contains a dust output; refusing to broadcast."
      );
    outputTotal += Number(actual.value);
  }
  const actualFee = plan.totalInputSats - outputTotal;
  if (actualFee !== plan.feeSats || actualFee <= 0) {
    throw new Error(
      "The signed transaction fee differs from the reviewed plan; refusing to broadcast."
    );
  }
  if (actualFee < Math.ceil(plan.feeRateSatVb * transaction.virtualSize())) {
    throw new Error(
      "The finalized transaction's actual virtual size would underpay the reviewed fee rate; refusing to broadcast."
    );
  }
  return transaction.toHex();
}
