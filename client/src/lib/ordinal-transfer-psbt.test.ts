import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { describe, expect, it } from "vitest";
import {
  buildOrdinalTransferPsbt,
  extractAndVerifySignedOrdinalTransaction,
  identifyStandardOutputScript,
  MIN_SAFE_OUTPUT_SATS,
  type PreviousOutputRef,
  type SpendType,
} from "./ordinal-transfer-psbt";

bitcoin.initEccLib(ecc);

// This deterministic key is test-only and is never used outside this unit test.
const TEST_PRIVATE_KEY = Buffer.alloc(32);
TEST_PRIVATE_KEY[31] = 1;
const PUBLIC_KEY_HEX =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBLIC_KEY = Buffer.from(PUBLIC_KEY_HEX, "hex");
const TAP_TWEAK = bitcoin.crypto.taggedHash(
  "TapTweak",
  bitcoin.toXOnly(PUBLIC_KEY)
);
const TWEAKED_PRIVATE_KEY = Buffer.from(
  ecc.privateAdd(TEST_PRIVATE_KEY, TAP_TWEAK)!
);
const TWEAKED_PUBLIC_KEY = Buffer.from(
  ecc.pointFromScalar(TWEAKED_PRIVATE_KEY, true)!
);
const TEST_SIGNER = {
  publicKey: PUBLIC_KEY,
  sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, TEST_PRIVATE_KEY)),
};
const TEST_TAPROOT_SIGNER = {
  publicKey: TWEAKED_PUBLIC_KEY,
  sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, TWEAKED_PRIVATE_KEY)),
  signSchnorr: (hash: Uint8Array) =>
    Buffer.from(ecc.signSchnorr(hash, TWEAKED_PRIVATE_KEY)),
};
const NETWORK = bitcoin.networks.bitcoin;
const p2wpkh = bitcoin.payments.p2wpkh({
  pubkey: PUBLIC_KEY,
  network: NETWORK,
});
const outputScripts: Record<SpendType, Buffer> = {
  legacy: Buffer.from(
    bitcoin.payments.p2pkh({ pubkey: PUBLIC_KEY, network: NETWORK }).output!
  ),
  "nested-segwit": Buffer.from(
    bitcoin.payments.p2sh({ redeem: p2wpkh, network: NETWORK }).output!
  ),
  "native-segwit": Buffer.from(p2wpkh.output!),
  taproot: Buffer.from(
    bitcoin.payments.p2tr({
      internalPubkey: bitcoin.toXOnly(PUBLIC_KEY),
      network: NETWORK,
    }).output!
  ),
};
const p2wshScript = Buffer.concat([
  Buffer.from([0x00, 0x20]),
  Buffer.alloc(32, 0x42),
]);

function createPreviousOutput(
  script: Buffer,
  valueSats: number,
  marker: number
): PreviousOutputRef {
  const transaction = new bitcoin.Transaction();
  transaction.addInput(Buffer.alloc(32, marker), marker);
  transaction.addOutput(script, BigInt(valueSats));
  return { txid: transaction.getId(), vout: 0, rawTxHex: transaction.toHex() };
}

function buildFor(
  spendType: SpendType,
  recipientScript = outputScripts["native-segwit"],
  offsetSats = 0
) {
  const inscription = createPreviousOutput(
    outputScripts[spendType],
    Math.max(546, offsetSats + 1),
    7
  );
  const feeUtxo = createPreviousOutput(outputScripts[spendType], 100_000, 8);
  return buildOrdinalTransferPsbt({
    selectedInscription: {
      inscriptionId: `${inscription.txid}i0`,
      location: `${inscription.txid}:0:${offsetSats}`,
    },
    ownedInscriptions: [
      {
        inscriptionId: `${inscription.txid}i0`,
        location: `${inscription.txid}:0:${offsetSats}`,
      },
    ],
    inscriptionPreviousTxHex: inscription.rawTxHex,
    spendableFeeUtxos: [feeUtxo],
    publicKeyHex: PUBLIC_KEY_HEX,
    recipientScriptHex: recipientScript.toString("hex"),
    changeScriptHex: outputScripts[spendType].toString("hex"),
    feeRateSatVb: 2,
  });
}

describe("experimental Ordinal PSBT constructor", () => {
  it.each(Object.keys(outputScripts) as SpendType[])(
    "validates and finalizes a real %s signature without changing the plan",
    spendType => {
      const plan = buildFor(spendType);
      const psbt = bitcoin.Psbt.fromHex(plan.psbtHex, { network: NETWORK });
      psbt.signAllInputs(
        spendType === "taproot" ? TEST_TAPROOT_SIGNER : TEST_SIGNER
      );
      const rawTx = extractAndVerifySignedOrdinalTransaction(
        psbt.toHex(),
        plan
      );
      const transaction = bitcoin.Transaction.fromHex(rawTx);
      expect(transaction.ins).toHaveLength(plan.inputs.length);
      expect(transaction.outs).toHaveLength(plan.outputs.length);
      expect(transaction.version).toBe(plan.transactionVersion);
      expect(transaction.locktime).toBe(plan.lockTime);
      expect(
        transaction.ins.every(input => input.sequence === plan.inputSequence)
      ).toBe(true);
      expect(transaction.virtualSize()).toBeLessThanOrEqual(
        plan.estimatedVsize
      );
    }
  );

  it("refuses an invalid ECDSA signature instead of broadcasting it", () => {
    const plan = buildFor("native-segwit");
    const psbt = bitcoin.Psbt.fromHex(plan.psbtHex, { network: NETWORK });
    psbt.signAllInputs(TEST_SIGNER);
    const signature = psbt.data.inputs[0].partialSig![0].signature;
    signature[signature.length - 2] ^= 1;
    expect(() =>
      extractAndVerifySignedOrdinalTransaction(psbt.toHex(), plan)
    ).toThrow(/unsupported input signature|invalid signature/i);
  });

  it.each(Object.keys(outputScripts) as SpendType[])(
    "constructs a dust-safe transfer spending %s",
    spendType => {
      const plan = buildFor(spendType);
      const psbt = bitcoin.Psbt.fromHex(plan.psbtHex, { network: NETWORK });
      expect(plan.inputs[0].spendType).toBe(spendType);
      expect(plan.recipientOutputSats).toBe(MIN_SAFE_OUTPUT_SATS);
      expect(plan.changeOutputSats).toBeGreaterThanOrEqual(
        MIN_SAFE_OUTPUT_SATS
      );
      expect(plan.feeSats).toBeGreaterThan(0);
      expect(psbt.inputCount).toBe(2);
      expect(psbt.txOutputs[0].value).toBe(BigInt(MIN_SAFE_OUTPUT_SATS));
      expect(Buffer.from(psbt.txOutputs[0].script).toString("hex")).toBe(
        outputScripts["native-segwit"].toString("hex")
      );
      expect(psbt.txOutputs[1].value).toBe(BigInt(plan.changeOutputSats));

      const inputData = psbt.data.inputs[0];
      if (spendType === "legacy") expect(inputData.nonWitnessUtxo).toBeTruthy();
      if (spendType === "nested-segwit")
        expect(inputData.redeemScript).toBeTruthy();
      if (
        spendType === "native-segwit" ||
        spendType === "nested-segwit" ||
        spendType === "taproot"
      ) {
        expect(inputData.witnessUtxo).toBeTruthy();
      }
      if (spendType === "taproot")
        expect(inputData.tapInternalKey).toBeTruthy();
    }
  );

  it.each(Object.entries(outputScripts))(
    "accepts %s recipient scripts without changing the input path",
    (recipientType, script) => {
      const plan = buildFor("native-segwit", script);
      expect(plan.outputs[0].scriptHex).toBe(script.toString("hex"));
      expect(plan.inputs[0].spendType).toBe("native-segwit");
      expect(identifyStandardOutputScript(script.toString("hex"))).toBe(
        recipientType
      );
    }
  );

  it("accepts a native SegWit v0 script-hash recipient output", () => {
    const plan = buildFor("native-segwit", p2wshScript);
    expect(plan.outputs[0].scriptHex).toBe(p2wshScript.toString("hex"));
    expect(identifyStandardOutputScript(p2wshScript.toString("hex"))).toBe(
      "native-segwit-script-hash"
    );
  });

  it("raises the recipient output enough to carry the inscription sat at its offset", () => {
    const plan = buildFor("taproot", outputScripts.taproot, 1_800);
    expect(plan.inscriptionOffsetSats).toBe(1_800);
    expect(plan.recipientOutputSats).toBe(1_801);
  });

  it("refuses to transfer another inscription sharing the same source output", () => {
    const inscription = createPreviousOutput(
      outputScripts["native-segwit"],
      546,
      7
    );
    const feeUtxo = createPreviousOutput(
      outputScripts["native-segwit"],
      100_000,
      8
    );
    expect(() =>
      buildOrdinalTransferPsbt({
        selectedInscription: {
          inscriptionId: `${inscription.txid}i0`,
          location: `${inscription.txid}:0:0`,
        },
        ownedInscriptions: [
          {
            inscriptionId: `${inscription.txid}i0`,
            location: `${inscription.txid}:0:0`,
          },
          {
            inscriptionId: `${inscription.txid}i1`,
            location: `${inscription.txid}:0:20`,
          },
        ],
        inscriptionPreviousTxHex: inscription.rawTxHex,
        spendableFeeUtxos: [feeUtxo],
        publicKeyHex: PUBLIC_KEY_HEX,
        recipientScriptHex: outputScripts.taproot.toString("hex"),
        changeScriptHex: outputScripts["native-segwit"].toString("hex"),
        feeRateSatVb: 2,
      })
    ).toThrow(/multiple inscriptions/i);
  });

  it("ignores a fee candidate that is itself an inscribed outpoint", () => {
    const inscription = createPreviousOutput(
      outputScripts["native-segwit"],
      546,
      7
    );
    const onlyUtxo = createPreviousOutput(
      outputScripts["native-segwit"],
      100_000,
      8
    );
    expect(() =>
      buildOrdinalTransferPsbt({
        selectedInscription: {
          inscriptionId: `${inscription.txid}i0`,
          location: `${inscription.txid}:0:0`,
        },
        ownedInscriptions: [
          {
            inscriptionId: `${inscription.txid}i0`,
            location: `${inscription.txid}:0:0`,
          },
          {
            inscriptionId: `${onlyUtxo.txid}i2`,
            location: `${onlyUtxo.txid}:0:0`,
          },
        ],
        inscriptionPreviousTxHex: inscription.rawTxHex,
        spendableFeeUtxos: [onlyUtxo],
        publicKeyHex: PUBLIC_KEY_HEX,
        recipientScriptHex: outputScripts.taproot.toString("hex"),
        changeScriptHex: outputScripts["native-segwit"].toString("hex"),
        feeRateSatVb: 2,
      })
    ).toThrow(/insufficient compatible/i);
  });

  it("rejects a source output that cannot be derived from the active UniSat public key", () => {
    const wrongKey = Buffer.from(
      "02c6047f9441ed7d6d3045406e95c07cd85a5b2da7cb6e1b1db2d7f4a9412f5e6d",
      "hex"
    );
    const wrongScript = Buffer.from(
      bitcoin.payments.p2wpkh({ pubkey: wrongKey, network: NETWORK }).output!
    );
    const inscription = createPreviousOutput(wrongScript, 546, 7);
    const feeUtxo = createPreviousOutput(
      outputScripts["native-segwit"],
      100_000,
      8
    );
    expect(() =>
      buildOrdinalTransferPsbt({
        selectedInscription: {
          inscriptionId: `${inscription.txid}i0`,
          location: `${inscription.txid}:0:0`,
        },
        ownedInscriptions: [
          {
            inscriptionId: `${inscription.txid}i0`,
            location: `${inscription.txid}:0:0`,
          },
        ],
        inscriptionPreviousTxHex: inscription.rawTxHex,
        spendableFeeUtxos: [feeUtxo],
        publicKeyHex: PUBLIC_KEY_HEX,
        recipientScriptHex: outputScripts.taproot.toString("hex"),
        changeScriptHex: outputScripts["native-segwit"].toString("hex"),
        feeRateSatVb: 2,
      })
    ).toThrow(/not spendable by the active UniSat account/i);
  });

  it("refuses nonstandard recipient outputs", () => {
    expect(() => identifyStandardOutputScript("6a01ff")).toThrow(/standard/i);
  });
});
