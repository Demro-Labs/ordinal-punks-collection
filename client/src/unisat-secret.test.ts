import { describe, expect, it } from "vitest";

describe("UniSat server secret", () => {
  it("can read one Fractal inscription through the authenticated API", async () => {
    const apiKey = process.env.UNISAT_API_KEY;
    expect(apiKey, "UNISAT_API_KEY must be configured").toBeTruthy();

    const inscriptionId = "a155ff2f7c5591f312e5f77d345cc077fb776eddf1d8686345f0f07f72c6d652i0";
    const response = await fetch(`https://open-api-fractal.unisat.io/v1/indexer/inscription/info/${inscriptionId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { code?: number; data?: { inscriptionId?: string } };
    expect(payload.code).toBe(0);
    expect(payload.data?.inscriptionId).toBe(inscriptionId);
  }, 30_000);
});
