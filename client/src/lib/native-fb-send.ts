const SATOSHIS_PER_FB = 100_000_000;

/** Parse a decimal FB amount without floating-point rounding. */
export function parseFbAmountToSats(value: string): number | null {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(8, "0"));
  const satoshis = whole * SATOSHIS_PER_FB + fraction;
  return Number.isSafeInteger(satoshis) && satoshis > 0 ? satoshis : null;
}

/** UniSat documents a string TXID; accept an object wrapper defensively for wallet variants. */
export function normalizeUniSatTxid(value: unknown): string | null {
  const txid = typeof value === "string"
    ? value
    : value && typeof value === "object" && "txid" in value
      ? (value as { txid?: unknown }).txid
      : null;
  return typeof txid === "string" && /^[a-f0-9]{64}$/i.test(txid) ? txid.toLowerCase() : null;
}
