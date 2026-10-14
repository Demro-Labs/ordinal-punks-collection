import { describe, expect, it } from "vitest";
import { buildUniSatOpenDappUrl } from "./unisat-mobile-dapp";

describe("buildUniSatOpenDappUrl", () => {
  it.each([
    ["punks", "OrdinalPunks"],
    ["pokedex", "FractalPokedex"],
  ] as const)("creates an official openDapp link for %s", (site, from) => {
    const link = new URL(buildUniSatOpenDappUrl("https://demro-labs.github.io/app/?view=wallet#inscribe", site));
    expect(link.origin).toBe("https://app.unisat.cloud");
    expect(link.pathname).toBe("/request");
    expect(link.searchParams.get("method")).toBe("openDapp");
    expect(link.searchParams.get("from")).toBe(from);
    const encoded = link.searchParams.get("data");
    expect(encoded).not.toBeNull();
    const bytes = Uint8Array.from(atob(encoded!), character => character.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(["https://demro-labs.github.io/app/?view=wallet#inscribe"]);
  });

  it("rejects non-HTTPS dApp pages outside localhost", () => {
    expect(() => buildUniSatOpenDappUrl("http://example.com", "punks")).toThrow("must use HTTPS");
  });
});
