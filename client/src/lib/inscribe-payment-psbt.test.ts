import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getMempoolConfig: vi.fn(), getSpendableUtxos: vi.fn() }));
vi.mock("@/lib/mempool", () => ({ getMempoolConfig: mocks.getMempoolConfig, getSpendableUtxos: mocks.getSpendableUtxos }));

import {
  broadcastSignedInscribePayment,
  getInscribePaymentSignOptions,
  InscribePaymentBroadcastUnclearError,
  prepareInscribePaymentPsbt,
} from "./inscribe-payment-psbt";

bitcoin.initEccLib(ecc);
const PRIVATE_KEY = Buffer.alloc(32);
PRIVATE_KEY[31] = 1;
const PUBLIC_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBLIC_KEY = Buffer.from(PUBLIC_KEY_HEX, "hex");
const SIGNER = { publicKey: PUBLIC_KEY, sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, PRIVATE_KEY)) };
const NETWORK = bitcoin.networks.bitcoin;
const WALLET_PAYMENT = bitcoin.payments.p2wpkh({ pubkey: PUBLIC_KEY, network: NETWORK });
const WALLET_SCRIPT = Buffer.from(WALLET_PAYMENT.output!);
const WALLET_ADDRESS = bitcoin.address.fromOutputScript(WALLET_SCRIPT, NETWORK);
const PAYMENT_PRIVATE_KEY = Buffer.alloc(32);
PAYMENT_PRIVATE_KEY[31] = 2;
const PAYMENT_PUBLIC_KEY = Buffer.from(ecc.pointFromScalar(PAYMENT_PRIVATE_KEY, true)!);
const PAYMENT_PAYMENT = bitcoin.payments.p2wpkh({ pubkey: PAYMENT_PUBLIC_KEY, network: NETWORK });
const PAYMENT_SCRIPT = Buffer.from(PAYMENT_PAYMENT.output!);
const PAYMENT_ADDRESS = bitcoin.address.fromOutputScript(PAYMENT_SCRIPT, NETWORK);
const MEMPOOL_API = "https://mempool.space";

function createPreviousOutput(value: number) {
  const transaction = new bitcoin.Transaction();
  transaction.addInput(Buffer.alloc(32, 7), 0xffffffff);
  transaction.addOutput(WALLET_SCRIPT, BigInt(value));
  return { txid: transaction.getId(), rawTxHex: transaction.toHex() };
}
function makeUtxo(value: number) {
  const previous = createPreviousOutput(value);
  return { address: WALLET_ADDRESS, txid: previous.txid, vout: 0, satoshi: value, scriptPk: WALLET_SCRIPT.toString("hex"), height: 100, inscriptionsRunesAlkanesChecked: true as const, isLowFee: false, isOpInRBF: false, inscriptions: [] as [] };
}

function setup(options: { utxoValue?: number; broadcastResponse?: string } = {}) {
  const value = options.utxoValue ?? 100_000;
  const utxo = makeUtxo(value);
  const prev = bitcoin.Transaction.fromHex(createPreviousOutput(value).rawTxHex);
  const addressScripts = new Map([[WALLET_ADDRESS, WALLET_SCRIPT.toString("hex")], [PAYMENT_ADDRESS, PAYMENT_SCRIPT.toString("hex")]]);
  let broadcasts = 0;
  mocks.getMempoolConfig.mockReturnValue({ api: MEMPOOL_API, explorer: `${MEMPOOL_API}/tx/`, label: "Bitcoin" });
  mocks.getSpendableUtxos.mockResolvedValue([utxo]);
  vi.stubGlobal("window", { setTimeout: (cb: (...args: unknown[]) => void, delay?: number) => setTimeout(cb, delay), clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) });
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(`${MEMPOOL_API}/api/v1/validate-address/`)) {
      const address = decodeURIComponent(url.split("/").at(-1)!);
      return Response.json({ isvalid: true, address, scriptPubKey: addressScripts.get(address) });
    }
    if (url === `${MEMPOOL_API}/api/tx/${utxo.txid}/hex`) return new Response(prev.toHex());
    if (url === `${MEMPOOL_API}/api/tx` && init.method === "POST") {
      broadcasts += 1;
      const tx = bitcoin.Transaction.fromHex(String(init.body));
      return new Response(options.broadcastResponse ?? tx.getId());
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  }) as typeof fetch);
  const provider = {
    getAccounts: async () => [WALLET_ADDRESS],
    getChain: async () => ({ enum: "BITCOIN_MAINNET" }),
    getPublicKey: async () => PUBLIC_KEY_HEX,
  };
  return { provider, getBroadcasts: () => broadcasts, utxo };
}

async function prepare(fixture: ReturnType<typeof setup>) {
  return prepareInscribePaymentPsbt({ network: "BITCOIN_MAINNET", walletAddress: WALLET_ADDRESS, paymentAddress: PAYMENT_ADDRESS, paymentSats: 10_000, feeRateSatVb: 2, publicKeyHex: PUBLIC_KEY_HEX });
}

async function sign(psbtHex: string) {
  const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
  psbt.signAllInputs(SIGNER);
  return psbt.toHex();
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("mobile inscription payment PSBT", () => {
  it("prepares the exact payment + change, asks UniSat to sign on click, verifies, then broadcasts once", async () => {
    const fixture = setup();
    const plan = await prepare(fixture);
    expect(plan.outputs[0]).toMatchObject({ role: "payment", valueSats: 10_000, scriptHex: PAYMENT_SCRIPT.toString("hex") });
    expect(plan.feeSats).toBeGreaterThan(0);
    expect(plan.outputs[1]?.role).toBe("change");
    expect(plan.totalInputSats - plan.outputs.reduce((sum, output) => sum + output.valueSats, 0)).toBe(plan.feeSats);
    const signedPsbtHex = await sign(plan.psbtHex);
    const result = await broadcastSignedInscribePayment({ signedPsbtHex, plan, provider: fixture.provider });
    expect(result.txid).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.getBroadcasts()).toBe(1);
    expect(getInscribePaymentSignOptions(plan, WALLET_ADDRESS).toSignInputs).toEqual([{ index: 0, address: WALLET_ADDRESS }]);
  });

  it("never broadcasts if the user-signed PSBT changes the receipt amount", async () => {
    const fixture = setup();
    const plan = await prepare(fixture);
    // Mutate the unsigned transaction inside the PSBT before signing; post-sign edits are refused too.
    const alteredBytes = Buffer.from(plan.psbtHex, "hex");
    const expectedAmount = Buffer.from("1027000000000000", "hex");
    const amountIndex = alteredBytes.indexOf(expectedAmount);
    expect(amountIndex).toBeGreaterThanOrEqual(0);
    Buffer.from("0f27000000000000", "hex").copy(alteredBytes, amountIndex);
    const alteredSigned = await sign(alteredBytes.toString("hex"));
    await expect(broadcastSignedInscribePayment({ signedPsbtHex: alteredSigned, plan, provider: fixture.provider })).rejects.toThrow(/modifié|plan exact|signature|frais/i);
    expect(fixture.getBroadcasts()).toBe(0);
  });

  it("never broadcasts with a changed UniSat account or network", async () => {
    const fixture = setup();
    const plan = await prepare(fixture);
    const signedPsbtHex = await sign(plan.psbtHex);
    await expect(broadcastSignedInscribePayment({ signedPsbtHex, plan, provider: { ...fixture.provider, getChain: async () => ({ enum: "FRACTAL_BITCOIN_MAINNET" }) } })).rejects.toThrow(/compte, la clé ou le réseau/i);
    expect(fixture.getBroadcasts()).toBe(0);
  });

  it("treats a lost broadcast response as ambiguous and provides the expected TXID for safe lookup", async () => {
    const fixture = setup({ broadcastResponse: "wrong-txid" });
    const plan = await prepare(fixture);
    const signedPsbtHex = await sign(plan.psbtHex);
    await expect(broadcastSignedInscribePayment({ signedPsbtHex, plan, provider: fixture.provider })).rejects.toBeInstanceOf(InscribePaymentBroadcastUnclearError);
    expect(fixture.getBroadcasts()).toBe(1);
  });

  it("fails closed when the previous transaction does not match the safe UTXO metadata", async () => {
    const fixture = setup();
    mocks.getSpendableUtxos.mockResolvedValue([{ ...fixture.utxo, satoshi: fixture.utxo.satoshi + 1 }]);
    await expect(prepare(fixture)).rejects.toThrow(/valeur ou le script/i);
    expect(fixture.getBroadcasts()).toBe(0);
  });
});


describe("mobile inscription late-sign safety", () => {
  it("does not broadcast a valid signature after the signing attempt has been invalidated", async () => {
    const fixture = setup();
    const plan = await prepare(fixture);
    const signedPsbtHex = await sign(plan.psbtHex);
    await expect(broadcastSignedInscribePayment({ signedPsbtHex, plan, provider: fixture.provider, isCurrentAttempt: () => false })).rejects.toThrow(/UNISAT_SIGNATURE_STALE/);
    expect(fixture.getBroadcasts()).toBe(0);
  });
});
