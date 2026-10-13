import { describe, expect, it, vi } from "vitest";
import { sendNativeUniSatBitcoinPayment, sendNativeUniSatInscription } from "./native-unisat-actions";

const TXID = "a".repeat(64);
const INSCRIPTION_ID = `${"b".repeat(64)}i0`;

describe("native UniSat wallet actions", () => {
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
