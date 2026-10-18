import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { deriveOrdiWallet } from "./ordi-wallet";
import { broadcastLocalPsbt, finalizeLocalPsbt, reviewLocalPsbt, signLocalPsbt } from "./local-psbt-signer";
import { getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";

vi.mock("@/lib/mempool", () => ({
  getSpendableUtxos: vi.fn(),
  validateMempoolAddress: vi.fn(),
  getMempoolConfig: vi.fn(() => ({ api: "https://mempool.space", explorer: "https://mempool.space/tx/", label: "Bitcoin" })),
}));

bitcoin.initEccLib(ecc);
const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = deriveOrdiWallet(phrase);
const recipientWallet = deriveOrdiWallet(phrase, "recipient-test");
const network = "BITCOIN_MAINNET" as const;
const txid = "12".repeat(32);
const ownAddress = wallet.addresses["native-segwit"].address;
const ownScript = bitcoin.address.toOutputScript(ownAddress, bitcoin.networks.bitcoin);
const ownScriptHex = Buffer.from(ownScript).toString("hex");

function makePsbt(outputScript?: Uint8Array) {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  psbt.addInput({ hash: txid, index: 0, witnessUtxo: { script: ownScript, value: 10_000n } });
  if (outputScript) psbt.addOutput({ script: Buffer.from(outputScript), value: 9_000n });
  else psbt.addOutput({ address: recipientWallet.addresses["native-segwit"].address, value: 8_000n });
  return psbt.toHex();
}
function safeUtxo(overrides: Record<string, unknown> = {}) {
  return { address: ownAddress, txid, vout: 0, satoshi: 10_000, scriptPk: ownScriptHex, height: 100, inscriptionsRunesAlkanesChecked: true as const, isLowFee: false, isOpInRBF: false, inscriptions: [] as [] , ...overrides };
}

beforeEach(() => {
  vi.mocked(getSpendableUtxos).mockResolvedValue([safeUtxo()]);
  vi.mocked(validateMempoolAddress).mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("Local Vault plain BTC PSBT signer", () => {
  it("rechecks the exact confirmed asset-free inputs and completes local sign/finalize", async () => {
    const hex = makePsbt();
    const review = await reviewLocalPsbt(hex, wallet, network);
    expect(review).toMatchObject({ network, inputCount: 1, outputCount: 1, inputSats: 10_000, outputSats: 8_000, feeSats: 2_000 });
    expect(getSpendableUtxos).toHaveBeenCalledWith(network, ownAddress, 10_000, { requiredOutpoints: [`${txid}:0`] });
    const signed = await signLocalPsbt(hex, wallet, review);
    const tx = await finalizeLocalPsbt(signed, wallet, review);
    expect(tx.txid).toMatch(/^[a-f0-9]{64}$/);
    expect(tx.rawTxHex).toMatch(/^[a-f0-9]+$/);
  });

  it("fails closed when a PSBT invents a witness UTXO not found by the live safe-UTXO index", async () => {
    vi.mocked(getSpendableUtxos).mockResolvedValue([]);
    await expect(reviewLocalPsbt(makePsbt(), wallet, network)).rejects.toThrow(/confirmed, asset-free UTXO/i);
  });

  it("rejects protocol/non-address outputs instead of treating them as ordinary BTC payments", async () => {
    const psbt = makePsbt(Buffer.from("6a01ff", "hex"));
    await expect(reviewLocalPsbt(psbt, wallet, network)).rejects.toThrow(/dust|OP_RETURN/i);
  });

  it("refuses to broadcast if the live exact inputs are no longer verified", async () => {
    const review = await reviewLocalPsbt(makePsbt(), wallet, network);
    const signed = await signLocalPsbt(makePsbt(), wallet, review);
    const tx = await finalizeLocalPsbt(signed, wallet, review);
    vi.mocked(getSpendableUtxos).mockResolvedValue([]);
    await expect(broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review)).rejects.toThrow(/confirmed, asset-free UTXO/i);
  });
});
