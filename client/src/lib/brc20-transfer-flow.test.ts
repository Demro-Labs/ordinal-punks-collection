import { describe, expect, it } from "vitest";
import {
  buildBrc20TransferInscription,
  getBrc20TransferNextAction,
  getBrc20TransferStorageKey,
  isConsistentBrc20PaymentState,
  parseBrc20TransferProgress,
  type Brc20TransferIdentity,
  type Brc20TransferProgress,
} from "./brc20-transfer-flow";

const identity: Brc20TransferIdentity = {
  site: "punks",
  address: "bc1qwallet",
  network: "BITCOIN_MAINNET",
  ticker: "ordi",
  kind: "classic",
};
const progress: Brc20TransferProgress = {
  version: 1,
  ...identity,
  amount: "12.5",
  recipient: "bc1qrecipient",
  orderId: "order-123",
  payAddress: "bc1qpay",
  payAmount: 1234,
  feeRate: 4,
  paymentStarted: false,
  paymentTxid: "",
  inscriptionId: "",
  transferStarted: false,
  transferTxid: "",
};

describe("BRC-20 transfer flow", () => {
  it("builds the standard transfer inscription payload for the selected amount", () => {
    expect(buildBrc20TransferInscription("ordi", "12.5")).toBe(
      '{"p":"brc-20","op":"transfer","tick":"ordi","amt":"12.5"}',
    );
  });

  it("creates a draft key isolated by site, wallet, network, kind, and ticker", () => {
    const key = getBrc20TransferStorageKey(identity);
    expect(key).toContain("BITCOIN_MAINNET");
    expect(getBrc20TransferStorageKey({ ...identity, network: "FRACTAL_BITCOIN_MAINNET" })).not.toBe(key);
    expect(getBrc20TransferStorageKey({ ...identity, address: "bc1qother" })).not.toBe(key);
  });

  it("advances through prepare, pay, confirm inscription, send, and complete as separate actions", () => {
    expect(getBrc20TransferNextAction(null)).toBe("prepare");
    expect(getBrc20TransferNextAction(progress)).toBe("pay");
    expect(getBrc20TransferNextAction({ ...progress, paymentStarted: true })).toBe("check-order");
    expect(getBrc20TransferNextAction({ ...progress, paymentTxid: "a".repeat(64) })).toBe("check-order");
    expect(getBrc20TransferNextAction({ ...progress, inscriptionId: `${"b".repeat(64)}i0` })).toBe("send-inscription");
    expect(getBrc20TransferNextAction({ ...progress, transferStarted: true })).toBe("verify-transfer");
    expect(getBrc20TransferNextAction({ ...progress, transferTxid: "c".repeat(64) })).toBe("complete");
  });

  it("restores only valid progress belonging to the exact site, wallet and network", () => {
    const raw = JSON.stringify({ ...progress, paymentStarted: true, paymentTxid: "a".repeat(64), inscriptionId: `${"b".repeat(64)}i12` });
    expect(parseBrc20TransferProgress(raw, identity)).toMatchObject({
      orderId: "order-123",
      paymentTxid: "a".repeat(64),
      inscriptionId: `${"b".repeat(64)}i12`,
    });
    expect(parseBrc20TransferProgress(raw, { ...identity, network: "FRACTAL_BITCOIN_MAINNET" })).toBeNull();
    expect(parseBrc20TransferProgress(raw, { ...identity, address: "bc1qother" })).toBeNull();
  });

  it("validates Local Vault payment state before restoring a saved order", () => {
    expect(isConsistentBrc20PaymentState({ paymentStarted: false, paymentTxid: "", inscriptionId: "" })).toBe(true);
    expect(isConsistentBrc20PaymentState({ paymentStarted: true, paymentTxid: "a".repeat(64), inscriptionId: "" })).toBe(true);
    expect(isConsistentBrc20PaymentState({ paymentStarted: true, paymentTxid: "a".repeat(64), inscriptionId: `${"b".repeat(64)}i0` })).toBe(true);
    expect(isConsistentBrc20PaymentState({ paymentStarted: false, paymentTxid: "a".repeat(64), inscriptionId: "" })).toBe(false);
    expect(isConsistentBrc20PaymentState({ paymentStarted: false, paymentTxid: "", inscriptionId: `${"b".repeat(64)}i0` })).toBe(false);
    expect(isConsistentBrc20PaymentState({ paymentStarted: true, paymentTxid: "bad", inscriptionId: "" })).toBe(false);
  });

  it("rejects corrupted or unsafe progress instead of allowing another payment", () => {
    expect(parseBrc20TransferProgress("not-json", identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, payAmount: 0 }), identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, paymentTxid: "bad" }), identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, paymentTxid: "a".repeat(64) }), identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, inscriptionId: `${"b".repeat(64)}i0` }), identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, transferStarted: true }), identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, transferTxid: "c".repeat(64) }), identity)).toBeNull();
    expect(parseBrc20TransferProgress(JSON.stringify({ ...progress, paymentStarted: true, inscriptionId: `${"b".repeat(64)}i0`, transferStarted: true, transferTxid: "c".repeat(64) }), identity)).not.toBeNull();
  });
});
