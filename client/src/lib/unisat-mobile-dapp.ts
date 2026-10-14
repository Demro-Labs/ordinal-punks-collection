export type UniSatDappSite = "punks" | "pokedex";

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const end = Math.min(offset + 0x8000, bytes.length);
    for (let index = offset; index < end; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

/** Build the official UniSat Universal/App Link that opens this dApp in its mobile browser. */
export function buildUniSatOpenDappUrl(pageUrl: string, site: UniSatDappSite): string {
  const dappUrl = new URL(pageUrl);
  if (dappUrl.protocol !== "https:" && dappUrl.hostname !== "localhost") {
    throw new Error("UniSat mobile dApps must use HTTPS.");
  }
  const from = site === "punks" ? "OrdinalPunks" : "FractalPokedex";
  const params = new URLSearchParams({
    method: "openDapp",
    from,
    data: encodeBase64Utf8(JSON.stringify([dappUrl.href])),
  });
  return `https://app.unisat.cloud/request?${params.toString()}`;
}
