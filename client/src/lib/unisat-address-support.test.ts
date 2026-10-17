import { describe, expect, it } from "vitest";
import { getUniSatAddressType, getUniSatMessageSignatureType, supportsUniSatMessageSigning } from "./unisat-address-support";

const fixtures = [
  ["Legacy P2PKH", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "legacy-p2pkh", "ecdsa"],
  ["Nested SegWit P2SH-P2WPKH", "3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN", "nested-segwit-p2sh-p2wpkh", "ecdsa"],
  ["Native SegWit P2WPKH", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "native-segwit-p2wpkh", "bip322-simple"],
  ["Taproot P2TR", "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9", "taproot-p2tr", "bip322-simple"],
] as const;

describe("UniSat mainnet address support", () => {
  it.each(fixtures)("recognizes %s and selects the compatible signing mode", (_name, address, expectedType, signatureType) => {
    expect(getUniSatAddressType(address)).toBe(expectedType);
    expect(getUniSatMessageSignatureType(address)).toBe(signatureType);
    expect(supportsUniSatMessageSigning(address)).toBe(true);
  });

  it("does not classify unknown or malformed formats as one of UniSat's four documented address types", () => {
    expect(getUniSatAddressType("not-a-bitcoin-address")).toBeNull();
    expect(getUniSatMessageSignatureType("not-a-bitcoin-address")).toBeNull();
    expect(supportsUniSatMessageSigning("not-a-bitcoin-address")).toBe(false);
  });
});
