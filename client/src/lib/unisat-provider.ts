export type UniSatProviderLike = Record<string, unknown> & {
  requestAccounts?: () => Promise<string[]>;
};

function isConnectableProvider(value: unknown): value is UniSatProviderLike {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { requestAccounts?: unknown }).requestAccounts === "function"
  );
}

export function getUniSatProvider(): UniSatProviderLike | undefined {
  if (typeof window === "undefined") return undefined;
  const scoped = window as Window & {
    unisat?: UniSatProviderLike;
    unisat_wallet?: UniSatProviderLike;
  };

  // Prefer UniSat's documented provider. Do not let an unrelated or
  // partially injected unisat_wallet object shadow window.unisat.
  if (isConnectableProvider(scoped.unisat)) return scoped.unisat;
  if (isConnectableProvider(scoped.unisat_wallet)) return scoped.unisat_wallet;
  return undefined;
}

export function hasUniSatProvider() {
  return Boolean(getUniSatProvider());
}
