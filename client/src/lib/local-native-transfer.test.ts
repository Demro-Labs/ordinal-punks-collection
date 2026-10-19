import { beforeEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { deriveOrdiWallet, type AddressType, type OrdiNetwork } from "./ordi-wallet";
import { prepareLocalNativeTransfer } from "./local-native-transfer";
import { getMempoolRawTransaction, getRecommendedFeeEstimate, getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";

vi.mock("@/lib/mempool", () => ({
  getMempoolRawTransaction: vi.fn(),
  getRecommendedFeeEstimate: vi.fn(),
  getSpendableUtxos: vi.fn(),
  validateMempoolAddress: vi.fn(),
}));

bitcoin.initEccLib(ecc);
const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = deriveOrdiWallet(phrase);
const recipientWallet = deriveOrdiWallet(phrase, "native-transfer-recipient");
const addressTypes: AddressType[] = ["legacy", "nested-segwit", "native-segwit", "taproot"];

function previousTxFor(type: AddressType) {
  const account = wallet.addresses[type];
  const previous = new bitcoin.Transaction();
  previous.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0]));
  previous.addOutput(bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin), 100_000n);
  return previous;
}
function safeUtxo(type: AddressType) {
  const account = wallet.addresses[type];
  const previous = type === "legacy" ? previousTxFor(type) : null;
  return {
    address: account.address,
    txid: previous?.getId() ?? "ab".repeat(32),
    vout: 0,
    satoshi: 100_000,
    scriptPk: Buffer.from(bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin)).toString("hex"),
    height: 100,
    inscriptionsRunesAlkanesChecked: true as const,
    isLowFee: false,
    isOpInRBF: false,
    inscriptions: [] as [],
    previousTxHex: previous?.toHex() ?? null,
  };
}

beforeEach(() => {
  vi.mocked(getRecommendedFeeEstimate).mockResolvedValue({ network: "BITCOIN_MAINNET", target: "halfHour", feeRate: 2, strategy: "maximum-of-mempool-and-unisat", sources: { mempool: { feeRate: 1, available: true }, unisat: { feeRate: 2, available: true } }, sampledAt: new Date().toISOString() });
  vi.mocked(validateMempoolAddress).mockResolvedValue(undefined);
  vi.mocked(getMempoolRawTransaction).mockResolvedValue("");
});

describe("prepareLocalNativeTransfer", () => {
  it.each(["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"] as OrdiNetwork[])("builds a locally signable payment from all four address types on %s", async network => {
    for (const type of addressTypes) {
      const utxo = safeUtxo(type);
      vi.mocked(getSpendableUtxos).mockResolvedValue([utxo]);
      vi.mocked(getRecommendedFeeEstimate).mockResolvedValue({ network, target: "halfHour", feeRate: 2, strategy: "maximum-of-mempool-and-unisat", sources: { mempool: { feeRate: 1, available: true }, unisat: { feeRate: 2, available: true } }, sampledAt: new Date().toISOString() });
      if (utxo.previousTxHex) vi.mocked(getMempoolRawTransaction).mockResolvedValue(utxo.previousTxHex);
      const plan = await prepareLocalNativeTransfer(network, wallet, type, recipientWallet.addresses["native-segwit"].address, "0.0005");
      const psbt = bitcoin.Psbt.fromHex(plan.psbtHex, { network: bitcoin.networks.bitcoin });
      expect(plan).toMatchObject({ network, addressType: type, sourceAddress: wallet.addresses[type].address, amountSats: 50_000, feeRateSatVb: 2, changeSats: expect.any(Number) });
      expect(psbt.inputCount).toBe(1);
      expect(getSpendableUtxos).toHaveBeenLastCalledWith(network, wallet.addresses[type].address, expect.any(Number));
      if (type === "legacy") expect(psbt.data.inputs[0].nonWitnessUtxo).toBeDefined();
      if (type === "nested-segwit") expect(psbt.data.inputs[0].redeemScript).toBeDefined();
      if (type === "native-segwit") expect(psbt.data.inputs[0].witnessUtxo).toBeDefined();
      if (type === "taproot") expect(psbt.data.inputs[0].tapInternalKey).toHaveLength(32);
    }
  });

  it("fetches a parent transaction from the matching network for Legacy P2PKH", async () => {
    const utxo = safeUtxo("legacy");
    vi.mocked(getSpendableUtxos).mockResolvedValue([utxo]);
    vi.mocked(getMempoolRawTransaction).mockResolvedValue(utxo.previousTxHex!);
    await prepareLocalNativeTransfer("FRACTAL_BITCOIN_MAINNET", wallet, "legacy", recipientWallet.addresses["native-segwit"].address, "0.0005");
    expect(getMempoolRawTransaction).toHaveBeenCalledWith("FRACTAL_BITCOIN_MAINNET", utxo.txid);
  });

  it("rejects dust and never prepares a payment below the conservative relay threshold", async () => {
    await expect(prepareLocalNativeTransfer("BITCOIN_MAINNET", wallet, "native-segwit", recipientWallet.addresses["native-segwit"].address, "0.000001"))
      .rejects.toThrow(/546 sats/);
    expect(getSpendableUtxos).not.toHaveBeenCalled();
  });
});
