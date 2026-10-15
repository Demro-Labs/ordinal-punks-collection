export type UniSatMobileSignProvider = {
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
};

export const UNISAT_MOBILE_SIGN_TIMEOUT_MS = 30_000;

export class UniSatSignTimeoutError extends Error {
  constructor() {
    super("UniSat did not respond within 30 seconds. Check the wallet for a pending request before trying again.");
    this.name = "UniSatSignTimeoutError";
  }
}

export function signUniSatBip322Message(
  provider: UniSatMobileSignProvider,
  message: string,
  timeoutMs = UNISAT_MOBILE_SIGN_TIMEOUT_MS,
): Promise<string> {
  if (!provider?.signMessage) return Promise.reject(new Error("This UniSat version does not expose BIP-322 message signing."));
  // Start the wallet prompt synchronously in the tap's call stack. Do not add
  // any network request or awaited provider check before this invocation.
  const signPromise = provider.signMessage(message, "bip322-simple");
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UniSatSignTimeoutError()), timeoutMs);
  });
  return Promise.race([signPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/** Backward-compatible name used by the mobile wallet authentication flow. */
export const signMobileUniSatMessage = signUniSatBip322Message;
