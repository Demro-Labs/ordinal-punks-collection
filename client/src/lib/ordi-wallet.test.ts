import { describe, expect, it } from "vitest";
import { createMnemonic, deriveOrdiWallet } from "./ordi-wallet";

describe("Ordi Wallet derivation", () => {
  it("generates valid 12- and 24-word BIP39 phrases", () => {
    expect(createMnemonic(12).split(" ")).toHaveLength(12);
    expect(createMnemonic(24).split(" ")).toHaveLength(24);
  });

  it("derives the four UniSat-compatible address families", () => {
    const wallet = deriveOrdiWallet("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    expect(Object.keys(wallet.addresses)).toEqual(["legacy", "nested-segwit", "native-segwit", "taproot"]);
    expect(wallet.addresses.legacy.address).toMatch(/^1/);
    expect(wallet.addresses["nested-segwit"].address).toMatch(/^3/);
    expect(wallet.addresses["native-segwit"].address).toMatch(/^bc1q/);
    expect(wallet.addresses.taproot.address).toMatch(/^bc1p/);
    expect(new Set(Object.values(wallet.addresses).map(item => item.address)).size).toBe(4);
    expect(Object.values(wallet.addresses).every(item => /^[0-9a-f]{64}$/.test(item.privateKey))).toBe(true);
  });

  it("changes every derived address when the BIP39 passphrase changes", () => {
    const plain = deriveOrdiWallet("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const protectedWallet = deriveOrdiWallet("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "Ordi Wallet");
    expect(protectedWallet.addresses.taproot.address).not.toBe(plain.addresses.taproot.address);
  });
});
