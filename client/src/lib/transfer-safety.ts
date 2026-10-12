const FRACTAL_MAINNET = "FRACTAL_BITCOIN_MAINNET";
const BITCOIN_MAINNET = "BITCOIN_MAINNET";

export function getUniSatInscriptionUrl(
  networkEnum: string | undefined,
  inscriptionId: string
): string | null {
  const host = networkEnum === FRACTAL_MAINNET
    ? "https://fractal.unisat.io"
    : networkEnum === BITCOIN_MAINNET
      ? "https://unisat.io"
      : null;

  return host
    ? `${host}/inscription/${encodeURIComponent(inscriptionId)}`
    : null;
}

function getErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const details = value as { message?: unknown; error?: unknown };
    return [details.message, details.error]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
  }
  return "";
}

/**
 * A wallet response error or an interrupted Mempool broadcast may occur after
 * the transaction was accepted. Treat these cases as indeterminate until the
 * user checks wallet history and the selected network's mempool.
 */
export function isTransferOutcomeUnclear(value: unknown): boolean {
  const message = getErrorMessage(value);
  return (
    (/toAddress/i.test(message) && /undefined/i.test(message)) ||
    /returned an incomplete transfer response/i.test(message) ||
    /did not return a valid transaction id/i.test(message) ||
    /BROADCAST_OUTCOME_UNCLEAR|broadcast outcome is uncertain/i.test(message)
  );
}
