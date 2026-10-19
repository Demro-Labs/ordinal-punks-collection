/**
 * Shared fail-closed preflight rules for future protocol-specific Local Vault builders.
 * This module does not build or authorize a transaction by itself.
 */
export type ProtocolUtxo = {
  txid: string;
  vout: number;
  valueSats: number;
  confirmations: number;
  address: string;
  scriptHex: string;
  inscriptions: string[];
  runes: Array<{ id: string; amount: string }>;
  alkanes: Array<{ id: string; amount: string }>;
};

const validTxid = (value: string) => /^[a-f0-9]{64}$/i.test(value);
const validScript = (value: string) => /^(?:[a-f0-9]{2})+$/i.test(value);
const outpoint = (utxo: Pick<ProtocolUtxo, "txid" | "vout">) => `${utxo.txid.toLowerCase()}:${utxo.vout}`;

function validateSnapshot(items: ProtocolUtxo[], options: { complete: boolean; address: string; maxItems?: number }) {
  if (!options.complete) throw new Error("Protocol UTXO index is incomplete; local signing is blocked.");
  if (!options.address.trim()) throw new Error("A source address is required.");
  const maxItems = options.maxItems ?? 500;
  if (!Array.isArray(items) || items.length > maxItems) throw new Error("Protocol UTXO snapshot exceeds the safe limit.");
  const seen = new Set<string>();
  for (const item of items) {
    if (!validTxid(item.txid) || !Number.isSafeInteger(item.vout) || item.vout < 0 ||
      !Number.isSafeInteger(item.valueSats) || item.valueSats <= 0 ||
      !Number.isSafeInteger(item.confirmations) || item.confirmations < 1 ||
      item.address !== options.address || !validScript(item.scriptHex) ||
      !Array.isArray(item.inscriptions) || !Array.isArray(item.runes) || !Array.isArray(item.alkanes)) {
      throw new Error("A protocol UTXO is malformed, unconfirmed, or belongs to another source address.");
    }
    const key = outpoint(item);
    if (seen.has(key)) throw new Error("Protocol UTXO snapshot contains a duplicate outpoint.");
    seen.add(key);
  }
  return items;
}

/** Select fee inputs only when the index confirms they carry no Ordinals or protocol assets. */
export function assertProtocolSafeFeeUtxos(items: ProtocolUtxo[], options: { complete: boolean; address: string }) {
  const snapshot = validateSnapshot(items, options);
  if (snapshot.some(item => item.inscriptions.length || item.runes.length || item.alkanes.length)) {
    throw new Error("Fee inputs must be confirmed, asset-free UTXOs; an Ordinal, Rune, or Alkane was detected.");
  }
  return snapshot;
}

/** Validate an Alkane input set against a complete index and the exact expected base-unit balance. */
export function assertExactAlkaneUtxos(
  items: ProtocolUtxo[],
  options: { complete: boolean; address: string; alkaneId: string; expectedAmount: string },
) {
  const snapshot = validateSnapshot(items, options);
  if (!/^\d{1,20}:\d{1,20}$/.test(options.alkaneId) || !/^\d{1,80}$/.test(options.expectedAmount) || BigInt(options.expectedAmount) <= 0n) {
    throw new Error("Alkane ID or expected base-unit balance is invalid.");
  }
  let total = 0n;
  for (const item of snapshot) {
    if (item.inscriptions.length || item.runes.length || item.alkanes.length !== 1 ||
      item.alkanes[0].id !== options.alkaneId || !/^\d{1,80}$/.test(item.alkanes[0].amount) ||
      BigInt(item.alkanes[0].amount) <= 0n) {
      throw new Error("Alkane inputs must contain only the selected Alkane and no inscriptions, Runes, or other Alkanes.");
    }
    total += BigInt(item.alkanes[0].amount);
  }
  if (total !== BigInt(options.expectedAmount)) {
    throw new Error("Alkane index balance and selected UTXO sum disagree; local signing is blocked.");
  }
  return snapshot;
}
