import { LIVE_DATA_API_BASE } from "@/lib/live";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmFractalSpendableUtxos, confirmSpendableUtxos, getMempoolConfig, getMempoolRawTransaction, getRecommendedFeeEstimate, getSpendableUtxos, InsufficientSafeUtxosError, minimumSpendableSatsForScript, trackMempoolTransaction, validateMempoolAddress } from "./mempool";

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

describe("minimumSpendableSatsForScript", () => {
  it("uses the Worker-aligned dust floor for standard script templates", () => {
    expect(minimumSpendableSatsForScript(`0014${"11".repeat(20)}`)).toBe(294);
    expect(minimumSpendableSatsForScript(`5120${"22".repeat(32)}`)).toBe(330);
    expect(minimumSpendableSatsForScript(`a914${"33".repeat(20)}87`)).toBe(540);
    expect(minimumSpendableSatsForScript(`76a914${"44".repeat(20)}88ac`)).toBe(546);
    expect(minimumSpendableSatsForScript("deadbeef")).toBe(600);
  });
});

describe("validateMempoolAddress", () => {
  it.each(["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"])("validates %s locally without depending on Mempool", async network => {
    const fetchMock = vi.fn();
    installWindowAndFetch(fetchMock as typeof fetch);
    await validateMempoolAddress(network, "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed addresses and unsupported networks locally", async () => {
    const fetchMock = vi.fn();
    installWindowAndFetch(fetchMock as typeof fetch);
    await expect(validateMempoolAddress("BITCOIN_MAINNET", "not-a-bitcoin-address")).rejects.toThrow(/n’est pas valide/i);
    await expect(validateMempoolAddress("UNKNOWN_NETWORK", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT")).rejects.toThrow(/Unsupported mainnet network/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getSpendableUtxos", () => {
  it("scans the full 500-output window by default even when the first UTXO covers the minimum", async () => {
    const cursors: number[] = [];
    installWindowAndFetch((async input => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get("cursor"));
      cursors.push(cursor);
      return Response.json({
        chain: "fractal", address: ADDRESS, cursor, nextCursor: cursor + 25, total: 500, scannedCount: 25,
        utxo: cursor === 0 ? [makeSafeUtxo({ satoshi: 600_000 })] : [],
      });
    }) as typeof fetch);
    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 1_700);
    expect(cursors).toHaveLength(20);
    expect(cursors[0]).toBe(0);
    expect(cursors.at(-1)).toBe(475);
    expect(result).toHaveLength(1);
    expect(result[0].satoshi).toBe(600_000);
  });
  it.each([
    { label: "P2WPKH", scriptPk: `0014${"11".repeat(20)}`, satoshi: 294 },
    { label: "P2TR", scriptPk: `5120${"22".repeat(32)}`, satoshi: 330 },
  ])("accepts a confirmed $label output at its standard dust floor", async ({ scriptPk, satoshi }) => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal", address: ADDRESS, cursor: 0, nextCursor: 1, total: 1, scannedCount: 1,
      utxo: [makeSafeUtxo({ scriptPk, satoshi })],
    }));
    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, satoshi);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ scriptPk, satoshi });
  });

  it("rejects an output below its script-specific dust floor", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal", address: ADDRESS, cursor: 0, nextCursor: 1, total: 1, scannedCount: 1,
      utxo: [makeSafeUtxo({ satoshi: 293 })],
    }));
    await expect(getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 293))
      .rejects.toBeInstanceOf(InsufficientSafeUtxosError);
  });

  it("normalizes UniSat satoshi strings before applying safe-balance checks", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal", address: ADDRESS, cursor: 0, nextCursor: 1, total: 1, scannedCount: 1,
      utxo: [makeSafeUtxo({ satoshi: "600000" as unknown as number })],
    }));
    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 1_700);
    expect(result).toHaveLength(1);
    expect(result[0].satoshi).toBe(600_000);
  });

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

    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 5_000, { collectAll: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ isLowFee: true, height: 100, inscriptionsRunesAlkanesChecked: true });
  });

  it("collects all safe UTXOs for exact PSBT fee calculation instead of enforcing a fixed reserve", async () => {
    const cursors: number[] = [];
    installWindowAndFetch(async input => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get("cursor"));
      cursors.push(cursor);
      const utxo = cursor === 0
        ? [makeSafeUtxo({ txid: "a".repeat(64), satoshi: 600 })]
        : [makeSafeUtxo({ txid: "b".repeat(64), satoshi: 492 })];
      return Response.json({ chain: "fractal", address: ADDRESS, cursor, nextCursor: cursor + 1, total: 2, scannedCount: 1, utxo });
    });
    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 1, { collectAll: true });
    expect(cursors).toEqual([0, 1]);
    expect(result.reduce((sum, item) => sum + item.satoshi, 0)).toBe(1_092);
  });

  it("continues collectAll beyond 500 outputs until the indexer total is exhausted", async () => {
    const cursors: number[] = [];
    installWindowAndFetch(async input => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get("cursor"));
      cursors.push(cursor);
      const scannedCount = Math.min(25, 501 - cursor);
      return Response.json({
        chain: "fractal", address: ADDRESS, cursor, nextCursor: cursor + scannedCount, total: 501, scannedCount,
        utxo: cursor === 500 ? [makeSafeUtxo({ txid: "b".repeat(64) })] : [],
      });
    });

    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 1, { collectAll: true });
    expect(cursors).toHaveLength(21);
    expect(cursors.at(-1)).toBe(500);
    expect(result).toHaveLength(1);
    expect(result[0].txid).toBe("b".repeat(64));
  });

  it("fails closed when the indexer stops advancing before its reported total", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "fractal", address: ADDRESS, cursor: 0, nextCursor: 0, total: 26, scannedCount: 0, utxo: [],
    }));

    await expect(getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 1, { collectAll: true }))
      .rejects.toThrow(/scan is incomplete.*0 of 26/i);
  });

  it("keeps paging until every exact PSBT outpoint is verified", async () => {
    const cursors: number[] = [];
    installWindowAndFetch(async input => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get("cursor"));
      cursors.push(cursor);
      const utxo = cursor === 0
        ? makeSafeUtxo({ txid: "a".repeat(64), vout: 0 })
        : makeSafeUtxo({ txid: "b".repeat(64), vout: 1 });
      return Response.json({ chain: "bitcoin", address: ADDRESS, cursor, nextCursor: cursor + 1, total: 2, scannedCount: 1, utxo: [utxo] });
    });

    const result = await getSpendableUtxos("BITCOIN_MAINNET", ADDRESS, 10_000, { requiredOutpoints: [`${"b".repeat(64)}:1`] });
    expect(cursors).toEqual([0, 1]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ txid: "b".repeat(64), vout: 1 });
  });

  it("rejects a PSBT input if only unrelated safe UTXOs were found", async () => {
    installWindowAndFetch(async () => Response.json({
      chain: "bitcoin", address: ADDRESS, cursor: 0, nextCursor: 1, total: 1, scannedCount: 1,
      utxo: [makeSafeUtxo({ txid: "a".repeat(64), vout: 0 })],
    }));

    await expect(getSpendableUtxos("BITCOIN_MAINNET", ADDRESS, 10_000, { requiredOutpoints: [`${"b".repeat(64)}:1`] }))
      .rejects.toThrow(/exact PSBT input/i);
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

    const result = await getSpendableUtxos("FRACTAL_BITCOIN_MAINNET", ADDRESS, 5_000, { collectAll: false });
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
      .rejects.toThrow(/consistent safe-UTXO page/i);
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

describe("confirmFractalSpendableUtxos", () => {
  it("accepts only the Worker response that confirms the submitted PSBT inputs and required total", async () => {
    installWindowAndFetch(async (input, init = {}) => {
      expect(String(input)).toBe("https://fractal-ordinal-live.servostar23.workers.dev/api/spendable-utxos/confirm");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ chain: "fractal", address: ADDRESS, minimumSats: 10_400, utxos: [{ txid: "a".repeat(64), vout: 0, satoshi: 10_500, sourceCursor: 500 }] });
      return Response.json({ chain: "fractal", address: ADDRESS, minimumSats: 10_400, safeSats: 10_500, sufficient: true, verifiedUtxoCount: 1, confirmedAt: new Date().toISOString() });
    });
    const result = await confirmFractalSpendableUtxos(ADDRESS, 10_400, [{ txid: "a".repeat(64), vout: 0, satoshi: 10_500, scriptPk: "0014" + "11".repeat(20), sourceCursor: 500 }]);
    expect(result).toMatchObject({ sufficient: true, safeSats: 10_500, minimumSats: 10_400 });
  });

  it("rejects a Worker response that does not cover the required amount", async () => {
    installWindowAndFetch(async () => Response.json({ chain: "fractal", address: ADDRESS, minimumSats: 10_400, safeSats: 9_000, sufficient: false, verifiedUtxoCount: 1, confirmedAt: new Date().toISOString() }));
    await expect(confirmFractalSpendableUtxos(ADDRESS, 10_400, [{ txid: "a".repeat(64), vout: 0, satoshi: 9_000, scriptPk: "0014" + "11".repeat(20) }]))
      .rejects.toBeInstanceOf(InsufficientSafeUtxosError);
  });
});

describe("confirmSpendableUtxos network routing", () => {
  it("sends Bitcoin Local Vault confirmation to the Worker with the Bitcoin chain key", async () => {
    let requestBody: Record<string, unknown> | null = null;
    installWindowAndFetch(async (input, init = {}) => {
      expect(String(input)).toBe(`${LIVE_DATA_API_BASE}/api/spendable-utxos/confirm`);
      const body = JSON.parse(String(init.body));
      requestBody = body;
      expect(body).toMatchObject({ chain: "bitcoin", address: ADDRESS, minimumSats: 10_400 });
      return Response.json({ chain: "bitcoin", address: ADDRESS, minimumSats: 10_400, safeSats: 10_500, sufficient: true, verifiedUtxoCount: 1, confirmedAt: new Date().toISOString() });
    });
    const result = await confirmSpendableUtxos("BITCOIN_MAINNET", ADDRESS, 10_400, [{ txid: "a".repeat(64), vout: 0, satoshi: 10_500, scriptPk: "0014" + "11".repeat(20), sourceCursor: 500 }]);
    expect(requestBody).toMatchObject({ utxos: [{ sourceCursor: 500 }] });
    expect(result).toMatchObject({ chain: "bitcoin", sufficient: true, safeSats: 10_500 });
  });
});

describe("trackMempoolTransaction network routing", () => {
  it.each([
    { network: "BITCOIN_MAINNET", label: "Bitcoin" },
    { network: "FRACTAL_BITCOIN_MAINNET", label: "Fractal Bitcoin" },
  ])("uses only the $label Mempool for its network enum", async ({ network, label }) => {
    const txid = "b".repeat(64);
    const urls: string[] = [];
    installWindowAndFetch(async input => {
      urls.push(String(input));
      return Response.json({ confirmed: true, block_height: 123 });
    });

    const receipt = await trackMempoolTransaction(txid, network);

    expect(urls).toEqual([`${LIVE_DATA_API_BASE}/api/mempool/tx-status?chain=${encodeURIComponent(network)}&txid=${txid}`]);
    expect(receipt).toMatchObject({ txid, network: label, status: "confirmed", blockHeight: 123 });
  });

  it("rejects an unknown network instead of defaulting to Fractal", async () => {
    const fetchMock = vi.fn(async () => Response.json({ confirmed: true }));
    installWindowAndFetch(fetchMock as typeof fetch);

    await expect(trackMempoolTransaction("b".repeat(64), "UNKNOWN_NETWORK"))
      .rejects.toThrow(/No Mempool endpoint/i);
    expect(getMempoolConfig("UNKNOWN_NETWORK")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Mempool fee fallback and Legacy transaction routing", () => {
  it.each([
    { network: "BITCOIN_MAINNET" },
    { network: "FRACTAL_BITCOIN_MAINNET" },
  ])("falls back to the selected $network Mempool through the Worker proxy for current fees", async ({ network }) => {
    const urls: string[] = [];
    installWindowAndFetch(async input => {
      const url = String(input);
      urls.push(url);
      if (new URL(url).pathname === "/api/fees/recommended") return Response.json({ error: "Worker unavailable" }, { status: 503 });
      return Response.json({ halfHourFee: 3, fastestFee: 5, minimumFee: 1 });
    });
    const estimate = await getRecommendedFeeEstimate(network);
    expect(estimate).toMatchObject({ network, feeRate: 3, strategy: "single-provider-fallback", sources: { mempool: { feeRate: 3, available: true }, unisat: { feeRate: null, available: false } } });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(`${LIVE_DATA_API_BASE}/api/mempool/fees?chain=${encodeURIComponent(network)}`);
  });

  it.each(["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"])("uses a valid fallback fee when halfHourFee is present but invalid for %s", async network => {
    const urls: string[] = [];
    installWindowAndFetch(async input => {
      const url = String(input);
      urls.push(url);
      if (new URL(url).pathname === "/api/fees/recommended") return Response.json({ error: "Worker unavailable" }, { status: 503 });
      return Response.json({ halfHourFee: 0, fastestFee: 5, hourFee: 2, minimumFee: 1 });
    });
    const estimate = await getRecommendedFeeEstimate(network);
    expect(estimate.feeRate).toBe(5);
    expect(estimate.network).toBe(network);
    expect(urls).toHaveLength(2);
  });

  it.each([
    { network: "BITCOIN_MAINNET", endpoint: "https://mempool.space" },
    { network: "FRACTAL_BITCOIN_MAINNET", endpoint: "https://mempool.fractalbitcoin.io" },
  ])("fetches Legacy parent hex from the matching $network Mempool via the Worker proxy", async ({ network }) => {
    const txid = "c".repeat(64);
    const rawHex = "02000000";
    const urls: string[] = [];
    installWindowAndFetch(async input => {
      urls.push(String(input));
      return new Response(rawHex, { status: 200, headers: { "Content-Type": "text/plain" } });
    });
    await expect(getMempoolRawTransaction(network, txid)).resolves.toBe(rawHex);
    expect(urls).toEqual([`${LIVE_DATA_API_BASE}/api/mempool/tx-hex?chain=${encodeURIComponent(network)}&txid=${txid}`]);
  });

  it("rejects an unknown network instead of routing Legacy inputs to the wrong chain", async () => {
    const fetchMock = vi.fn(async () => new Response("aa", { status: 200 }));
    installWindowAndFetch(fetchMock as typeof fetch);
    await expect(getMempoolRawTransaction("UNKNOWN_NETWORK", "c".repeat(64))).rejects.toThrow(/No Mempool endpoint/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
