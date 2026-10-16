import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { describe, expect, it } from "vitest";
import { BRC20_PROG_ACTIVATION_SCRIPT_HEX, buildBrc20ProgActivationPsbt, extractVerifiedBrc20ProgActivation } from "./brc20-prog-activation";

bitcoin.initEccLib(ecc);
const privateKey = Buffer.concat([Buffer.alloc(31), Buffer.from([1])]);
const publicKey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
const payment = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: bitcoin.networks.bitcoin });
const address = payment.address!;
const scriptHex = Buffer.from(payment.output!).toString("hex");
const inscriptionId = `${"a".repeat(64)}i0`;
function previousOutput(script: Buffer, value: number, seed: number) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, seed), 0);
  tx.addOutput(script, BigInt(value));
  return { txid: tx.getId(), vout: 0, valueSats: value, scriptHex: script.toString("hex"), rawTxHex: tx.toHex() };
}
function fixture() {
  const inscription = previousOutput(Buffer.from(scriptHex, "hex"), 546, 11);
  const fee = previousOutput(Buffer.from(scriptHex, "hex"), 10_000, 12);
  const location = `${inscription.txid}:0:0`;
  const plan = buildBrc20ProgActivationPsbt({
    walletAddress: address,
    publicKeyHex: publicKey.toString("hex"),
    inscriptionId,
    inscriptionLocation: location,
    ownedInscriptions: [{ inscriptionId, location }],
    inscriptionOutput: inscription,
    spendableFeeUtxos: [fee],
    feeRateSatVb: 2,
  });
  return { inscription, fee, location, plan };
}

describe("BRC2.0 mainnet activation PSBT", () => {
  it("creates a zero-value OP_RETURN BRC20PROG output and returns non-dust change", () => {
    const { plan, fee, inscription } = fixture();
    const psbt = bitcoin.Psbt.fromHex(plan.psbtHex, { network: bitcoin.networks.bitcoin });
    const outputs = psbt.txOutputs;
    expect(BRC20_PROG_ACTIVATION_SCRIPT_HEX).toBe("6a09425243323050524f47");
    expect(outputs).toHaveLength(2);
    expect(Buffer.from(outputs[0].script).toString("hex")).toBe(BRC20_PROG_ACTIVATION_SCRIPT_HEX);
    expect(Number(outputs[0].value)).toBe(0);
    expect(Buffer.from(outputs[1].script).toString("hex")).toBe(scriptHex);
    expect(Number(outputs[1].value)).toBeGreaterThanOrEqual(600);
    expect(plan.inputs.map(input => `${input.txid}:${input.vout}`)).toEqual([
      `${inscription.txid}:0`, `${fee.txid}:0`,
    ]);
    expect(plan.totalInputSats - plan.changeSats).toBe(plan.feeSats);
    expect(plan.feeSats).toBe(plan.estimatedVsize * plan.feeRateSatVb);
  });

  it("rejects a PSBT that changes the planned outputs", () => {
    const { plan } = fixture();
    const altered = bitcoin.Psbt.fromHex(plan.psbtHex, { network: bitcoin.networks.bitcoin });
    altered.addOutput({ script: Buffer.from(scriptHex, "hex"), value: BigInt(600) });
    expect(() => extractVerifiedBrc20ProgActivation(altered.toHex(), plan)).toThrow(/modifié les entrées ou sorties/);
  });

  it("refuses to consume an output that contains another inscription", () => {
    const { inscription, fee, location } = fixture();
    expect(() => buildBrc20ProgActivationPsbt({
      walletAddress: address,
      publicKeyHex: publicKey.toString("hex"),
      inscriptionId,
      inscriptionLocation: location,
      ownedInscriptions: [
        { inscriptionId, location },
        { inscriptionId: `${"b".repeat(64)}i1`, location },
      ],
      inscriptionOutput: inscription,
      spendableFeeUtxos: [fee],
      feeRateSatVb: 2,
    })).toThrow(/Plusieurs inscriptions partagent cet UTXO/);
  });

  it("refuses a fee UTXO with a value or script that does not match its previous transaction", () => {
    const { inscription, fee, location } = fixture();
    expect(() => buildBrc20ProgActivationPsbt({
      walletAddress: address,
      publicKeyHex: publicKey.toString("hex"),
      inscriptionId,
      inscriptionLocation: location,
      ownedInscriptions: [{ inscriptionId, location }],
      inscriptionOutput: inscription,
      spendableFeeUtxos: [{ ...fee, valueSats: fee.valueSats + 1 }],
      feeRateSatVb: 2,
    })).toThrow(/valeur ou le script de l’UTXO/);
  });

  it("refuses an inscription location whose outpoint differs from its verified output", () => {
    const { inscription, fee } = fixture();
    expect(() => buildBrc20ProgActivationPsbt({
      walletAddress: address,
      publicKeyHex: publicKey.toString("hex"),
      inscriptionId,
      inscriptionLocation: `${"c".repeat(64)}:0:0`,
      ownedInscriptions: [{ inscriptionId, location: `${"c".repeat(64)}:0:0` }],
      inscriptionOutput: inscription,
      spendableFeeUtxos: [fee],
      feeRateSatVb: 2,
    })).toThrow(/outpoint ou l’offset/);
  });
});
