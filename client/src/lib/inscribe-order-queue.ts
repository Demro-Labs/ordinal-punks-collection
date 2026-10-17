export type InscribeOrderQueueEntry = {
  fileIndexes: number[];
  status: "awaiting-payment" | "payment-review" | "payment-sent" | "completed" | "cancelled";
  amount: number;
};

/**
 * Returns file indexes that do not have an active or completed UniSat order.
 * Cancelled batches are deliberately eligible for a fresh receipt.
 */
export function getUnpreparedInscribeFileIndexes(fileCount: number, orders: InscribeOrderQueueEntry[]) {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) throw new Error("Le nombre de fichiers est invalide.");
  const covered = new Set<number>();
  for (const order of orders) {
    if (order.status === "cancelled") continue;
    for (const index of order.fileIndexes) {
      if (Number.isSafeInteger(index) && index >= 0 && index < fileCount) covered.add(index);
    }
  }
  return Array.from({ length: fileCount }, (_, index) => index).filter(index => !covered.has(index));
}

export function getInscribeOrderTotalSats(orders: Array<{ amount: number }>) {
  const total = orders.reduce((sum, order) => {
    if (!Number.isSafeInteger(order.amount) || order.amount < 0 || !Number.isSafeInteger(sum + order.amount)) {
      throw new Error("Le total des reçus UniSat dépasse la plage sûre des sats.");
    }
    return sum + order.amount;
  }, 0);
  return total;
}
