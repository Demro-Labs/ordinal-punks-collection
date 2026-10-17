import { describe, expect, it } from "vitest";
import { DEFAULT_INSCRIBE_BATCH_MAX_BYTES, DEFAULT_INSCRIBE_FILE_MAX_BYTES, estimateInscribeRequestBytes, splitInscribeFilesIntoBatches } from "./inscribe-file-batches";

describe("splitInscribeFilesIntoBatches", () => {
  it("keeps the supported 100-file inscription together", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ name: `file-${index}.txt`, size: 100 }));
    const batches = splitInscribeFilesIntoBatches(files);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(100);
    expect(batches[0]).toEqual(files);
  });

  it("splits files when the request-byte limit requires separate receipts without losing order", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ name: `image-${index}.png`, size: DEFAULT_INSCRIBE_FILE_MAX_BYTES }));
    const maxRequestBytes = 1_000_000;
    const batches = splitInscribeFilesIntoBatches(files, maxRequestBytes);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(files);
    expect(batches.every(batch => batch.length > 0 && estimateInscribeRequestBytes(batch) <= maxRequestBytes && batch.length <= 100)).toBe(true);
    expect(DEFAULT_INSCRIBE_BATCH_MAX_BYTES).toBeGreaterThan(maxRequestBytes);
  });

  it("rejects more than the advertised per-inscription file limit", () => {
    const files = Array.from({ length: 101 }, (_, index) => ({ name: `file-${index}.txt`, size: 1 }));
    expect(() => splitInscribeFilesIntoBatches(files)).toThrow("100");
  });

  it("rejects files that exceed the UniSat per-file limit", () => {
    expect(() => splitInscribeFilesIntoBatches([{ name: "large.png", size: DEFAULT_INSCRIBE_FILE_MAX_BYTES + 1 }])).toThrow("octets");
  });
});
