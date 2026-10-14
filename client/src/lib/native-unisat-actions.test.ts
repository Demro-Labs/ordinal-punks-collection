import { describe, expect, it, vi } from "vitest";
import { canUseMobileNativePaymentFallback, ensureNativeInscriptionFeeBalance, requiresVerifiedPsbtForMobileFractalTransfer, sendNativeUniSatBitcoinPayment, sendNativeUniSatInscription } from "./native-unisat-actions";

const TXID = "a".repeat(64);
const INSCRIPTION_ID = `${"b".repeat(64)}i0`;
const INSCRIPTION_LOCATION = `${"c".repeat(64)}:0:0`;

describe("native UniSat wallet actions", () => {
  it("requires a verified PSBT only for UniSat Mobile on Fractal mainnet", () => {
    expect(requiresVerifiedPsbtForMobileFractalTransfer(true, "FRACTAL_BITCOIN_MAINNET")).toBe(true);
    expect(requiresVerifiedPsbtForMobileFractalTransfer(false, "FRACTAL_BITCOIN_MAINNET")).toBe(false);
    expect(requiresVerifiedPsbtForMobileFractalTransfer(true, "BITCOIN_MAINNET")).toBe(false);
    expect(requiresVerifiedPsbtForMobileFractalTransfer(true, undefined)).toBe(false);
  });

  it("uses UniSat native sendInscription and returns its transaction ID", async () => {
    const sendInscription = vi.fn().mockResolvedValue({ txid: TXID });
    await expect(sendNativeUniSatInscription({ sendInscription }, "bc1qrecipient", INSCRIPTION_ID, 3))
      .resolves.toBe(TXID);
    expect(sendInscription).toHaveBeenCalledWith("bc1qrecipient", INSCRIPTION_ID, { feeRate: 3 });
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

  it("accepts sufficient fee balance only with a separate spendable UTXO", async () => {
    const getBalanceV2 = vi.fn().mockResolvedValue({ available: 10_000 });
    const getBitcoinUtxos = vi.fn().mockResolvedValue([{ txid: "d".repeat(64), vout: 1 }]);
    await expect(ensureNativeInscriptionFeeBalance(
      { getBalanceV2, getBitcoinUtxos }, "FRACTAL_BITCOIN_MAINNET", { location: INSCRIPTION_LOCATION }, 3,
    )).resolves.toBeUndefined();
  });

  it("rejects when only the inscription outpoint is available for fees", async () => {
    const getBitcoinUtxos = vi.fn().mockResolvedValue([{ txid: "c".repeat(64), vout: 0 }]);
    await expect(ensureNativeInscriptionFeeBalance(
      { getBitcoinUtxos }, "FRACTAL_BITCOIN_MAINNET", { location: INSCRIPTION_LOCATION }, 3,
    )).rejects.toThrow(/No separate spendable FB fee UTXO/);
  });

  it("rejects a low mobile fee balance before UniSat transfer can be invoked", async () => {
    const getBalanceV2 = vi.fn().mockResolvedValue({ available: 500 });
    const getBitcoinUtxos = vi.fn();
    await expect(ensureNativeInscriptionFeeBalance(
      { getBalanceV2, getBitcoinUtxos }, "BITCOIN_MAINNET", { location: INSCRIPTION_LOCATION }, 3,
    )).rejects.toThrow(/Insufficient spendable BTC/);
    expect(getBitcoinUtxos).not.toHaveBeenCalled();
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
});
