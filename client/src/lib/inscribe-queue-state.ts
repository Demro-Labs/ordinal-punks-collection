export type InscribeQueueStage = "idle" | "preparing" | "awaiting-approval" | "paying" | "tracking" | "completed";

/** Once a receipt completed, choosing new files starts a fresh queue if no files remain. */
export function mergeSelectedInscribeFiles<T>(
  existing: T[],
  selected: T[],
  stage: InscribeQueueStage,
  receiptFileCount: number | null,
): T[] {
  if (stage === "completed" && receiptFileCount !== null && existing.length <= receiptFileCount) {
    return [...selected];
  }
  return [...existing, ...selected];
}

/** Return only files that have not been included in the completed receipt. */
export function getRemainingInscribeFiles<T>(
  files: T[],
  stage: InscribeQueueStage,
  receiptFileCount: number,
): T[] {
  if (stage !== "completed" || !Number.isSafeInteger(receiptFileCount) || receiptFileCount < 0) return [];
  return files.slice(receiptFileCount);
}

/** Never let queue edits remove files represented by an active or completed receipt. */
export function canRemoveInscribeQueueFile(
  index: number,
  stage: InscribeQueueStage,
  receiptFileCount: number | null,
  busy = false,
): boolean {
  if (busy || !Number.isSafeInteger(index) || index < 0) return false;
  if (receiptFileCount === null) return true;
  return stage === "completed" && index >= receiptFileCount;
}
