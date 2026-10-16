import { describe, expect, it } from "vitest";
import { DEFAULT_INSCRIBE_BATCH_MAX_BYTES, DEFAULT_INSCRIBE_FILE_MAX_BYTES, estimateInscribeRequestBytes, splitInscribeFilesIntoBatches } from "./inscribe-file-batches";

describe("splitInscribeFilesIntoBatches", () => {
  it("keeps a 1000-file small batch together", () => {
    const files = Array.from({ length: 1_000 }, (_, index) => ({ name: `file-${index}.txt`, size: 100 }));
    const batches = splitInscribeFilesIntoBatches(files);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1_000);
    expect(batches[0]).toEqual(files);
  });

  it("splits a 1000-file large selection into payable request-sized receipts without losing order", () => {
    const files = Array.from({ length: 1_000 }, (_, index) => ({ name: `image-${index}.png`, size: DEFAULT_INSCRIBE_FILE_MAX_BYTES }));
    const batches = splitInscribeFilesIntoBatches(files);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(files);
    expect(batches.every(batch => batch.length > 0 && estimateInscribeRequestBytes(batch) <= DEFAULT_INSCRIBE_BATCH_MAX_BYTES)).toBe(true);
  });

  it("rejects more than the advertised total file limit", () => {
    const files = Array.from({ length: 1_001 }, (_, index) => ({ name: `file-${index}.txt`, size: 1 }));
    expect(() => splitInscribeFilesIntoBatches(files)).toThrow("1000");
  });

  it("rejects files that exceed the UniSat per-file limit", () => {
    expect(() => splitInscribeFilesIntoBatches([{ name: "large.png", size: DEFAULT_INSCRIBE_FILE_MAX_BYTES + 1 }])).toThrow("octets");
  });
});
