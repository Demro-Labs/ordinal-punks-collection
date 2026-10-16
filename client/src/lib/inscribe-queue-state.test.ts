import { describe, expect, it } from "vitest";
import { canRemoveInscribeQueueFile, getRemainingInscribeFiles, mergeSelectedInscribeFiles } from "./inscribe-queue-state";

describe("Inscribe queue lifecycle", () => {
  it("starts a fresh queue after the last receipt is completed", () => {
    expect(mergeSelectedInscribeFiles(["done-a", "done-b"], ["new"], "completed", 2)).toEqual(["new"]);
  });

  it("appends selections when a completed receipt still has later files queued", () => {
    expect(mergeSelectedInscribeFiles(["done", "pending"], ["added"], "completed", 1)).toEqual(["done", "pending", "added"]);
  });

  it("keeps adding files to an unfinished queue", () => {
    expect(mergeSelectedInscribeFiles(["first"], ["second"], "awaiting-approval", 1)).toEqual(["first", "second"]);
  });

  it("returns only unprocessed files after a receipt completes", () => {
    expect(getRemainingInscribeFiles(["done-a", "done-b", "next-a"], "completed", 2)).toEqual(["next-a"]);
    expect(getRemainingInscribeFiles(["a", "b"], "tracking", 1)).toEqual([]);
  });

  it("protects receipt files while allowing edits to later queued files", () => {
    expect(canRemoveInscribeQueueFile(0, "completed", 2)).toBe(false);
    expect(canRemoveInscribeQueueFile(2, "completed", 2)).toBe(true);
    expect(canRemoveInscribeQueueFile(0, "awaiting-approval", 1)).toBe(false);
    expect(canRemoveInscribeQueueFile(0, "idle", null)).toBe(true);
  });
});
