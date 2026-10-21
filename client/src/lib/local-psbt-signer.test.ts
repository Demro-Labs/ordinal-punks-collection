import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { deriveOrdiWallet, type AddressType } from "./ordi-wallet";
import { broadcastLocalPsbt, finalizeLocalPsbt, reviewLocalPsbt, signLocalPsbt } from "./local-psbt-signer";
import { confirmSpendableUtxos, getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";

vi.mock("@/lib/mempool", () => ({
  confirmSpendableUtxos: vi.fn(),
  getSpendableUtxos: vi.fn(),
  validateMempoolAddress: vi.fn(),
  getMempoolConfig: vi.fn(() => ({ api: "https://mempool.space", explorer: "https://mempool.space/tx/", label: "Bitcoin" })),
}));

bitcoin.initEccLib(ecc);
const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = deriveOrdiWallet(phrase);
const recipientWallet = deriveOrdiWallet(phrase, "recipient-test");
const network = "BITCOIN_MAINNET" as const;
const nativeAccount = wallet.addresses["native-segwit"];
const nativeScript = bitcoin.address.toOutputScript(nativeAccount.address, bitcoin.networks.bitcoin);
const nativeScriptHex = Buffer.from(nativeScript).toString("hex");

function makeLegacyPreviousTx(script: Uint8Array) {
  const previous = new bitcoin.Transaction();
  previous.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0]));
  previous.addOutput(Buffer.from(script), 10_000n);
  return previous;
}

function makePsbt(type: AddressType = "native-segwit", outputScript?: Uint8Array) {
  const account = wallet.addresses[type];
  const ownScript = bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin);
  const ownScriptHex = Buffer.from(ownScript).toString("hex");
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  let txid = "12".repeat(32);
  let utxoProof: Record<string, unknown>;
  if (type === "legacy") {
    const previous = makeLegacyPreviousTx(ownScript);
    txid = previous.getId();
    utxoProof = { nonWitnessUtxo: Buffer.from(previous.toHex(), "hex") };
  } else {
    utxoProof = { witnessUtxo: { script: ownScript, value: 10_000n } };
    if (type === "nested-segwit") {
      utxoProof.redeemScript = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(account.publicKey, "hex"), network: bitcoin.networks.bitcoin }).output!;
    }
    if (type === "taproot") utxoProof.tapInternalKey = Buffer.from(ecc.xOnlyPointFromPoint(Buffer.from(account.publicKey, "hex")));
  }
  psbt.addInput({ hash: txid, index: 0, ...utxoProof } as bitcoin.PsbtInput);
  if (outputScript) psbt.addOutput({ script: Buffer.from(outputScript), value: 9_000n });
  else psbt.addOutput({ address: recipientWallet.addresses["native-segwit"].address, value: 8_000n });
  const utxo = { address: account.address, txid, vout: 0, satoshi: 10_000, scriptPk: ownScriptHex, height: 100, inscriptionsRunesAlkanesChecked: true as const, isLowFee: false, isOpInRBF: false, inscriptions: [] as [] };
  return { hex: psbt.toHex(), utxo, account };
}

beforeEach(() => {
  vi.mocked(getSpendableUtxos).mockResolvedValue([{ address: nativeAccount.address, txid: "12".repeat(32), vout: 0, satoshi: 10_000, scriptPk: nativeScriptHex, height: 100, inscriptionsRunesAlkanesChecked: true, isLowFee: false, isOpInRBF: false, inscriptions: [] }]);
  vi.mocked(confirmSpendableUtxos).mockImplementation(async (network, address, minimumSats, utxos) => ({
    chain: network === "BITCOIN_MAINNET" ? "bitcoin" : "fractal",
    address,
    minimumSats,
    safeSats: utxos.reduce((sum, utxo) => sum + utxo.satoshi, 0),
    sufficient: true,
    verifiedUtxoCount: utxos.length,
    confirmedAt: new Date().toISOString(),
  }));
  vi.mocked(validateMempoolAddress).mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("Local Vault BTC/FB PSBT signer", () => {
  it.each(["legacy", "nested-segwit", "native-segwit", "taproot"] as AddressType[])("rechecks exact asset-free outpoints and signs/finalizes %s", async type => {
    const prepared = makePsbt(type);
    vi.mocked(getSpendableUtxos).mockResolvedValue([prepared.utxo]);
    const review = await reviewLocalPsbt(prepared.hex, wallet, network);
    expect(review).toMatchObject({ network, addressType: type, sourceAddress: prepared.account.address, inputCount: 1, outputCount: 1, inputSats: 10_000, outputSats: 8_000, feeSats: 2_000 });
    expect(getSpendableUtxos).toHaveBeenCalledWith(network, prepared.account.address, 10_000, { requiredOutpoints: [`${prepared.utxo.txid}:0`] });
    const signed = await signLocalPsbt(prepared.hex, wallet, review);
    const tx = await finalizeLocalPsbt(signed, wallet, review);
    expect(tx.txid).toMatch(/^[a-f0-9]{64}$/);
    expect(tx.rawTxHex).toMatch(/^[a-f0-9]+$/);
  });

  it("rejects a tampered signature before finalizing or broadcasting", async () => {
    const prepared = makePsbt();
    vi.mocked(getSpendableUtxos).mockResolvedValue([prepared.utxo]);
    const review = await reviewLocalPsbt(prepared.hex, wallet, network);
    const signed = await signLocalPsbt(prepared.hex, wallet, review);
    const tampered = bitcoin.Psbt.fromHex(signed);
    const signature = tampered.data.inputs[0].partialSig?.[0];
    expect(signature).toBeDefined();
    signature!.signature[0] ^= 1;
    await expect(finalizeLocalPsbt(tampered.toHex(), wallet, review)).rejects.toThrow(/signature locale est absente ou invalide/i);
  });

  it("fails closed when a PSBT invents an input absent from the live safe-UTXO index", async () => {
    vi.mocked(getSpendableUtxos).mockResolvedValue([]);
    await expect(reviewLocalPsbt(makePsbt().hex, wallet, network)).rejects.toThrow(/UTXO confirmé et sans actif/i);
  });

  it("rejects protocol/non-address outputs instead of treating them as ordinary BTC payments", async () => {
    await expect(reviewLocalPsbt(makePsbt("native-segwit", Buffer.from("6a01ff", "hex")).hex, wallet, network)).rejects.toThrow(/dust|OP_RETURN/i);
  });

  it("reports an uncertain broadcast outcome when the response body cannot be read", async () => {
    const prepared = makePsbt();
    vi.mocked(getSpendableUtxos).mockResolvedValue([prepared.utxo]);
    const review = await reviewLocalPsbt(prepared.hex, wallet, network);
    const signed = await signLocalPsbt(prepared.hex, wallet, review);
    const tx = await finalizeLocalPsbt(signed, wallet, review);
    vi.mocked(getSpendableUtxos).mockResolvedValue([prepared.utxo]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: vi.fn().mockRejectedValue(new Error("socket reset after submission")),
    }));
    await expect(broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review))
      .rejects.toThrow(new RegExp("Résultat de diffusion incertain.*" + tx.txid));
  });

  it("refuses broadcast when the exact confirmed asset-free input is no longer verified", async () => {
    const prepared = makePsbt();
    vi.mocked(getSpendableUtxos).mockResolvedValue([prepared.utxo]);
    const review = await reviewLocalPsbt(prepared.hex, wallet, network);
    const signed = await signLocalPsbt(prepared.hex, wallet, review);
    const tx = await finalizeLocalPsbt(signed, wallet, review);
    vi.mocked(getSpendableUtxos).mockResolvedValue([]);
    await expect(broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review)).rejects.toThrow(/UTXO confirmé et sans actif/i);
  });
});
