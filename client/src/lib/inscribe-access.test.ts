import { describe, expect, it } from "vitest";
import { canAccessInscribeReceiptForWallet } from "./inscribe-access";

const receipt = { walletAddress: "bc1qexample", chain: "BITCOIN_MAINNET" };

describe("canAccessInscribeReceiptForWallet", () => {
  it("allows the same eligible wallet and network, ignoring address case", () => {
    expect(canAccessInscribeReceiptForWallet(receipt, "BC1QEXAMPLE", "BITCOIN_MAINNET")).toBe(true);
  });

  it("rejects another wallet, another network, or an unsupported network", () => {
    expect(canAccessInscribeReceiptForWallet(receipt, "bc1qother", "BITCOIN_MAINNET")).toBe(false);
    expect(canAccessInscribeReceiptForWallet(receipt, "bc1qexample", "FRACTAL_BITCOIN_MAINNET")).toBe(false);
    expect(canAccessInscribeReceiptForWallet(receipt, "bc1qexample", "TESTNET")).toBe(false);
  });

  it("rejects an absent connected wallet or network", () => {
    expect(canAccessInscribeReceiptForWallet(receipt, "", "BITCOIN_MAINNET")).toBe(false);
    expect(canAccessInscribeReceiptForWallet(receipt, "bc1qexample", null)).toBe(false);
  });
});
