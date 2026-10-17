import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSpendableUtxos: vi.fn() }));
vi.mock("@/lib/mempool", () => ({ getSpendableUtxos: mocks.getSpendableUtxos }));
import {
  canUseMobileNativePaymentFallback,
  ensureNativeInscriptionFeeBalance,
  ensureNativePaymentBalance,
  getMobileUtxoErrorGuidance,
  sendNativeUniSatBitcoinPayment,
  sendNativeUniSatInscription,
  sendNativeUniSatRunes,
} from "./native-unisat-actions";

const TXID = "a".repeat(64);
const INSCRIPTION_ID = `${"b".repeat(64)}i0`;
const INSCRIPTION_LOCATION = `${"c".repeat(64)}:0:0`;

describe("native UniSat wallet actions", () => {
  it("uses UniSat native sendInscription and returns its transaction ID", async () => {
    const sendInscription = vi.fn().mockResolvedValue({ txid: TXID });
    await expect(sendNativeUniSatInscription({ sendInscription }, "bc1qrecipient", INSCRIPTION_ID, 3))
      .resolves.toBe(TXID);
    expect(sendInscription).toHaveBeenCalledWith("bc1qrecipient", INSCRIPTION_ID, { feeRate: 3 });
  });

  it("uses UniSat native sendRunes with the documented positional request", async () => {
    const sendRunes = vi.fn().mockResolvedValue({ txid: TXID });
    await expect(
      sendNativeUniSatRunes({ sendRunes }, "bc1qrecipient", "abc:1", "1.25", 4)
    ).resolves.toBe(TXID);
    expect(sendRunes).toHaveBeenCalledWith("bc1qrecipient", "abc:1", "1.25", {
      feeRate: 4,
    });
  });

  it("accepts UniSat's string transaction-ID response", async () => {
    const sendInscription = vi.fn().mockResolvedValue(TXID.toUpperCase());
    await expect(sendNativeUniSatInscription({ sendInscription }, "bc1qrecipient", INSCRIPTION_ID, 2))
      .resolves.toBe(TXID);
  });

  it("uses UniSat native sendBitcoin for an Inscribe V5 payment", async () => {
    const sendBitcoin = vi.fn().mockResolvedValue({ txid: TXID });
    await expect(sendNativeUniSatBitcoinPayment({ sendBitcoin }, "bc1qpayment", 12_345, 4))
      .resolves.toBe(TXID);
    expect(sendBitcoin).toHaveBeenCalledWith("bc1qpayment", 12_345, { feeRate: 4 });
  });

  it("uses the desktop positional sendBitcoin request", async () => {
    const sendBitcoin = vi.fn().mockResolvedValue({ txid: TXID });
    await expect(sendNativeUniSatBitcoinPayment({ sendBitcoin }, "fb1qpayment", 12_345, 4))
      .resolves.toBe(TXID);
    expect(sendBitcoin).toHaveBeenCalledWith("fb1qpayment", 12_345, { feeRate: 4 });
  });

  it("uses UniSat Mobile's native object sendBitcoin request", async () => {
    const sendBitcoin = vi.fn().mockResolvedValue({ txid: TXID });
    vi.stubGlobal("navigator", { userAgent: "UniSat Mobile", platform: "Android", maxTouchPoints: 5 });
    await expect(sendNativeUniSatBitcoinPayment({ sendBitcoin }, "fb1qpayment", 12_345, 4)).resolves.toBe(TXID);
    expect(sendBitcoin).toHaveBeenCalledWith({ toAddress: "fb1qpayment", satoshis: 12_345, feeRate: 4 });
    vi.unstubAllGlobals();
  });

  it("allows sendBitcoin only after an unpaid mobile plan has Worker-confirmed sufficient UTXOs", async () => {
    const eligible = { isMobileUniSat: true, hasReceipt: true, hasPaymentPlan: true, hasWorkerAttestation: true, hasPaymentTxid: false };
    expect(canUseMobileNativePaymentFallback(eligible)).toBe(true);
    expect(canUseMobileNativePaymentFallback({ ...eligible, isMobileUniSat: false })).toBe(false);
    expect(canUseMobileNativePaymentFallback({ ...eligible, hasWorkerAttestation: false })).toBe(false);
    expect(canUseMobileNativePaymentFallback({ ...eligible, hasPaymentPlan: false })).toBe(false);
    expect(canUseMobileNativePaymentFallback({ ...eligible, hasPaymentTxid: true })).toBe(false);

    const sendBitcoin = vi.fn().mockResolvedValue({ txid: TXID });
    await expect(sendNativeUniSatBitcoinPayment({ sendBitcoin }, "bc1qpayment", 12_345, 4)).resolves.toBe(TXID);
    expect(sendBitcoin).toHaveBeenCalledTimes(1);
    expect(sendBitcoin).toHaveBeenCalledWith("bc1qpayment", 12_345, { feeRate: 4 });
  });

  beforeEach(() => mocks.getSpendableUtxos.mockReset());
  it.each([
    ["desktop", false],
    ["mobile", true],
  ] as const)("preflights confirmed safe payment UTXOs for %s", async (_platform, mobile) => {
    mocks.getSpendableUtxos.mockResolvedValue([{ address: "bc1qwallet", txid: "e".repeat(64), vout: 0, satoshi: 5_000 }]);
    await expect(ensureNativePaymentBalance(
      "FRACTAL_BITCOIN_MAINNET", "bc1qwallet", 1_000, 2, "fb-transfer", { mobile },
    )).resolves.toBeUndefined();
    expect(mocks.getSpendableUtxos).toHaveBeenCalledWith("FRACTAL_BITCOIN_MAINNET", "bc1qwallet", 2_100, { mobile });
  });

  it("accepts a Worker-verified, confirmed, uninscribed fee UTXO large enough for the transfer", async () => {
    mocks.getSpendableUtxos.mockResolvedValue([{ address: "bc1qwallet", txid: "d".repeat(64), vout: 1, satoshi: 2_000 }]);
    await expect(ensureNativeInscriptionFeeBalance(
      "BITCOIN_MAINNET", "bc1qwallet", { location: INSCRIPTION_LOCATION }, 3,
    )).resolves.toBeUndefined();
    expect(mocks.getSpendableUtxos).toHaveBeenCalledWith("BITCOIN_MAINNET", "bc1qwallet", 1_650, { mobile: true });
  });
  it("rejects the Ordinal outpoint itself even if the safe service erroneously returns it", async () => {
    mocks.getSpendableUtxos.mockResolvedValue([{ address: "bc1qwallet", txid: "c".repeat(64), vout: 0, satoshi: 20_000 }]);
    await expect(ensureNativeInscriptionFeeBalance(
      "BITCOIN_MAINNET", "bc1qwallet", { location: INSCRIPTION_LOCATION }, 3,
    )).rejects.toThrow(/The Ordinal must remain outside fee funds.*No transaction was signed or broadcast/);
  });
  it("blocks before wallet approval if no single confirmed, uninscribed fee UTXO is sufficient", async () => {
    mocks.getSpendableUtxos.mockResolvedValue([{ address: "bc1qwallet", txid: "d".repeat(64), vout: 1, satoshi: 1_000 }]);
    await expect(ensureNativeInscriptionFeeBalance(
      "BITCOIN_MAINNET", "bc1qwallet", { location: INSCRIPTION_LOCATION }, 3,
    )).rejects.toThrow(/Add at least 650 more BTC sats.*confirmed.*no inscription.*No transaction was signed or broadcast/);
  });
  it("fails closed with explicit funding guidance when no safe UTXOs are returned", async () => {
    mocks.getSpendableUtxos.mockResolvedValue([]);
    await expect(ensureNativeInscriptionFeeBalance(
      "FRACTAL_BITCOIN_MAINNET", "bc1qwallet", { location: INSCRIPTION_LOCATION }, 3,
    )).rejects.toThrow(/Fractal Bitcoin.*confirmed.*no inscription.*No transaction was signed or broadcast/);
  });
  it.each([
    ["missing native inscription method", () => sendNativeUniSatInscription({}, "bc1qrecipient", INSCRIPTION_ID, 2)],
    ["malformed inscription ID", () => sendNativeUniSatInscription({ sendInscription: vi.fn() }, "bc1qrecipient", "bad", 2)],
    ["invalid fee rate", () => sendNativeUniSatInscription({ sendInscription: vi.fn() }, "bc1qrecipient", INSCRIPTION_ID, 0)],
    ["missing native payment method", () => sendNativeUniSatBitcoinPayment({}, "bc1qpayment", 1000, 2)],
    ["invalid payment amount", () => sendNativeUniSatBitcoinPayment({ sendBitcoin: vi.fn() }, "bc1qpayment", 0, 2)],
  ])("fails closed for %s", async (_label, action) => {
    await expect(action()).rejects.toThrow();
  });

  it("treats a missing transaction ID after the wallet action as uncertain", async () => {
    const sendBitcoin = vi.fn().mockResolvedValue({});
    await expect(sendNativeUniSatBitcoinPayment({ sendBitcoin }, "bc1qpayment", 1000, 2))
      .rejects.toThrow(/Check UniSat activity and Mempool before retrying/);
  });

  it("explains a proven pre-broadcast ordinal UTXO failure without claiming a transaction was sent", () => {
    const guidance = getMobileUtxoErrorGuidance(
      new Error("Insufficient compatible non-inscription UTXOs to fund the safe inscription output, network fee, and non-dust change. No transaction was signed or broadcast."),
      "ordinal-transfer",
    );
    expect(guidance?.definitelyNotBroadcast).toBe(true);
    expect(guidance?.message).toContain("Insufficient safe fee UTXOs");
    expect(guidance?.message).toContain("No transaction was signed or broadcast");
  });

  it("preserves the exact mobile fee amount, network and destination address", () => {
    const detail = "Insufficient safe fee UTXO for this Ordinal transfer on Bitcoin. Add 650 more BTC sats to bc1qwallet. No transaction was signed or broadcast.";
    const guidance = getMobileUtxoErrorGuidance(new Error(detail), "ordinal-transfer");
    expect(guidance?.definitelyNotBroadcast).toBe(true);
    expect(guidance?.message).toBe(detail);
  });
  it("gives Inscribe payment guidance but preserves uncertainty for a generic wallet balance refusal", () => {
    const guidance = getMobileUtxoErrorGuidance({ message: "Insufficient balance for transaction" }, "inscribe-payment");
    expect(guidance?.definitelyNotBroadcast).toBe(false);
    expect(guidance?.message).toContain("Keep the existing receipt");
    expect(guidance?.message).toContain("check UniSat and Mempool before retrying");
  });

  it("ignores cancellation and unrelated errors", () => {
    expect(getMobileUtxoErrorGuidance(new Error("User rejected the request"), "fb-transfer")).toBeNull();
    expect(getMobileUtxoErrorGuidance(new Error("Network unavailable"), "fb-transfer")).toBeNull();
  });
});
