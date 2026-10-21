import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import type { AddressType, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { fetchAddressOrdinals, type AddressOrdinal } from "@/lib/ordinals";
import { LIVE_DATA_API_BASE } from "@/lib/live";
import { confirmSpendableUtxos, getRecommendedFeeEstimate, getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";
import { buildOrdinalTransferPsbt, extractAndVerifySignedOrdinalTransaction, type OrdinalLocation, type OrdinalTransferPlan, type PreviousOutputRef } from "@/lib/ordinal-transfer-psbt";

const MAX_SAFE_FEE_RATE = 1_000;
const FETCH_TIMEOUT_MS = 10_000;
type LocalOrdinalPlan = { network: OrdiNetwork; addressType: AddressType; address: string; recipient: string; inscription: AddressOrdinal; ownedInscriptions: AddressOrdinal[]; plan: OrdinalTransferPlan };

function assertCompleteOrdinalList(detail: AddressOrdinal[], total: number) {
  if (!Number.isSafeInteger(total) || total < 0 || detail.length !== total) {
    throw new Error("L’indexeur n’a pas retourné toutes les inscriptions de cette adresse; par sécurité, le vault local bloque le transfert.");
  }
  if (detail.some(item => !item.location)) throw new Error("Une inscription de cette adresse n’a pas de position vérifiable; le vault refuse de signer.");
}
function sameOrdinalSet(left: AddressOrdinal[], right: AddressOrdinal[]) {
  const key = (items: AddressOrdinal[]) => items.map(item => `${item.inscriptionId}:${item.location ?? ""}`).sort().join("|");
  return key(left) === key(right);
}
function toOrdinalLocations(items: AddressOrdinal[]): OrdinalLocation[] {
  return items.map(({ inscriptionId, location }) => ({ inscriptionId, location: location ?? undefined }));
}
async function fetchText(url: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Accept: "text/plain" } });
    const text = (await response.text()).trim().replace(/^"|"$/g, "");
    if (!response.ok) throw new Error(`Mempool HTTP ${response.status}`);
    if (!/^(?:[a-f0-9]{2})+$/i.test(text)) throw new Error("Mempool n’a pas retourné une transaction précédente valide.");
    return text;
  } finally { window.clearTimeout(timer); }
}
async function loadPreviousTx(network: OrdiNetwork, txid: string) {
  const query = new URLSearchParams({ chain: network, txid });
  return fetchText(`${LIVE_DATA_API_BASE}/api/mempool/tx-hex?${query}`);
}
async function assertOrdinalListStillCurrent(network: OrdiNetwork, address: string, expected: AddressOrdinal[]) {
  const current = await fetchAddressOrdinals(address, network);
  assertCompleteOrdinalList(current.detail, current.total);
  if (!sameOrdinalSet(current.detail, expected)) throw new Error("La liste ou la position des inscriptions a changé depuis la revue; aucune signature n’a été créée.");
}
function getOrdinalFeeInputs(plan: OrdinalTransferPlan) {
  const inscriptionOutpoint = typeof plan.inscriptionOutpoint === "string" ? plan.inscriptionOutpoint.toLowerCase() : "";
  if (!/^[a-f0-9]{64}:\d+$/.test(inscriptionOutpoint)) {
    throw new Error("La position de l’inscription dans le PSBT est invalide; aucune signature n’a été créée.");
  }
  const outpoints = plan.inputs.map(input => `${input.txid.toLowerCase()}:${input.vout}`);
  if (outpoints.some(outpoint => !/^[a-f0-9]{64}:\d+$/.test(outpoint)) || new Set(outpoints).size !== outpoints.length) {
    throw new Error("Le PSBT contient une entrée invalide ou dupliquée; aucune signature n’a été créée.");
  }
  const inscriptionMatches = outpoints.filter(outpoint => outpoint === inscriptionOutpoint).length;
  if (inscriptionMatches !== 1) {
    throw new Error("L’entrée de l’inscription ne correspond pas exactement au PSBT; aucune signature n’a été créée.");
  }
  return plan.inputs.filter((input, index) => outpoints[index] !== inscriptionOutpoint);
}

async function assertFeeInputsStillSafe(network: OrdiNetwork, address: string, plan: OrdinalTransferPlan) {
  // Identify the asset input by its outpoint, never by array position. Only separate fee inputs
  // are checked against the spendable set, so the inscription itself is never treated as fees.
  const feeInputs = getOrdinalFeeInputs(plan);
  if (!feeInputs.length) throw new Error("Le PSBT n’a pas d’entrée de frais distincte; le vault bloque ce transfert.");
  const refs = await getSpendableUtxos(network, address, 1, { requiredOutpoints: feeInputs.map(input => `${input.txid}:${input.vout}`) });
  const byOutpoint = new Map(refs.map(ref => [`${ref.txid.toLowerCase()}:${ref.vout}`, ref]));
  for (const input of feeInputs) {
    const live = byOutpoint.get(`${input.txid.toLowerCase()}:${input.vout}`);
    if (!live || live.address !== address || live.satoshi !== input.valueSats || live.scriptPk.toLowerCase() !== input.scriptHex.toLowerCase()) {
      throw new Error("Une entrée de frais n’est plus confirmée et sans actifs pour ce vault; aucune signature ou diffusion.");
    }
  }
  const feeInputSats = feeInputs.reduce((total, input) => total + input.valueSats, 0);
  await confirmSpendableUtxos(network, address, feeInputSats, feeInputs.map(input => ({
    txid: input.txid, vout: input.vout, satoshi: input.valueSats, scriptPk: input.scriptHex,
    sourceCursor: byOutpoint.get(`${input.txid.toLowerCase()}:${input.vout}`)!.sourceCursor,
  })));
}

export async function prepareLocalOrdinalTransfer(params: {
  network: OrdiNetwork;
  wallet: OrdiWalletRecord;
  addressType: AddressType;
  inscriptionId: string;
  recipient: string;
}): Promise<LocalOrdinalPlan> {
  const { network, wallet, addressType } = params;
  const account = wallet.addresses[addressType];
  if (!account?.address || !account.publicKey || !account.privateKey) throw new Error("La clé locale de l’adresse active est indisponible.");
  const recipient = params.recipient.trim();
  if (!recipient || recipient.length > 100) throw new Error("Saisissez une adresse destinataire valide.");
  const live = await fetchAddressOrdinals(account.address, network);
  assertCompleteOrdinalList(live.detail, live.total);
  const inscription = live.detail.find(item => item.inscriptionId.toLowerCase() === params.inscriptionId.toLowerCase());
  if (!inscription?.location) throw new Error("Cette inscription n’est plus répertoriée à l’adresse du vault.");
  await validateMempoolAddress(network, recipient);
  const fee = await getRecommendedFeeEstimate(network);
  const feeRateSatVb = Math.ceil(fee.feeRate);
  if (!Number.isSafeInteger(feeRateSatVb) || feeRateSatVb < 1 || feeRateSatVb > MAX_SAFE_FEE_RATE) throw new Error("Le taux de frais live est hors limites; aucun PSBT n’a été préparé.");
  const recipientScriptHex = Buffer.from(bitcoin.address.toOutputScript(recipient, bitcoin.networks.bitcoin)).toString("hex");
  const changeScriptHex = Buffer.from(bitcoin.address.toOutputScript(account.address, bitcoin.networks.bitcoin)).toString("hex");
  // Collect all verified fee-safe outputs; the PSBT builder calculates actual fee/change using the inscription output too.
  // A fixed 500-vB reserve can reject valid transfers even when the final transaction is fundable.
  const safeFeeUtxos = await getSpendableUtxos(network, account.address, 1, { collectAll: true });
  if (safeFeeUtxos.length === 0) {
    throw new Error("Aucun UTXO confirmé et sans actif n’est disponible pour financer les frais. Aucun PSBT n’a été préparé.");
  }
  const ownedInscriptions = live.detail;
  const location = inscription.location.split(":");
  const inscriptionTxid = location[0];
  if (!/^[a-f0-9]{64}$/i.test(inscriptionTxid)) throw new Error("La position live de l’inscription est invalide.");
  const txids = Array.from(new Set([inscriptionTxid, ...safeFeeUtxos.map(item => item.txid.toLowerCase())]));
  const rawEntries = await Promise.all(txids.map(async txid => [txid, await loadPreviousTx(network, txid)] as const));
  const rawTxById = new Map(rawEntries);
  const sourceTxHex = rawTxById.get(inscriptionTxid.toLowerCase());
  if (!sourceTxHex) throw new Error("La transaction source de l’inscription est indisponible.");
  const sourceTx = bitcoin.Transaction.fromHex(sourceTxHex);
  const sourceVout = Number(location[1]);
  const sourceOutput = sourceTx.outs[sourceVout];
  if (!sourceOutput || (inscription.outputValue !== null && Number(sourceOutput.value) !== inscription.outputValue)) throw new Error("La valeur de sortie de l’inscription ne correspond pas à la transaction source; transfert bloqué.");
  const feeRefs: PreviousOutputRef[] = safeFeeUtxos.map(utxo => ({
    txid: utxo.txid.toLowerCase(), vout: utxo.vout, rawTxHex: rawTxById.get(utxo.txid.toLowerCase()) ?? "",
    expectedScriptHex: utxo.scriptPk.toLowerCase(), expectedValueSats: utxo.satoshi,
  }));
  const plan = buildOrdinalTransferPsbt({
    selectedInscription: { inscriptionId: inscription.inscriptionId, location: inscription.location },
    ownedInscriptions: toOrdinalLocations(ownedInscriptions),
    inscriptionPreviousTxHex: sourceTxHex,
    spendableFeeUtxos: feeRefs,
    publicKeyHex: account.publicKey,
    recipientScriptHex,
    changeScriptHex,
    feeRateSatVb,
  });
  return { network, addressType, address: account.address, recipient, inscription, ownedInscriptions, plan };
}

export async function signLocalOrdinalTransfer(local: LocalOrdinalPlan, wallet: OrdiWalletRecord) {
  const account = wallet.addresses[local.addressType];
  if (!account || account.address !== local.address || account.publicKey.toLowerCase() !== local.plan.publicKeyHex.toLowerCase()) throw new Error("Le compte local a changé depuis la revue; aucune signature.");
  await assertOrdinalListStillCurrent(local.network, local.address, local.ownedInscriptions);
  await assertFeeInputsStillSafe(local.network, local.address, local.plan);
  const publicKey = Buffer.from(account.publicKey, "hex");
  const privateKey = Buffer.from(account.privateKey, "hex");
  if (publicKey.length !== 33 || privateKey.length !== 32 || !ecc.isPrivate(privateKey) || !ecc.isPoint(publicKey) || !Buffer.from(ecc.pointFromScalar(privateKey, true) ?? []).equals(publicKey)) throw new Error("La clé privée locale ne correspond pas à l’adresse examinée.");
  const signer = { publicKey, sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, privateKey)) };
  const parityAdjustedKey = publicKey[0] === 3 ? Buffer.from(ecc.privateNegate(privateKey)) : privateKey;
  const tapTweak = bitcoin.crypto.taggedHash("TapTweak", bitcoin.toXOnly(publicKey));
  const tweakedPrivateKey = ecc.privateAdd(parityAdjustedKey, tapTweak);
  if (!tweakedPrivateKey) throw new Error("Impossible de dériver la clé Taproot signataire.");
  const tweakedPublicKey = ecc.pointFromScalar(tweakedPrivateKey, true);
  if (!tweakedPublicKey) throw new Error("Impossible de dériver la clé publique Taproot signataire.");
  const taprootSigner = {
    publicKey: Buffer.from(tweakedPublicKey),
    sign: (hash: Uint8Array) => Buffer.from(ecc.sign(hash, tweakedPrivateKey)),
    signSchnorr: (hash: Uint8Array) => Buffer.from(ecc.signSchnorr(hash, tweakedPrivateKey)),
  };
  const psbt = bitcoin.Psbt.fromHex(local.plan.psbtHex, { network: bitcoin.networks.bitcoin });
  for (let index = 0; index < local.plan.inputs.length; index += 1) {
    const input = psbt.data.inputs[index];
    if (input.partialSig?.length || input.tapKeySig || input.tapScriptSig?.length) throw new Error("Le PSBT contient déjà une signature; opération annulée.");
    psbt.signInput(index, local.plan.inputs[index].spendType === "taproot" ? taprootSigner : signer);
  }
  const signedPsbtHex = psbt.toHex();
  const rawTxHex = extractAndVerifySignedOrdinalTransaction(signedPsbtHex, local.plan);
  const txid = bitcoin.Transaction.fromHex(rawTxHex).getId().toLowerCase();
  return { signedPsbtHex, rawTxHex, txid };
}

export async function broadcastLocalOrdinalTransfer(local: LocalOrdinalPlan, wallet: OrdiWalletRecord, signed: { signedPsbtHex: string; rawTxHex: string; txid: string }) {
  if (wallet.addresses[local.addressType]?.address !== local.address) throw new Error("Le compte actif a changé après la revue.");
  await assertOrdinalListStillCurrent(local.network, local.address, local.ownedInscriptions);
  await assertFeeInputsStillSafe(local.network, local.address, local.plan);
  const rawTxHex = extractAndVerifySignedOrdinalTransaction(signed.signedPsbtHex, local.plan);
  if (rawTxHex.toLowerCase() !== signed.rawTxHex.toLowerCase() || bitcoin.Transaction.fromHex(rawTxHex).getId().toLowerCase() !== signed.txid.toLowerCase()) throw new Error("La transaction signée ne correspond plus à la revue; diffusion annulée.");
  const query = new URLSearchParams({ chain: local.network });
  const response = await fetch(`${LIVE_DATA_API_BASE}/api/mempool/tx?${query}`, { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: rawTxHex, cache: "no-store" });
  const result = await response.json().catch(() => null) as { txid?: string; error?: string } | null;
  const returned = typeof result?.txid === "string" ? result.txid.toLowerCase() : "";
  if (!response.ok || returned !== signed.txid.toLowerCase()) throw new Error(`Résultat de diffusion incertain. Vérifiez ${signed.txid} dans Mempool avant toute nouvelle tentative${result?.error ? ` (${result.error})` : ""}.`);
  return signed.txid;
}
export type { LocalOrdinalPlan };
