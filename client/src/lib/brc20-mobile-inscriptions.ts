import type { OrdinalLocation } from "./ordinal-transfer-psbt";

export type Brc20MobileInscriptionsProvider = {
  getInscriptions?: (cursor: number, size: number) => Promise<{
    total?: number;
    list?: Array<{ inscriptionId?: string; location?: string }>;
  }>;
};

const PAGE_SIZE = 100;
const MAX_INSCRIPTIONS = 5_000;
const INSCRIPTION_ID_PATTERN = /^[a-f0-9]{64}i\d+$/i;
const INSCRIPTION_LOCATION_PATTERN = /^[a-f0-9]{64}:\d+:\d+$/i;

/** Load all indexed wallet inscriptions so the PSBT planner can protect Ordinals from fee inputs. */
export async function loadOwnedInscriptionsForMobileTransfer(
  provider: Brc20MobileInscriptionsProvider,
  targetId: string,
): Promise<OrdinalLocation[]> {
  if (!provider.getInscriptions) {
    throw new Error("UniSat mobile does not expose getInscriptions; the transfer was not signed or broadcast.");
  }
  const owned = new Map<string, OrdinalLocation>();
  let cursor = 0;
  let total = Number.POSITIVE_INFINITY;
  while (cursor < total && cursor < MAX_INSCRIPTIONS) {
    const page = await provider.getInscriptions(cursor, PAGE_SIZE);
    const list = Array.isArray(page?.list) ? page.list : [];
    total = Number.isSafeInteger(page?.total) && Number(page.total) >= 0
      ? Number(page.total)
      : cursor + list.length + (list.length === PAGE_SIZE ? 1 : 0);
    for (const item of list) {
      if (typeof item.inscriptionId !== "string" || !INSCRIPTION_ID_PATTERN.test(item.inscriptionId)) continue;
      if (typeof item.location !== "string" || !INSCRIPTION_LOCATION_PATTERN.test(item.location)) continue;
      const inscriptionId = item.inscriptionId.toLowerCase();
      owned.set(inscriptionId, { inscriptionId, location: item.location });
    }
    if (!list.length) break;
    cursor += list.length;
  }
  if (cursor < total) {
    throw new Error(`UniSat reports more than ${MAX_INSCRIPTIONS} inscriptions. Refresh the wallet and reduce the asset set before retrying.`);
  }
  if (!owned.has(targetId.toLowerCase())) {
    throw new Error("The transfer inscription is not yet indexed among this UniSat account's inscriptions. Verify the order and refresh before sending.");
  }
  return Array.from(owned.values());
}
