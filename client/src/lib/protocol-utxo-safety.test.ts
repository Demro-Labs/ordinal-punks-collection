import { describe, expect, it } from "vitest";
import { assertExactAlkaneUtxos, assertProtocolSafeFeeUtxos, type ProtocolUtxo } from "./protocol-utxo-safety";

const ADDRESS = "bc1qexampleaddress";
const utxo = (overrides: Partial<ProtocolUtxo> = {}): ProtocolUtxo => ({
  txid: "a".repeat(64), vout: 0, valueSats: 10_000, confirmations: 2,
  address: ADDRESS, scriptHex: "0014" + "11".repeat(20),
  inscriptions: [], runes: [], alkanes: [], ...overrides,
});

describe("Local Vault protocol UTXO preflight", () => {
  it("accepts only a complete snapshot of confirmed asset-free fee UTXOs", () => {
    expect(assertProtocolSafeFeeUtxos([utxo()], { complete: true, address: ADDRESS })).toHaveLength(1);
  });
  it("fails closed on an incomplete index", () => {
    expect(() => assertProtocolSafeFeeUtxos([utxo()], { complete: false, address: ADDRESS })).toThrow(/incomplete/i);
  });
  it.each([
    { inscriptions: ["asset"] },
    { runes: [{ id: "840000:1", amount: "1" }] },
    { alkanes: [{ id: "2:1", amount: "1" }] },
    { confirmations: 0 },
    { address: "bc1qotheraddress" },
    { valueSats: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unsafe fee UTXO metadata: %o", override => {
    expect(() => assertProtocolSafeFeeUtxos([utxo(override)], { complete: true, address: ADDRESS })).toThrow();
  });
  it("rejects duplicate outpoints", () => {
    expect(() => assertProtocolSafeFeeUtxos([utxo(), utxo()], { complete: true, address: ADDRESS })).toThrow(/duplicate/i);
  });
  it("matches the exact Alkane id and indexed base-unit total", () => {
    const inputs = [
      utxo({ alkanes: [{ id: "2:7", amount: "40" }] }),
      utxo({ txid: "b".repeat(64), vout: 1, alkanes: [{ id: "2:7", amount: "60" }] }),
    ];
    expect(assertExactAlkaneUtxos(inputs, { complete: true, address: ADDRESS, alkaneId: "2:7", expectedAmount: "100" })).toHaveLength(2);
  });
  it.each([
    { expectedAmount: "99" },
    { alkaneId: "2:8" },
  ])("rejects an Alkane balance or ID mismatch: %o", override => {
    expect(() => assertExactAlkaneUtxos([utxo({ alkanes: [{ id: "2:7", amount: "100" }] })], {
      complete: true, address: ADDRESS, alkaneId: "2:7", expectedAmount: "100", ...override,
    })).toThrow();
  });
  it("rejects Alkane UTXOs carrying an inscription, Rune, or second Alkane", () => {
    for (const overrides of [
      { inscriptions: ["ordinal"] },
      { runes: [{ id: "840000:1", amount: "1" }] },
      { alkanes: [{ id: "2:7", amount: "100" }, { id: "2:8", amount: "1" }] },
    ]) {
      expect(() => assertExactAlkaneUtxos([utxo(overrides)], {
        complete: true, address: ADDRESS, alkaneId: "2:7", expectedAmount: "100",
      })).toThrow();
    }
  });
});
