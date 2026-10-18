import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAlkaneCollectionPage, fetchProtocolBalances, type ProtocolNetwork } from "./protocol-balances";

const ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const SIX_CHAR_BALANCE = {
  ticker: "ABCDEF",
  overallBalance: "100.25",
  transferableBalance: "25",
  availableBalance: "75.25",
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchProtocolBalances", () => {
  it.each(["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"] as const)(
    "requests live classic BRC-20 balances for the explicit %s network and keeps six-character tickers",
    async (network: ProtocolNetwork) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(["/api/brc20/balances", "/api/brc20-prog/balances", "/api/runes/balance-list", "/api/alkanes/balances"]).toContain(url.pathname);
        expect(url.searchParams.get("address")).toBe(ADDRESS);
        expect(url.searchParams.get("chain")).toBe(network);
        return Response.json({ network, address: ADDRESS, detail: url.pathname === "/api/brc20/balances" ? [SIX_CHAR_BALANCE] : [] });
      });
      vi.stubGlobal("fetch", fetchMock as typeof fetch);

      const result = await fetchProtocolBalances(ADDRESS, network);

      expect(result.network).toBe(network);
      expect(result.address).toBe(ADDRESS);
      expect(result.brc20).toEqual([SIX_CHAR_BALANCE]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
      expect(new Set(paths)).toEqual(new Set(["/api/brc20/balances", "/api/brc20-prog/balances", "/api/runes/balance-list", "/api/alkanes/balances"]));
    },
  );

  it("loads a validated paginated Bitcoin Alkanes collection page", async () => {
    const refreshedAt = "2026-10-18T00:00:00.000Z";
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/alkanes/collection-list");
      expect(url.searchParams.get("address")).toBe(ADDRESS);
      expect(url.searchParams.get("chain")).toBe("BITCOIN_MAINNET");
      expect(url.searchParams.get("start")).toBe("25");
      expect(url.searchParams.get("limit")).toBe("25");
      return Response.json({ network: "BITCOIN_MAINNET", address: ADDRESS, start: 25, total: 26, refreshedAt, detail: [{ alkaneid: "2:2", type: "collection", collectionData: { name: "Example Collection", totalSupply: "100", minted: 26 } }] });
    }) as typeof fetch);

    await expect(fetchAlkaneCollectionPage(ADDRESS, "BITCOIN_MAINNET", 25)).resolves.toEqual({
      network: "BITCOIN_MAINNET",
      address: ADDRESS,
      start: 25,
      total: 26,
      refreshedAt,
      detail: [{ alkaneid: "2:2", name: "Example Collection", totalSupply: "100", minted: 26 }],
    });
  });

  it("does not request an unverified Fractal Alkanes collection index", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    await expect(fetchAlkaneCollectionPage(ADDRESS, "FRACTAL_BITCOIN_MAINNET", 0))
      .rejects.toThrow(/only for Bitcoin mainnet/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed Alkanes collection row", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "BITCOIN_MAINNET",
      address: ADDRESS,
      start: 0,
      total: 1,
      detail: [{ alkaneid: "2:2", type: "token", collectionData: { name: "Not a collection", totalSupply: "1", minted: 1 } }],
    })) as typeof fetch);

    await expect(fetchAlkaneCollectionPage(ADDRESS, "BITCOIN_MAINNET", 0))
      .rejects.toThrow(/collection row is invalid/i);
  });

  it("rejects a response that belongs to another network or wallet", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "FRACTAL_BITCOIN_MAINNET",
      address: "bc1qsomeotherwalletaddress",
      detail: [],
    })) as typeof fetch);

    await expect(fetchProtocolBalances(ADDRESS, "BITCOIN_MAINNET"))
      .rejects.toThrow(/different network or wallet/i);
  });

  it("rejects a malformed summary instead of rendering a false zero balance", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "BITCOIN_MAINNET",
      address: ADDRESS,
      detail: null,
    })) as typeof fetch);

    await expect(fetchProtocolBalances(ADDRESS, "BITCOIN_MAINNET"))
      .rejects.toThrow(/incomplete response/i);
  });

  it("rejects malformed rows rather than silently hiding a live token", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "BITCOIN_MAINNET",
      address: ADDRESS,
      detail: [{ ...SIX_CHAR_BALANCE, ticker: "BAD" }],
    })) as typeof fetch);

    await expect(fetchProtocolBalances(ADDRESS, "BITCOIN_MAINNET"))
      .rejects.toThrow(/balance row/i);
  });
});
