import { describe, expect, it } from "vitest";
import { getMempoolConfig } from "./mempool";
import {
  getLegacyFractalOutcomeUnclearStorageKey,
  getNativeFbOutcomeUnclearStorageKey,
  getNativeFbReceiptStorageKey,
  parseNativeFbReceipt,
  readNativeFbOutcomeUnclear,
  type NativeFbReceipt,
  type NativeNetwork,
} from "./native-fb-receipt";

const ADDRESS = "bc1qexampleaddress";
const TXID = "a".repeat(64);

function receipt(networkEnum: NativeNetwork): NativeFbReceipt {
  const config = getMempoolConfig(networkEnum)!;
  return {
    txid: TXID,
    networkEnum,
    network: config.label,
    sender: ADDRESS,
    recipient: "bc1qrecipient",
    amountSats: 10_000,
    feeRate: 3,
    feeSource: "Mempool + UniSat",
    createdAt: "2026-10-16T00:00:00.000Z",
    mempool: {
      txid: TXID,
      network: config.label,
      status: "checking",
      message: "Searching for the transaction in Mempool…",
      blockHeight: null,
      explorerUrl: `${config.explorer}${TXID}`,
      checkedAt: "2026-10-16T00:00:00.000Z",
    },
  };
}

describe("native send receipt network isolation", () => {
  it("uses distinct storage and uncertain-outcome keys for Bitcoin and Fractal", () => {
    expect(getNativeFbReceiptStorageKey(ADDRESS, "BITCOIN_MAINNET"))
      .not.toBe(getNativeFbReceiptStorageKey(ADDRESS, "FRACTAL_BITCOIN_MAINNET"));
    expect(getNativeFbOutcomeUnclearStorageKey(ADDRESS, "BITCOIN_MAINNET"))
      .not.toBe(getNativeFbOutcomeUnclearStorageKey(ADDRESS, "FRACTAL_BITCOIN_MAINNET"));
  });

  it("accepts a receipt only for the network and Mempool explorer it names", () => {
    const bitcoin = receipt("BITCOIN_MAINNET");
    const fractal = receipt("FRACTAL_BITCOIN_MAINNET");
    expect(parseNativeFbReceipt(JSON.stringify(bitcoin), ADDRESS, "BITCOIN_MAINNET")?.network)
      .toBe("Bitcoin");
    expect(parseNativeFbReceipt(JSON.stringify(fractal), ADDRESS, "BITCOIN_MAINNET")).toBeNull();
    expect(parseNativeFbReceipt(JSON.stringify(bitcoin), ADDRESS, "FRACTAL_BITCOIN_MAINNET")).toBeNull();
  });

  it("migrates legacy receipts only into Fractal and never into Bitcoin", () => {
    const legacy = receipt("FRACTAL_BITCOIN_MAINNET");
    const { networkEnum: _networkEnum, ...legacyShape } = legacy;
    const raw = JSON.stringify(legacyShape);
    expect(parseNativeFbReceipt(raw, ADDRESS, "FRACTAL_BITCOIN_MAINNET", true)?.networkEnum)
      .toBe("FRACTAL_BITCOIN_MAINNET");
    expect(parseNativeFbReceipt(raw, ADDRESS, "BITCOIN_MAINNET", true)).toBeNull();
  });

  it("migrates a legacy uncertain-send lock only to Fractal", () => {
    const values = new Map<string, string>([[getLegacyFractalOutcomeUnclearStorageKey(ADDRESS), "1"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    expect(readNativeFbOutcomeUnclear(ADDRESS, "BITCOIN_MAINNET", storage)).toBe(false);
    expect(values.has(getLegacyFractalOutcomeUnclearStorageKey(ADDRESS))).toBe(true);
    expect(readNativeFbOutcomeUnclear(ADDRESS, "FRACTAL_BITCOIN_MAINNET", storage)).toBe(true);
    expect(values.get(getNativeFbOutcomeUnclearStorageKey(ADDRESS, "FRACTAL_BITCOIN_MAINNET"))).toBe("1");
    expect(values.has(getLegacyFractalOutcomeUnclearStorageKey(ADDRESS))).toBe(false);
  });
});
