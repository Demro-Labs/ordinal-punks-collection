import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_DATA_API_BASE } from "@/lib/live";
import {
  assertProtocolAssetScanPassed,
  sendOrdinalInscriptionWithCustomPsbt,
  type UniSatCustomTransferProvider,
} from "./custom-ordinal-transfer";
import {
  RBF_SEQUENCE,
  type OrdinalTransferPlan,
  type PreviousOutputRef,
} from "./ordinal-transfer-psbt";

bitcoin.initEccLib(ecc);

const TEST_PRIVATE_KEY = Buffer.alloc(32);
TEST_PRIVATE_KEY[31] = 1;
const TEST_PUBLIC_KEY_HEX =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const TEST_PUBLIC_KEY = Buffer.from(TEST_PUBLIC_KEY_HEX, "hex");
const TEST_SIGNER = {
  publicKey: TEST_PUBLIC_KEY,
  sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, TEST_PRIVATE_KEY)),
};
const NETWORK = bitcoin.networks.bitcoin;
const PAYMENT = bitcoin.payments.p2wpkh({
  pubkey: TEST_PUBLIC_KEY,
  network: NETWORK,
});
const SCRIPT = Buffer.from(PAYMENT.output!);
const SCRIPT_HEX = SCRIPT.toString("hex");
const ADDRESS = bitcoin.address.fromOutputScript(SCRIPT, NETWORK);
const FRACTAL_NETWORK = "FRACTAL_BITCOIN_MAINNET";
const MEMPOOL_API = "https://mempool.fractalbitcoin.io";

function createPreviousOutput(
  script: Buffer,
  valueSats: number,
  marker: number
): PreviousOutputRef {
  const transaction = new bitcoin.Transaction();
  transaction.addInput(Buffer.alloc(32, marker), marker);
  transaction.addOutput(script, BigInt(valueSats));
  return {
    txid: transaction.getId(),
    vout: 0,
    rawTxHex: transaction.toHex(),
  };
}

function setupMocks() {
  const inscriptionUtxo = createPreviousOutput(SCRIPT, 600, 7);
  const feeUtxo = createPreviousOutput(SCRIPT, 100_000, 8);
  const rawTransactions = new Map([
    [inscriptionUtxo.txid, inscriptionUtxo.rawTxHex],
    [feeUtxo.txid, feeUtxo.rawTxHex],
  ]);
  let broadcastCount = 0;
  let broadcastSequences: number[] = [];

  vi.stubGlobal("window", {
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number) =>
      setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(`${LIVE_DATA_API_BASE}/api/spendable-utxos?`)) {
      const query = new URL(url).searchParams;
      expect(query.get("size")).toBe("25");
      const address = query.get("address");
      return Response.json({
        chain: "fractal",
        address,
        cursor: 0,
        nextCursor: 1,
        total: 1,
        scannedCount: 1,
        utxo: [
          {
            address,
            txid: feeUtxo.txid,
            vout: feeUtxo.vout,
            satoshi: 100_000,
            scriptPk: SCRIPT_HEX,
            height: 100,
            isLowFee: true,
            isOpInRBF: true,
            inscriptions: [],
            inscriptionsRunesAlkanesChecked: true,
          },
        ],
      });
    }
    if (url.startsWith(`${LIVE_DATA_API_BASE}/api/mempool/validate-address?`)) {
      expect(new URL(url).searchParams.get("chain")).toBe("FRACTAL_BITCOIN_MAINNET");
      return Response.json({ isvalid: true, scriptPubKey: SCRIPT_HEX });
    }
    if (url.startsWith(`${LIVE_DATA_API_BASE}/api/mempool/tx-hex?`)) {
      const txid = new URL(url).searchParams.get("txid")!;
      const rawTxHex = rawTransactions.get(txid);
      if (!rawTxHex) throw new Error(`Unexpected transaction ID: ${txid}`);
      return new Response(rawTxHex);
    }
    if (url.startsWith(`${LIVE_DATA_API_BASE}/api/mempool/tx?`) && init.method === "POST") {
      expect(new URL(url).searchParams.get("chain")).toBe("FRACTAL_BITCOIN_MAINNET");
      broadcastCount += 1;
      const transaction = bitcoin.Transaction.fromHex(String(init.body));
      broadcastSequences = transaction.ins.map(input => input.sequence);
      return Response.json({ network: FRACTAL_NETWORK, txid: transaction.getId() });
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  }) as typeof fetch);

  const provider: UniSatCustomTransferProvider = {
    getBitcoinUtxos: async () => ({
      list: [{ txid: feeUtxo.txid, vout: feeUtxo.vout }],
    }),
    getPublicKey: async () => TEST_PUBLIC_KEY_HEX,
    getAccounts: async () => [ADDRESS],
    getChain: async () => ({ enum: FRACTAL_NETWORK }),
    signPsbt: async psbtHex => {
      const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
      psbt.signAllInputs(TEST_SIGNER);
      return psbt.toHex();
    },
  };

  return {
    provider,
    inscription: {
      inscriptionId: `${inscriptionUtxo.txid}i0`,
      location: `${inscriptionUtxo.txid}:0:0`,
    },
    broadcastCount: () => broadcastCount,
    broadcastSequences: () => broadcastSequences,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("custom Ordinal transfer asset-scan attestation", () => {
  it("accepts only an explicit server-side protocol-asset verification marker", () => {
    expect(() => assertProtocolAssetScanPassed({ inscriptionsRunesAlkanesChecked: true })).not.toThrow();
  });

  it.each([
    undefined,
    null,
    {},
    { inscriptionsRunesAlkanesChecked: false },
    { inscriptionsRunesAlkanesChecked: "true" },
  ])("fails closed when the asset scan is missing or unverified", value => {
    expect(() => assertProtocolAssetScanPassed(value)).toThrow(
      /did not verify inscriptions, Runes, and Alkanes/i
    );
  });
});

describe("Fractal mobile PSBT workflow", () => {
  it("uses a PSBT signed by the explicit review click without requesting a second signature", async () => {
    const fixture = setupMocks();
    const signPsbt = vi.fn(async (psbtHex: string) => {
      const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
      psbt.signAllInputs(TEST_SIGNER);
      return psbt.toHex();
    });
    const provider: UniSatCustomTransferProvider = { ...fixture.provider, signPsbt };

    const result = await sendOrdinalInscriptionWithCustomPsbt({
      provider,
      mempool: { api: MEMPOOL_API, label: "Fractal Bitcoin", chain: "fractal" },
      expectedNetworkEnum: FRACTAL_NETWORK,
      currentAddress: ADDRESS,
      recipientAddress: ADDRESS,
      selectedInscription: fixture.inscription,
      ownedInscriptions: [fixture.inscription],
      feeRateSatVb: 2,
      beforeSign: async plan => signPsbt(plan.psbtHex),
    });

    expect(signPsbt).toHaveBeenCalledTimes(1);
    expect(fixture.broadcastCount()).toBe(1);
    expect(result.txid).toMatch(/^[a-f0-9]{64}$/i);
  });

  it("presents the exact plan before signing and broadcasts only a verified RBF-signaling transaction", async () => {
    const fixture = setupMocks();
    let reviewedPlan: OrdinalTransferPlan | undefined;
    let signPsbtCalled = false;
    const provider: UniSatCustomTransferProvider = {
      ...fixture.provider,
      signPsbt: async psbtHex => {
        signPsbtCalled = true;
        const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
        psbt.signAllInputs(TEST_SIGNER);
        return psbt.toHex();
      },
    };

    const result = await sendOrdinalInscriptionWithCustomPsbt({
      provider,
      mempool: { api: MEMPOOL_API, label: "Fractal Bitcoin", chain: "fractal" },
      expectedNetworkEnum: FRACTAL_NETWORK,
      currentAddress: ADDRESS,
      recipientAddress: ADDRESS,
      selectedInscription: fixture.inscription,
      ownedInscriptions: [fixture.inscription],
      feeRateSatVb: 2,
      beforeSign: async plan => {
        reviewedPlan = plan;
        return true;
      },
    });

    expect(reviewedPlan).toBeDefined();
    expect(reviewedPlan?.feeSats).toBeGreaterThan(0);
    expect(reviewedPlan?.inputSequence).toBe(RBF_SEQUENCE);
    expect(signPsbtCalled).toBe(true);
    expect(fixture.broadcastCount()).toBe(1);
    expect(fixture.broadcastSequences().every(sequence => sequence === RBF_SEQUENCE)).toBe(true);
    expect(result.txid).toMatch(/^[a-f0-9]{64}$/i);
  });

  it("does not sign or broadcast if the exact-fee review is declined", async () => {
    const fixture = setupMocks();
    let signPsbtCalled = false;
    const provider: UniSatCustomTransferProvider = {
      ...fixture.provider,
      signPsbt: async () => {
        signPsbtCalled = true;
        throw new Error("signPsbt must not be called after cancellation");
      },
    };

    await expect(sendOrdinalInscriptionWithCustomPsbt({
      provider,
      mempool: { api: MEMPOOL_API, label: "Fractal Bitcoin", chain: "fractal" },
      expectedNetworkEnum: FRACTAL_NETWORK,
      currentAddress: ADDRESS,
      recipientAddress: ADDRESS,
      selectedInscription: fixture.inscription,
      ownedInscriptions: [fixture.inscription],
      feeRateSatVb: 2,
      beforeSign: async () => false,
    })).rejects.toThrow(/cancelled before signing/i);

    expect(signPsbtCalled).toBe(false);
    expect(fixture.broadcastCount()).toBe(0);
  });
});
