import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProtocolBalances, type ProtocolNetwork } from "./protocol-balances";

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
        expect(url.pathname).toBe("/api/brc20/balances");
        expect(url.searchParams.get("address")).toBe(ADDRESS);
        expect(url.searchParams.get("chain")).toBe(network);
        return Response.json({ network, address: ADDRESS, detail: [SIX_CHAR_BALANCE] });
      });
      vi.stubGlobal("fetch", fetchMock as typeof fetch);

      const result = await fetchProtocolBalances(ADDRESS, network);

      expect(result.network).toBe(network);
      expect(result.address).toBe(ADDRESS);
      expect(result.brc20).toEqual([SIX_CHAR_BALANCE]);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects a response that belongs to another network or wallet", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "FRACTAL_BITCOIN_MAINNET",
      address: "bc1qsomeotherwalletaddress",
      detail: [],
    })) as typeof fetch);

    await expect(fetchProtocolBalances(ADDRESS, "BITCOIN_MAINNET"))
      .rejects.toThrow(/autre réseau\/wallet/i);
  });

  it("rejects a malformed summary instead of rendering a false zero balance", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "BITCOIN_MAINNET",
      address: ADDRESS,
      detail: null,
    })) as typeof fetch);

    await expect(fetchProtocolBalances(ADDRESS, "BITCOIN_MAINNET"))
      .rejects.toThrow(/réponse incomplète/i);
  });

  it("rejects malformed rows rather than silently hiding a live token", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({
      network: "BITCOIN_MAINNET",
      address: ADDRESS,
      detail: [{ ...SIX_CHAR_BALANCE, ticker: "BAD" }],
    })) as typeof fetch);

    await expect(fetchProtocolBalances(ADDRESS, "BITCOIN_MAINNET"))
      .rejects.toThrow(/ligne du solde/i);
  });
});
