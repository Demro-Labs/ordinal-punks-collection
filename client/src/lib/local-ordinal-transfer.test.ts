import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOrdiWallet, type AddressType } from "@/lib/ordi-wallet";
import { buildOrdinalTransferPsbt, extractAndVerifySignedOrdinalTransaction } from "@/lib/ordinal-transfer-psbt";
import { fetchAddressOrdinals } from "@/lib/ordinals";
import { getSpendableUtxos } from "@/lib/mempool";
import { signLocalOrdinalTransfer, type LocalOrdinalPlan } from "@/lib/local-ordinal-transfer";

vi.mock("@/lib/ordinals", () => ({ fetchAddressOrdinals: vi.fn() }));
vi.mock("@/lib/mempool", () => ({ getSpendableUtxos: vi.fn() }));
const wallet = deriveOrdiWallet("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const network = "BITCOIN_MAINNET" as const;
const safeUtxo = (type: AddressType) => {
  const account = wallet.addresses[type];
  const tx = new bitcoin.Transaction();
  tx.addInput(Buffer.alloc(32, type === "taproot" ? 0x32 : 0x31), 0);
  const script = bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin);
  tx.addOutput(script, 100_000n);
  return { address: account.address, txid: tx.getId(), vout: 0, satoshi: 100_000, scriptPk: Buffer.from(script).toString("hex"), rawTxHex: tx.toHex(), height: 100, inscriptionsRunesAlkanesChecked: true as const, isLowFee: false, isOpInRBF: false, inscriptions: [] as [] };
};
function fixture(type: AddressType): { local: LocalOrdinalPlan; feeUtxo: ReturnType<typeof safeUtxo>; item: { inscriptionId: string; inscriptionNumber: number; location: string; outputValue: number; contentType: string } } {
  const account = wallet.addresses[type];
  const script = bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin);
  const source = new bitcoin.Transaction();
  source.addInput(Buffer.alloc(32, 0x41), 0);
  source.addOutput(script, 1_000n);
  const inscriptionId = `${source.getId()}i0`;
  const item = { inscriptionId, inscriptionNumber: 1, location: `${source.getId()}:0:0`, outputValue: 1_000, contentType: "text/plain" };
  const feeUtxo = safeUtxo(type);
  const plan = buildOrdinalTransferPsbt({
    selectedInscription: { inscriptionId, location: item.location },
    ownedInscriptions: [{ inscriptionId, location: item.location }],
    inscriptionPreviousTxHex: source.toHex(),
    spendableFeeUtxos: [{ txid: feeUtxo.txid, vout: feeUtxo.vout, rawTxHex: feeUtxo.rawTxHex, expectedScriptHex: feeUtxo.scriptPk, expectedValueSats: feeUtxo.satoshi }],
    publicKeyHex: account.publicKey,
    recipientScriptHex: Buffer.from(bitcoin.address.toOutputScript(wallet.addresses["native-segwit"].address, bitcoin.networks.bitcoin)).toString("hex"),
    changeScriptHex: Buffer.from(script).toString("hex"),
    feeRateSatVb: 2,
  });
  return { local: { network, addressType: type, address: account.address, recipient: wallet.addresses["native-segwit"].address, inscription: item, ownedInscriptions: [item], plan }, feeUtxo, item };
}

beforeEach(() => vi.clearAllMocks());
describe("Ordi Wallet local Ordinal signatures", () => {
  it.each(["legacy", "nested-segwit", "native-segwit", "taproot"] as AddressType[])("signs and verifies a reviewed %s Ordinal PSBT locally", async type => {
    const { local, feeUtxo, item } = fixture(type);
    vi.mocked(fetchAddressOrdinals).mockResolvedValue({ network, address: local.address, start: 0, total: 1, detail: [item], refreshedAt: new Date().toISOString() });
    vi.mocked(getSpendableUtxos).mockResolvedValue([feeUtxo]);
    const signed = await signLocalOrdinalTransfer(local, wallet);
    expect(signed.txid).toMatch(/^[a-f0-9]{64}$/);
    expect(extractAndVerifySignedOrdinalTransaction(signed.signedPsbtHex, local.plan)).toBe(signed.rawTxHex);
  });
  it("refuses to sign when live inscription ownership or location changes", async () => {
    const { local, feeUtxo, item } = fixture("native-segwit");
    vi.mocked(fetchAddressOrdinals).mockResolvedValue({ network, address: local.address, start: 0, total: 1, detail: [{ ...item, location: `${"ab".repeat(32)}:0:0` }], refreshedAt: new Date().toISOString() });
    vi.mocked(getSpendableUtxos).mockResolvedValue([feeUtxo]);
    await expect(signLocalOrdinalTransfer(local, wallet)).rejects.toThrow(/a changé depuis la revue/i);
  });
  it("refuses to sign if the address index response is incomplete", async () => {
    const { local, feeUtxo, item } = fixture("native-segwit");
    vi.mocked(fetchAddressOrdinals).mockResolvedValue({ network, address: local.address, start: 0, total: 2, detail: [item], refreshedAt: new Date().toISOString() });
    vi.mocked(getSpendableUtxos).mockResolvedValue([feeUtxo]);
    await expect(signLocalOrdinalTransfer(local, wallet)).rejects.toThrow(/pas retourné toutes les inscriptions/i);
  });
});
