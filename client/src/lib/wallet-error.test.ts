import { describe, expect, it } from "vitest";
import { shouldShowDustRelayGuidance } from "./wallet-error";

describe("shouldShowDustRelayGuidance", () => {
  it("does not misclassify a pre-signature non-dust change guard", () => {
    expect(
      shouldShowDustRelayGuidance(
        "Insufficient compatible non-inscription UTXOs to fund the safe inscription output, network fee, and non-dust change. No transaction was signed or broadcast."
      )
    ).toBe(false);
  });

  it("keeps relay guidance for an explicit dust output rejection", () => {
    expect(
      shouldShowDustRelayGuidance(
        "The transaction contains a dust output and was rejected by relay policy."
      )
    ).toBe(true);
  });

  it("keeps guidance for explicit 0-fee errors", () => {
    expect(shouldShowDustRelayGuidance("0-fee transaction rejected")).toBe(true);
  });
});
