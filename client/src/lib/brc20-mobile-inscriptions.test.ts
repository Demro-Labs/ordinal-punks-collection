import { describe, expect, it, vi } from "vitest";
import { loadOwnedInscriptionsForMobileTransfer } from "./brc20-mobile-inscriptions";

const inscriptionId = (char: string, index = 0) => `${char.repeat(64)}i${index}`;
const record = (char: string, index = 0) => ({
  inscriptionId: inscriptionId(char, index),
  location: `${char.repeat(64)}:${index}:0`,
});

describe("loadOwnedInscriptionsForMobileTransfer", () => {
  it("paginates through the full wallet and returns all located inscriptions with normalized IDs", async () => {
    const target = record("b", 7);
    const getInscriptions = vi.fn(async (cursor: number) => cursor === 0
      ? { total: 101, list: Array.from({ length: 100 }, (_, index) => record("a", index)) }
      : { total: 101, list: [{ ...target, inscriptionId: target.inscriptionId.toUpperCase() }] });

    const result = await loadOwnedInscriptionsForMobileTransfer({ getInscriptions }, target.inscriptionId);

    expect(getInscriptions).toHaveBeenNthCalledWith(1, 0, 100);
    expect(getInscriptions).toHaveBeenNthCalledWith(2, 100, 100);
    expect(result).toHaveLength(101);
    expect(result.at(-1)).toEqual(target);
  });

  it("fails closed if the new transfer inscription has not appeared in the wallet index", async () => {
    const getInscriptions = vi.fn().mockResolvedValue({ total: 1, list: [record("a")] });
    await expect(loadOwnedInscriptionsForMobileTransfer({ getInscriptions }, inscriptionId("b")))
      .rejects.toThrow(/not yet indexed.*Verify the order/);
  });

  it("does not accept an invalid inscription id or location as a wallet asset", async () => {
    const getInscriptions = vi.fn().mockResolvedValue({
      total: 2,
      list: [
        { inscriptionId: "invalid", location: `${"c".repeat(64)}:0:0` },
        { inscriptionId: inscriptionId("d"), location: "invalid" },
      ],
    });
    await expect(loadOwnedInscriptionsForMobileTransfer({ getInscriptions }, inscriptionId("d")))
      .rejects.toThrow(/not yet indexed/);
  });

  it("requires UniSat Mobile to expose its inscription index method", async () => {
    await expect(loadOwnedInscriptionsForMobileTransfer({}, inscriptionId("e")))
      .rejects.toThrow(/does not expose getInscriptions/);
  });
});
