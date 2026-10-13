import { afterEach, describe, expect, it, vi } from "vitest";
import { getSpendableUtxos, InsufficientSafeUtxosError } from "./mempool";

const ADDRESS = "bc1qtestaddress0000000000000000000000000";

function makeSafeUtxo(overrides: Record<string, unknown> = {}) {
  return {
    address: ADDRESS,
    txid: "a".repeat(64),
    vout: 0,
    satoshi: 10_000,
    scriptPk: `0014${"11".repeat(20)}`,
    height: 100,
    inscriptionsRunesAlkanesChecked: true,
    isLowFee: true,
    isOpInRBF: true,
    inscriptions: [],
    ...overrides,
  };
}

function installWindowAndFetch(fetchImpl: typeof fetch) {
  vi.stubGlobal("window", {
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  vi.stubGlobal("fetch", fetchImpl);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getSpendableUtxos", () => {
  it("accepts a confirmed low-fee output after the Worker verifies it has no assets", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal",
      address: ADDRESS,
      cursor: 0,
      nextCursor: 1,
      total: 1,
      scannedCount: 1,
      utxo: [makeSafeUtxo()],
    }));

    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 5_000);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ isLowFee: true, height: 100, inscriptionsRunesAlkanesChecked: true });
  });

  it("continues paging beyond 250 outputs until enough safe UTXOs are found", async () => {
    const requestedCursors: number[] = [];
    installWindowAndFetch(async input => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get("cursor"));
      requestedCursors.push(cursor);
      const remaining = 251 - cursor;
      const scannedCount = Math.min(25, remaining);
      const utxo = cursor === 250
        ? [makeSafeUtxo({ txid: "b".repeat(64) })]
        : Array.from({ length: scannedCount }, (_, index) => ({ txid: `${cursor + index}`.padStart(64, "0"), inscriptions: [{ id: "asset" }] }));
      return Response.json({
        chain: "fractal",
        address: ADDRESS,
        cursor,
        nextCursor: cursor + scannedCount,
        total: 251,
        scannedCount,
        utxo,
      });
    });

    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 5_000);
    expect(result).toHaveLength(1);
    expect(result[0].txid).toBe("b".repeat(64));
    expect(requestedCursors).toEqual([0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250]);
  });

  it("fails closed instead of accepting a page with a mismatched cursor", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal",
      address: ADDRESS,
      cursor: 25,
      nextCursor: 26,
      total: 26,
      scannedCount: 1,
      utxo: [makeSafeUtxo()],
    }));

    await expect(getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 5_000))
      .rejects.toThrow(/page cohérente d’UTXO sûrs/i);
  });

  it("emits the typed shortage signal only when no verified UTXOs cover the minimum", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal",
      address: ADDRESS,
      cursor: 0,
      nextCursor: 0,
      total: 0,
      scannedCount: 0,
      utxo: [],
    }));

    await expect(getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 5_000))
      .rejects.toBeInstanceOf(InsufficientSafeUtxosError);
  });
});
