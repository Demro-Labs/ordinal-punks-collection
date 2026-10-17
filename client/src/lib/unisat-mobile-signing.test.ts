import { describe, expect, it, vi } from "vitest";
import { signMobileUniSatMessage, UniSatSignTimeoutError } from "@/lib/unisat-mobile-signing";

describe("signMobileUniSatMessage", () => {
  it("calls UniSat synchronously with the explicit BIP-322 type", async () => {
    const provider = { signMessage: vi.fn().mockResolvedValue("signature") };
    const result = signMobileUniSatMessage(provider, "challenge", "bip322-simple", 1000);
    expect(provider.signMessage).toHaveBeenCalledOnce();
    expect(provider.signMessage).toHaveBeenCalledWith("challenge", "bip322-simple");
    await expect(result).resolves.toBe("signature");
  });

  it("calls UniSat synchronously with ECDSA for Legacy and Nested signatures", async () => {
    const provider = { signMessage: vi.fn().mockResolvedValue("signature") };
    const result = signMobileUniSatMessage(provider, "challenge", "ecdsa", 1000);
    expect(provider.signMessage).toHaveBeenCalledOnce();
    expect(provider.signMessage).toHaveBeenCalledWith("challenge", "ecdsa");
    await expect(result).resolves.toBe("signature");
  });

  it("rejects after the timeout when UniSat never answers", async () => {
    const provider = { signMessage: vi.fn(() => new Promise<string>(() => undefined)) };
    await expect(signMobileUniSatMessage(provider, "challenge", "bip322-simple", 5)).rejects.toBeInstanceOf(UniSatSignTimeoutError);
  });

  it("preserves a wallet rejection", async () => {
    const provider = { signMessage: vi.fn().mockRejectedValue(new Error("User rejected")) };
    await expect(signMobileUniSatMessage(provider, "challenge", "bip322-simple", 1000)).rejects.toThrow("User rejected");
  });
});
