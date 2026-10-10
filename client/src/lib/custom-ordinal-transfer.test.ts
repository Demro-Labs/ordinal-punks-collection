import { describe, expect, it } from "vitest";
import { assertProtocolAssetScanPassed } from "./custom-ordinal-transfer";

describe("custom Ordinal transfer asset-scan attestation", () => {
  it("accepts only an explicit server-side protocol-asset verification marker", () => {
    expect(() =>
      assertProtocolAssetScanPassed({ protocolAssetsChecked: true })
    ).not.toThrow();
  });

  it.each([
    undefined,
    null,
    {},
    { protocolAssetsChecked: false },
    { protocolAssetsChecked: "true" },
  ])("fails closed when the asset scan is missing or unverified", value => {
    expect(() => assertProtocolAssetScanPassed(value)).toThrow(
      /did not verify inscriptions, Runes, and Alkanes/i
    );
  });
});
