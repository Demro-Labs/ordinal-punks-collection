import { describe, expect, it } from "vitest";
import {
  assertLocalVaultReviewIntegrity,
  assertLocalVaultReviewUnchanged,
  type LocalVaultReviewSnapshot,
} from "./local-vault-core";

const validReview = (): LocalVaultReviewSnapshot => ({
  psbtHex: "70736274ff",
  network: "BITCOIN_MAINNET",
  addressType: "native-segwit",
  sourceAddress: "bc1qexample",
  inputCount: 1,
  outputCount: 1,
  inputSats: 10_000,
  outputSats: 9_000,
  feeSats: 1_000,
  feeRateSatVb: 10,
  inputs: [{ txid: "a".repeat(64), vout: 0, valueSats: 10_000, scriptHex: "0014" }],
  outputs: [{ address: "bc1qrecipient", valueSats: 9_000, scriptHex: "0014" }],
});

describe("Local Vault shared review core", () => {
  it("accepts a consistent reviewed transaction", () => {
    expect(() => assertLocalVaultReviewIntegrity(validReview())).not.toThrow();
  });

  it("rejects duplicate outpoints instead of treating them as separate funds", () => {
    const review = validReview();
    review.inputs = [
      { txid: "a".repeat(64), vout: 0, valueSats: 5_000, scriptHex: "0014" },
      { txid: "a".repeat(64), vout: 0, valueSats: 5_000, scriptHex: "0014" },
    ];
    review.inputCount = 2;
    expect(() => assertLocalVaultReviewIntegrity(review)).toThrow(/dupliquée/i);
  });

  it("rejects inconsistent input, output and fee totals", () => {
    const review = validReview();
    review.feeSats = 999;
    expect(() => assertLocalVaultReviewIntegrity(review)).toThrow(/montants ou frais/i);
  });

  it("rejects a network change after the user approved the review", () => {
    const approved = validReview();
    const current = { ...validReview(), network: "FRACTAL_BITCOIN_MAINNET" };
    expect(() => assertLocalVaultReviewUnchanged(current, approved)).toThrow(/ont changé depuis l’examen/i);
  });

  it("rejects any output mutation after review", () => {
    const approved = validReview();
    const current = validReview();
    current.outputs = [{ ...current.outputs[0], address: "bc1qattacker" }];
    expect(() => assertLocalVaultReviewUnchanged(current, approved)).toThrow(/ont changé depuis l’examen/i);
  });
});
