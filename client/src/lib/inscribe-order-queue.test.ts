import { describe, expect, it } from "vitest";
import { getInscribeOrderTotalSats, getUnpreparedInscribeFileIndexes, type InscribeOrderQueueEntry } from "./inscribe-order-queue";

const order = (fileIndexes: number[], status: InscribeOrderQueueEntry["status"], amount = 10): InscribeOrderQueueEntry => ({ fileIndexes, status, amount });

describe("prepared UniSat order queue", () => {
  it("marks active and completed file batches as covered", () => {
    expect(getUnpreparedInscribeFileIndexes(6, [order([0, 1], "completed"), order([2, 3], "awaiting-payment")])).toEqual([4, 5]);
  });

  it("makes cancelled and never-prepared files eligible for a new receipt", () => {
    expect(getUnpreparedInscribeFileIndexes(6, [order([0, 1], "completed"), order([2, 3], "cancelled"), order([4], "payment-sent")])).toEqual([2, 3, 5]);
  });

  it("sums the quoted order amounts safely", () => {
    expect(getInscribeOrderTotalSats([{ amount: 25 }, { amount: 75 }])).toBe(100);
    expect(() => getInscribeOrderTotalSats([{ amount: Number.MAX_SAFE_INTEGER }, { amount: 1 }])).toThrow("plage sûre");
  });

  it("rejects invalid selected-file counts", () => {
    expect(() => getUnpreparedInscribeFileIndexes(-1, [])).toThrow("invalide");
  });
});
