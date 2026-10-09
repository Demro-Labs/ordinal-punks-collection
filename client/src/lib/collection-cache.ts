const CACHE_NAME = "ordinal-punks-collection-manifest-v1";

export type CachedCollection<T> = {
  data: T;
  lastModified: string;
};

export async function readCachedCollection<T>(url: string): Promise<CachedCollection<T> | null> {
  if (typeof globalThis.caches === "undefined") return null;
  try {
    const cache = await globalThis.caches.open(CACHE_NAME);
    const response = await cache.match(url);
    if (!response) return null;
    return {
      data: await response.json() as T,
      lastModified: response.headers.get("last-modified") || "",
    };
  } catch {
    // Storage can be unavailable or evicted; the network remains the source of truth.
    return null;
  }
}

export async function cacheCollectionResponse(url: string, response: Response): Promise<void> {
  if (!response.ok || typeof globalThis.caches === "undefined") return;
  let responseCopy: Response;
  try {
    responseCopy = response.clone();
  } catch {
    return;
  }
  try {
    const cache = await globalThis.caches.open(CACHE_NAME);
    await cache.put(url, responseCopy);
  } catch {
    // Quota, privacy, or Cache API failures must not prevent the app from loading.
  }
}
