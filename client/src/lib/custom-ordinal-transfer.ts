import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import { LIVE_DATA_API_BASE } from "@/lib/live";
import {
  buildOrdinalTransferPsbt,
  extractAndVerifySignedOrdinalTransaction,
  type OrdinalLocation,
  type PreviousOutputRef,
} from "./ordinal-transfer-psbt";

const PAGE_SIZE = 50;
const MAX_UTXO_PAGES = 4;
const MAX_FEE_UTXOS_TO_INSPECT = 100;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_SPENDABLE_UTXO_SATS = 600;

type UniSatUtxoPage = unknown;

export interface UniSatCustomTransferProvider {
  getBitcoinUtxos: (cursor: number, size: number) => Promise<UniSatUtxoPage>;
  getPublicKey: () => Promise<string>;
  getAccounts: () => Promise<string[]>;
  getChain: () => Promise<{ enum?: string }>;
  signPsbt: (
    psbtHex: string,
    options?: {
      autoFinalized?: boolean;
      toSignInputs?: Array<{
        index: number;
        address?: string;
        publicKey?: string;
        useTweakedSigner?: boolean;
      }>;
    }
  ) => Promise<string>;
}

interface MempoolConfig {
  api: string;
  label: string;
  chain: "bitcoin" | "fractal";
}

interface UtxoOutpoint {
  txid: string;
  vout: number;
}

function parseUtxoPage(value: UniSatUtxoPage): UtxoOutpoint[] {
  const records = extractUtxoRecords(value);
  if (records) {
    const parsed = records.map(parseUtxoRecord);
    if (parsed.some(item => item === null))
      throw new Error("UniSat returned an invalid wallet UTXO page.");
    return parsed as UtxoOutpoint[];
  }
  const single = parseUtxoRecord(value);
  return single ? [single] : [];
}

function extractUtxoRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (object.data && typeof object.data === "object") {
    const nested = extractUtxoRecords(object.data);
    if (nested) return nested;
  }
  for (const field of ["list", "utxos", "utxo"]) {
    if (Array.isArray(object[field])) return object[field] as unknown[];
  }
  return null;
}

function parseUtxoRecord(value: unknown): UtxoOutpoint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const txid = typeof record.txid === "string" ? record.txid.toLowerCase() : "";
  const vout = Number(record.vout ?? record.outputIndex ?? record.idx);
  if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0)
    return null;
  return { txid, vout };
}

function parseLocation(location: string | undefined) {
  const match = location?.match(/^([a-f0-9]{64}):(\d+):(\d+)$/i);
  if (!match)
    throw new Error(
      "UniSat did not provide a valid inscription outpoint and sat offset."
    );
  return { txid: match[1].toLowerCase(), vout: Number(match[2]) };
}

function outpoint(txid: string, vout: number) {
  return `${txid.toLowerCase()}:${vout}`;
}

async function fetchText(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...init,
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok)
      throw new Error(`${response.status} ${body.slice(0, 180)}`);
    return body.trim();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function getValidatedScript(
  api: string,
  address: string,
  role: string,
  networkLabel: string
) {
  let localScriptHex: string;
  try {
    localScriptHex = Buffer.from(
      bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)
    ).toString("hex");
  } catch {
    throw new Error(
      `The ${role} address is not a supported Bitcoin/Fractal mainnet address.`
    );
  }
  const body = await fetchText(
    `${api}/api/v1/validate-address/${encodeURIComponent(address)}`
  );
  const result = JSON.parse(body) as {
    isvalid?: boolean;
    address?: string;
    scriptPubKey?: string;
  };
  const sameAddress =
    result.address === undefined ||
    result.address === address ||
    (address.toLowerCase().startsWith("bc1") &&
      result.address.toLowerCase() === address.toLowerCase());
  if (
    !result.isvalid ||
    typeof result.scriptPubKey !== "string" ||
    !/^(?:[a-f0-9]{2})+$/i.test(result.scriptPubKey) ||
    result.scriptPubKey.toLowerCase() !== localScriptHex ||
    !sameAddress
  ) {
    throw new Error(
      `The ${role} address or its ${networkLabel} script could not be validated consistently.`
    );
  }
  return localScriptHex;
}

async function loadIndexedSpendableRefs(
  chain: MempoolConfig["chain"],
  address: string
) {
  const refs = new Map<string, PreviousOutputRef>();
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < MAX_UTXO_PAGES; pageIndex += 1) {
    const url = new URL(`${LIVE_DATA_API_BASE}/api/spendable-utxos`);
    url.searchParams.set("chain", chain);
    url.searchParams.set("address", address);
    url.searchParams.set("cursor", String(cursor));
    url.searchParams.set("size", String(PAGE_SIZE));
    const page = JSON.parse(await fetchText(url.toString())) as {
      chain?: string;
      address?: string;
      cursor?: number;
      nextCursor?: number;
      total?: number;
      scannedCount?: number;
      utxo?: unknown[];
    };
    if (
      page.chain !== chain ||
      page.address !== address ||
      page.cursor !== cursor ||
      !Number.isSafeInteger(page.total) ||
      (page.total ?? -1) < 0 ||
      !Number.isSafeInteger(page.nextCursor) ||
      page.nextCursor !== cursor + (page.scannedCount ?? -1) ||
      (page.nextCursor ?? -1) > (page.total ?? -1) ||
      !Number.isSafeInteger(page.scannedCount) ||
      (page.scannedCount ?? -1) < 0 ||
      (page.scannedCount ?? PAGE_SIZE + 1) > PAGE_SIZE ||
      !Array.isArray(page.utxo) ||
      page.utxo.length > (page.scannedCount ?? 0) ||
      ((page.nextCursor ?? cursor) <= cursor && cursor < (page.total ?? cursor))
    ) {
      throw new Error(
        "The UniSat safe-UTXO service returned an invalid or incomplete page."
      );
    }
    for (const value of page.utxo) {
      if (!value || typeof value !== "object")
        throw new Error(
          "The UniSat safe-UTXO service returned an invalid UTXO."
        );
      const item = value as Record<string, unknown>;
      const txid = typeof item.txid === "string" ? item.txid.toLowerCase() : "";
      const vout = Number(item.vout);
      const valueSats = Number(item.satoshi);
      const scriptHex =
        typeof item.scriptPk === "string" ? item.scriptPk.toLowerCase() : "";
      if (
        item.address !== address ||
        !/^[a-f0-9]{64}$/.test(txid) ||
        !Number.isSafeInteger(vout) ||
        vout < 0 ||
        !Number.isSafeInteger(valueSats) ||
        valueSats < MIN_SPENDABLE_UTXO_SATS ||
        !/^(?:[a-f0-9]{2})+$/i.test(scriptHex) ||
        !Number.isSafeInteger(item.height) ||
        Number(item.height) <= 0 ||
        item.isLowFee === true ||
        item.isOpInRBF === true ||
        !Array.isArray(item.inscriptions) ||
        item.inscriptions.length !== 0
      ) {
        throw new Error(
          "UniSat's safe-UTXO response contained an unconfirmed, low-fee, asset-bearing, or malformed output; refusing to spend it."
        );
      }
      const key = outpoint(txid, vout);
      if (refs.has(key))
        throw new Error("UniSat's safe-UTXO response repeated an outpoint.");
      refs.set(key, {
        txid,
        vout,
        rawTxHex: "",
        expectedScriptHex: scriptHex,
        expectedValueSats: valueSats,
      });
    }
    cursor = page.nextCursor!;
    if (cursor >= page.total!) break;
  }
  return refs;
}

async function loadUtxoRefs(
  provider: UniSatCustomTransferProvider,
  ownedInscriptions: OrdinalLocation[],
  chain: MempoolConfig["chain"],
  currentAddress: string
) {
  const inscriptionOutpoints = new Set<string>();
  for (const inscription of ownedInscriptions) {
    const parsed = parseLocation(inscription.location);
    inscriptionOutpoints.add(outpoint(parsed.txid, parsed.vout));
  }

  const indexedRefs = await loadIndexedSpendableRefs(chain, currentAddress);
  const walletOutpoints = new Set<string>();
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < MAX_UTXO_PAGES; pageIndex += 1) {
    const page = parseUtxoPage(
      await provider.getBitcoinUtxos(cursor, PAGE_SIZE)
    );
    if (page.length === 0) break;
    for (const utxo of page)
      walletOutpoints.add(outpoint(utxo.txid, utxo.vout));
    cursor += page.length;
    if (page.length < PAGE_SIZE) break;
  }
  return Array.from(indexedRefs.entries())
    .filter(
      ([key]) => walletOutpoints.has(key) && !inscriptionOutpoints.has(key)
    )
    .map(([, ref]) => ref)
    .slice(0, MAX_FEE_UTXOS_TO_INSPECT);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  operation: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await operation(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function readRawTransaction(api: string, txid: string) {
  const hex = await fetchText(`${api}/api/tx/${encodeURIComponent(txid)}/hex`);
  if (!/^(?:[a-f0-9]{2})+$/i.test(hex))
    throw new Error("Mempool returned an invalid previous transaction.");
  const transaction = bitcoin.Transaction.fromHex(hex);
  if (transaction.getId().toLowerCase() !== txid.toLowerCase()) {
    throw new Error(
      "Mempool returned transaction bytes that do not match the requested UTXO."
    );
  }
  return hex;
}

async function assertWalletSession(
  provider: UniSatCustomTransferProvider,
  currentAddress: string,
  expectedNetworkEnum: string,
  publicKeyHex: string
) {
  const [chain, accounts, activePublicKey] = await Promise.all([
    provider.getChain(),
    provider.getAccounts(),
    provider.getPublicKey(),
  ]);
  if (chain.enum !== expectedNetworkEnum) {
    throw new Error(
      "UniSat's active network changed; the signed transaction was not broadcast."
    );
  }
  if (
    accounts.length === 0 ||
    accounts[0] !== currentAddress ||
    !accounts.includes(currentAddress)
  ) {
    throw new Error(
      "UniSat's active account changed; the signed transaction was not broadcast."
    );
  }
  if (activePublicKey.toLowerCase() !== publicKeyHex.toLowerCase()) {
    throw new Error(
      "UniSat's active public key changed; the signed transaction was not broadcast."
    );
  }
}

export async function sendOrdinalInscriptionWithCustomPsbt(params: {
  provider: UniSatCustomTransferProvider;
  mempool: MempoolConfig;
  expectedNetworkEnum: string;
  currentAddress: string;
  recipientAddress: string;
  selectedInscription: OrdinalLocation;
  ownedInscriptions: OrdinalLocation[];
  feeRateSatVb: number;
  beforeBroadcast?: (publicKeyHex: string) => Promise<void>;
}) {
  const {
    provider,
    mempool,
    expectedNetworkEnum,
    currentAddress,
    recipientAddress,
    selectedInscription,
    ownedInscriptions,
    feeRateSatVb,
  } = params;
  const location = parseLocation(selectedInscription.location);
  const recipientScriptHex = await getValidatedScript(
    mempool.api,
    recipientAddress,
    "recipient",
    mempool.label
  );
  const changeScriptHex = await getValidatedScript(
    mempool.api,
    currentAddress,
    "wallet",
    mempool.label
  );
  const refs = await loadUtxoRefs(
    provider,
    ownedInscriptions,
    mempool.chain,
    currentAddress
  );
  const allTxids = Array.from(
    new Set([location.txid, ...refs.map(ref => ref.txid)])
  );
  const rawTxEntries = await mapWithConcurrency(
    allTxids,
    8,
    async txid => [txid, await readRawTransaction(mempool.api, txid)] as const
  );
  const rawTxById = new Map(rawTxEntries);
  const feeUtxos = refs.map(ref => ({
    ...ref,
    rawTxHex: rawTxById.get(ref.txid) ?? "",
  }));
  const inscriptionPreviousTxHex = rawTxById.get(location.txid);
  if (!inscriptionPreviousTxHex)
    throw new Error(
      "Could not load the inscription's source transaction from Mempool."
    );

  const publicKeyHex = await provider.getPublicKey();
  await assertWalletSession(
    provider,
    currentAddress,
    expectedNetworkEnum,
    publicKeyHex
  );
  const plan = buildOrdinalTransferPsbt({
    selectedInscription,
    ownedInscriptions,
    inscriptionPreviousTxHex,
    spendableFeeUtxos: feeUtxos,
    publicKeyHex,
    recipientScriptHex,
    changeScriptHex,
    feeRateSatVb,
  });

  const signedPsbtHex = await provider.signPsbt(plan.psbtHex, {
    autoFinalized: false,
    toSignInputs: plan.inputs.map((input, index) => ({
      index,
      address: currentAddress,
      ...(input.spendType === "taproot" ? { useTweakedSigner: true } : {}),
    })),
  });
  await assertWalletSession(
    provider,
    currentAddress,
    expectedNetworkEnum,
    publicKeyHex
  );
  if (
    typeof signedPsbtHex !== "string" ||
    !/^(?:[a-f0-9]{2})+$/i.test(signedPsbtHex)
  ) {
    throw new Error("UniSat did not return a valid signed PSBT.");
  }
  const rawTxHex = extractAndVerifySignedOrdinalTransaction(
    signedPsbtHex,
    plan
  );
  if (params.beforeBroadcast) await params.beforeBroadcast(publicKeyHex);

  const broadcastResult = await fetchText(`${mempool.api}/api/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: rawTxHex,
  });
  const expectedTxid = bitcoin.Transaction.fromHex(rawTxHex)
    .getId()
    .toLowerCase();
  const returnedTxid = broadcastResult.replace(/^"|"$/g, "").toLowerCase();
  if (returnedTxid !== expectedTxid) {
    throw new Error(
      "Mempool did not confirm the expected transaction ID; check the wallet before retrying."
    );
  }
  return { txid: returnedTxid, plan };
}
