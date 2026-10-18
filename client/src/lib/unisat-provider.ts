export type UniSatProviderLike = Record<string, unknown>;

export function getUniSatProvider(): UniSatProviderLike | undefined {
  if (typeof window === "undefined") return undefined;
  const scoped = window as Window & { unisat_wallet?: UniSatProviderLike; unisat?: UniSatProviderLike };
  return scoped.unisat_wallet ?? scoped.unisat;
}

export function hasUniSatProvider() {
  return Boolean(getUniSatProvider());
}
