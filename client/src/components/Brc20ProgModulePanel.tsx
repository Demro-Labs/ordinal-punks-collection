import { useEffect, useMemo, useState } from "react";
import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import { CheckCircle2, ExternalLink, FileCode2, Loader2, ShieldCheck } from "lucide-react";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";
import { UniSatMobileOpenDappLink } from "@/components/UniSatMobileOpenDappLink";
import { ensureNativePaymentBalance, sendNativeUniSatBitcoinPayment } from "@/lib/native-unisat-actions";
import { describeFeeSources, getMempoolConfig, getRecommendedFeeEstimate, getSpendableUtxos, validateMempoolAddress } from "@/lib/mempool";
import { LIVE_DATA_API_BASE } from "@/lib/live";
import { buildBrc20ProgActivationPsbt, extractVerifiedBrc20ProgActivation, type Brc20ProgOutpoint, type Brc20ProgActivationPlan } from "@/lib/brc20-prog-activation";
import type { ProtocolNetwork } from "@/lib/protocol-balances";

type Mode = "deploy" | "call";
type InscriptionItem = { inscriptionId: string; location?: string; outputValue?: string | number };
type Wallet = {
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<{ enum?: string }>;
  getPublicKey?: () => Promise<string>;
  getInscriptions?: (cursor: number, size: number) => Promise<{ total: number; list: InscriptionItem[] }>;
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
  sendBitcoin?: (address: string, satoshis: number, options?: { feeRate?: number }) => Promise<string | { txid?: string }>;
  signPsbt?: (psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number; address?: string; useTweakedSigner?: boolean }> }) => Promise<string>;
  pushPsbt?: (psbtHex: string) => Promise<string>;
};
type OrderStatus = { status?: string; files?: Array<{ inscriptionId?: string }> };
type Stage = "idle" | "creating" | "payment-ready" | "paying" | "waiting" | "ready" | "preparing-activation" | "prepared" | "signing" | "uncertain" | "done";
type SiteName = "punks" | "pokedex";
const BITCOIN = "BITCOIN_MAINNET" as const;
const API_BASE = LIVE_DATA_API_BASE;
const wallet = () => (window as Window & { unisat?: Wallet }).unisat;
const HEX_DATA = /^0x(?:[0-9a-f]{2})+$/i;
const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/i;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const ORDER_TERMINAL = new Set(["failed", "cancelled", "payment_notenough", "payment_overpay"]);
const txidOf = (value: string | { txid?: string }) => typeof value === "string" ? value : value.txid || "";
const dataUrl = (text: string) => `data:application/json;base64,${btoa(text)}`;
type SavedFlow = { mode: Mode; data: string; contract: string; inscriptionIdTarget: string; orderId: string; payAddress: string; payAmount: number; feeRate: number; flowAddress: string; paymentTxid: string; paymentStarted: boolean; inscriptionId: string; activationStarted: boolean; activationTxid: string };
const flowStorageKey = (site: SiteName) => `demro:${site}:brc20-prog-flow:v1`;
function saveFlow(site: SiteName, value: SavedFlow) { try { localStorage.setItem(flowStorageKey(site), JSON.stringify(value)); } catch { /* private mode or storage quota */ } }
function readFlow(site: SiteName): SavedFlow | null {
  try {
    const value = JSON.parse(localStorage.getItem(flowStorageKey(site)) || "null") as Partial<SavedFlow> | null;
    if (!value || !["deploy", "call"].includes(String(value.mode)) || typeof value.data !== "string" || !HEX_DATA.test(value.data) || typeof value.contract !== "string" || typeof value.inscriptionIdTarget !== "string" || typeof value.orderId !== "string" || !value.orderId || typeof value.payAddress !== "string" || !value.payAddress || !Number.isSafeInteger(value.payAmount) || Number(value.payAmount) <= 0 || !Number.isSafeInteger(value.feeRate) || Number(value.feeRate) <= 0 || typeof value.flowAddress !== "string" || typeof value.paymentTxid !== "string" || typeof value.paymentStarted !== "boolean" || typeof value.inscriptionId !== "string" || typeof value.activationStarted !== "boolean" || typeof value.activationTxid !== "string") return null;
    if (value.paymentTxid && !/^[a-f0-9]{64}$/i.test(value.paymentTxid)) return null;
    if (value.inscriptionId && !INSCRIPTION_ID.test(value.inscriptionId)) return null;
    return value as SavedFlow;
  } catch { return null; }
}

async function fetchText(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  return body.trim();
}
async function pollOrder(orderId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const query = new URLSearchParams({ orderId, chain: BITCOIN });
    const response = await fetch(`${API_BASE}/api/inscribe/order?${query}`, { cache: "no-store", headers: { Accept: "application/json" } });
    const data = await response.json() as OrderStatus & { error?: string };
    if (!response.ok) throw new Error(data.error || `Impossible de vérifier l’ordre UniSat (${response.status}).`);
    const id = data.files?.find(file => typeof file.inscriptionId === "string")?.inscriptionId;
    if (id && INSCRIPTION_ID.test(id)) return id;
    if (ORDER_TERMINAL.has(String(data.status))) throw new Error(`L’ordre d’inscription est ${data.status}.`);
    await new Promise(resolve => window.setTimeout(resolve, 5_000));
  }
  throw new Error("L’inscription n’est pas encore indexée. Ne créez pas un deuxième ordre; utilisez la réactualisation ou vérifiez l’ordre UniSat.");
}
async function getAllWalletInscriptions(provider: Wallet) {
  if (!provider.getInscriptions) throw new Error("Cette version UniSat ne permet pas de vérifier les inscriptions du wallet. Mettez UniSat à jour.");
  const all: InscriptionItem[] = [];
  const pageSize = 100;
  let total = 0;
  for (let cursor = 0; cursor < 2_000; cursor += pageSize) {
    const page = await provider.getInscriptions(cursor, pageSize);
    if (!page || !Number.isSafeInteger(page.total) || !Array.isArray(page.list) || page.list.length > pageSize) throw new Error("UniSat a retourné une liste d’inscriptions invalide; aucun UTXO ne sera dépensé.");
    total = page.total;
    all.push(...page.list);
    if (all.length >= total || page.list.length === 0) break;
  }
  if (all.length < total) throw new Error("Le wallet contient plus d’inscriptions que le plafond de vérification. La transaction est bloquée par sécurité.");
  return all;
}
async function fetchOutpoint(txid: string, vout: number, address: string, expectedValue?: number, expectedScript?: string): Promise<Brc20ProgOutpoint> {
  const mempool = getMempoolConfig(BITCOIN);
  if (!mempool) throw new Error("Mempool Bitcoin n’est pas configuré.");
  const rawTxHex = await fetchText(`${mempool.api}/api/tx/${encodeURIComponent(txid)}/hex`);
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex)) throw new Error("Mempool a renvoyé une transaction précédente invalide.");
  const previous = bitcoin.Transaction.fromHex(rawTxHex);
  if (previous.getId().toLowerCase() !== txid.toLowerCase()) throw new Error("La transaction précédente ne correspond pas au TXID de l’UTXO.");
  const output = previous.outs[vout];
  if (!output) throw new Error("La sortie UTXO est introuvable dans la transaction précédente.");
  const valueSats = Number(output.value);
  if (!Number.isSafeInteger(valueSats) || valueSats <= 0 || (expectedValue !== undefined && valueSats !== expectedValue)) throw new Error("La valeur de la sortie ne correspond pas aux données du wallet.");
  const expectedWalletScript = Buffer.from(bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin));
  if (!Buffer.from(output.script).equals(expectedWalletScript) || (expectedScript && Buffer.from(output.script).toString("hex") !== expectedScript.toLowerCase())) throw new Error("Le script de l’UTXO ne correspond pas à l’adresse UniSat Bitcoin active.");
  return { txid: txid.toLowerCase(), vout, valueSats, scriptHex: Buffer.from(output.script).toString("hex"), rawTxHex };
}

export function Brc20ProgModulePanel({ network, address, site = "pokedex" }: { network: ProtocolNetwork; address?: string; site?: SiteName }) {
  const [mode, setMode] = useState<Mode>("deploy");
  const [bytecode, setBytecode] = useState("");
  const [contract, setContract] = useState("");
  const [inscriptionIdTarget, setInscriptionIdTarget] = useState("");
  const [calldata, setCalldata] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [proofKey, setProofKey] = useState<string | null>(null);
  const [proofVersion, setProofVersion] = useState(0);
  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState("");
  const [orderId, setOrderId] = useState("");
  const [paymentTxid, setPaymentTxid] = useState("");
  const [payAddress, setPayAddress] = useState("");
  const [payAmount, setPayAmount] = useState(0);
  const [paymentFeeRate, setPaymentFeeRate] = useState(0);
  const [flowAddress, setFlowAddress] = useState("");
  const [paymentStarted, setPaymentStarted] = useState(false);
  const [inscriptionId, setInscriptionId] = useState("");
  const [plan, setPlan] = useState<Brc20ProgActivationPlan | null>(null);
  const [feeLabel, setFeeLabel] = useState("");
  const [restored, setRestored] = useState(false);
  const busy = ["creating", "paying", "waiting", "preparing-activation", "signing"].includes(stage);
  const data = mode === "deploy" ? bytecode.trim() : calldata.trim();
  const contractTargetValid = Boolean(contract.trim()) !== Boolean(inscriptionIdTarget.trim())
    && (!contract.trim() || EVM_ADDRESS.test(contract.trim()))
    && (!inscriptionIdTarget.trim() || INSCRIPTION_ID.test(inscriptionIdTarget.trim()));
  const valid = network === BITCOIN && Boolean(address) && HEX_DATA.test(data) && (mode === "deploy" || contractTargetValid);
  const payload = useMemo(() => {
    if (!valid) return "";
    return JSON.stringify(mode === "deploy"
      ? { p: "brc20-prog", op: "deploy", d: data }
      : { p: "brc20-prog", op: "call", ...(contract.trim() ? { c: contract.trim() } : { i: inscriptionIdTarget.trim() }), d: data }, null, 2);
  }, [valid, mode, data, contract, inscriptionIdTarget]);
  const contextKey = valid ? JSON.stringify(["brc20-prog", site, address, BITCOIN, mode, payload]) : "";
  useEffect(() => { setProofKey(null); setProofVersion(value => value + 1); }, [contextKey]);
  useEffect(() => {
    const saved = readFlow(site);
    if (saved) {
      setMode(saved.mode); setBytecode(saved.mode === "deploy" ? saved.data : ""); setCalldata(saved.mode === "call" ? saved.data : "");
      setContract(saved.contract); setInscriptionIdTarget(saved.inscriptionIdTarget); setOrderId(saved.orderId); setPayAddress(saved.payAddress);
      setPayAmount(saved.payAmount); setPaymentFeeRate(saved.feeRate); setFlowAddress(saved.flowAddress); setPaymentTxid(saved.paymentTxid);
      setPaymentStarted(saved.paymentStarted); setInscriptionId(saved.inscriptionId);
      setStage(saved.activationStarted ? "uncertain" : saved.activationTxid ? "done" : saved.inscriptionId ? "ready" : saved.paymentStarted || saved.paymentTxid ? "waiting" : "payment-ready");
      setMessage(saved.activationStarted ? `État d’activation préservé après rechargement. Vérifiez ${saved.activationTxid || "UniSat et Mempool"} avant toute nouvelle action.` : saved.activationTxid ? `Activation déjà diffusée : ${saved.activationTxid}. Vérifiez sa confirmation avant de démarrer une autre opération.` : "Opération BRC2.0 restaurée; le reçu existant sera réutilisé.");
    }
    setRestored(true);
  }, [site]);

  const createInscription = async () => {
    const provider = wallet();
    if (!valid || !address || !provider?.getAccounts || !provider.getChain || !provider.getPublicKey || !provider.sendBitcoin) return setMessage("Connectez UniSat sur Bitcoin mainnet avec getAccounts, getChain, getPublicKey et sendBitcoin.");
    if (!confirmed || proofKey !== contextKey) return setMessage("Confirmez le payload et terminez la preuve de propriété BIP-322 avant de créer l’inscription.");
    setStage("creating"); setMessage(""); setPlan(null); setActivationConfirmed(false);
    try {
      const [accounts, chain, publicKey] = await Promise.all([provider.getAccounts(), provider.getChain(), provider.getPublicKey()]);
      if (chain?.enum !== BITCOIN || !accounts.includes(address)) throw new Error("Le compte ou le réseau UniSat a changé. Aucune commande n’a été créée.");
      await validateMempoolAddress(BITCOIN, address);
      const estimate = await getRecommendedFeeEstimate(BITCOIN);
      const feeRate = Math.max(1, Math.ceil(estimate.feeRate));
      const response = await fetch(`${API_BASE}/api/inscribe/order`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: publicKey, feeRate, outputValue: 546, chain: BITCOIN, files: [{ filename: `brc20-prog-${mode}.json`, dataURL: dataUrl(payload) }] }),
      });
      const order = await response.json() as { orderId?: string; payAddress?: string; amount?: number; error?: string };
      if (!response.ok || !order.orderId || !order.payAddress || !Number.isSafeInteger(order.amount) || !order.amount || order.amount <= 0) throw new Error(order.error || "UniSat n’a pas créé l’ordre d’inscription.");
      try { bitcoin.address.toOutputScript(order.payAddress, bitcoin.networks.bitcoin); } catch { throw new Error("L’adresse de paiement du reçu UniSat n’est pas une adresse Bitcoin mainnet valide."); }
      setOrderId(order.orderId); setPayAddress(order.payAddress); setPayAmount(order.amount); setPaymentFeeRate(feeRate); setFlowAddress(address);
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId: order.orderId, payAddress: order.payAddress, payAmount: order.amount, feeRate, flowAddress: address, paymentTxid: "", paymentStarted: false, inscriptionId: "", activationStarted: false, activationTxid: "" });
      setFeeLabel(describeFeeSources(estimate.strategy, estimate.sources)); setStage("payment-ready");
      setMessage(`Ordre ${order.orderId} créé. Étape suivante : vérifiez les UTXO sûrs puis approuvez dans UniSat le paiement de ${order.amount.toLocaleString()} sats à l’adresse indiquée par le reçu. Aucun paiement n’a encore été envoyé.`);
    } catch (cause) {
      setStage("idle");
      setMessage(cause instanceof Error ? cause.message : "Impossible de créer l’ordre UniSat.");
    }
  };

  const payExistingOrder = async () => {
    const provider = wallet();
    if (!orderId || !payAddress || !payAmount || !provider?.sendBitcoin || !address) return setMessage("Aucun reçu de paiement valide n’est disponible.");
    if (paymentStarted) return setMessage("Un paiement a déjà été demandé. Vérifiez UniSat et Mempool; ne le renvoyez pas.");
    if (network !== BITCOIN || address !== flowAddress) return setMessage(`Revenez au compte ${flowAddress} sur Bitcoin mainnet pour utiliser le reçu existant.`);
    setStage("paying"); setMessage("Vérification des UTXO confirmés sans actifs avant de demander le paiement à UniSat…");
    let walletPromptStarted = false;
    try {
      await ensureNativePaymentBalance(BITCOIN, address, payAmount, paymentFeeRate, "inscribe-payment", { mobile: true });
      walletPromptStarted = true; setPaymentStarted(true);
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted: true, inscriptionId, activationStarted: false, activationTxid: "" });
      const paidTxid = txidOf(await sendNativeUniSatBitcoinPayment(provider, payAddress, payAmount, paymentFeeRate));
      if (!/^[a-f0-9]{64}$/i.test(paidTxid)) throw new Error("UniSat n’a pas retourné de TXID de paiement. Vérifiez l’activité du wallet avant de recommencer.");
      setPaymentTxid(paidTxid);
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid: paidTxid, paymentStarted: true, inscriptionId: "", activationStarted: false, activationTxid: "" });
      setStage("waiting"); setMessage(`Paiement ${paidTxid} envoyé. Attente de l’indexation de l’inscription; ne créez pas un second ordre.`);
      const created = await pollOrder(orderId);
      setInscriptionId(created);
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid: paidTxid, paymentStarted: true, inscriptionId: created, activationStarted: false, activationTxid: "" });
      setStage("ready"); setMessage(`Inscription BRC2.0 créée : ${created}. Préparez ensuite la transaction d’activation vers OP_RETURN BRC20PROG.`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Le paiement ou son suivi a échoué.";
      const cancelled = walletPromptStarted && (Boolean(cause && typeof cause === "object" && (cause as { code?: unknown }).code === 4001) || /user (rejected|denied)|cancelled by user|request rejected/i.test(detail));
      if (cancelled) {
        setPaymentStarted(false);
        saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid: "", paymentStarted: false, inscriptionId: "", activationStarted: false, activationTxid: "" });
        setStage("payment-ready"); setMessage("Le paiement a été annulé dans UniSat; aucun transfert n’a été envoyé. Vous pouvez réexaminer et réutiliser ce même reçu.");
      } else {
        setStage(walletPromptStarted ? "waiting" : "payment-ready");
        setMessage(detail);
      }
    }
  };

  const refreshInscription = async () => {
    if (!orderId) return;
    setStage("waiting"); setMessage("Vérification de l’ordre existant; aucun nouveau paiement ne sera envoyé.");
    try { const created = await pollOrder(orderId); setInscriptionId(created); saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted, inscriptionId: created, activationStarted: false, activationTxid: "" }); setStage("ready"); setMessage(`Inscription BRC2.0 créée : ${created}. Préparez ensuite l’activation.`); }
    catch (cause) { setStage("waiting"); setMessage(cause instanceof Error ? cause.message : "L’ordre existant est encore en attente."); }
  };

  const prepareActivation = async () => {
    const provider = wallet();
    if (!address || !provider?.getAccounts || !provider.getChain || !provider.getPublicKey) return setMessage("UniSat doit exposer getAccounts, getChain et getPublicKey.");
    if (network !== BITCOIN || address !== flowAddress) return setMessage(`Revenez au compte ${flowAddress} sur Bitcoin mainnet pour préparer l’ordre existant.`);
    setStage("preparing-activation"); setMessage("Vérification du réseau, de l’inscription et des UTXO Bitcoin sûrs…"); setPlan(null); setActivationConfirmed(false);
    try {
      const [accounts, chain, publicKey, owned] = await Promise.all([provider.getAccounts(), provider.getChain(), provider.getPublicKey(), getAllWalletInscriptions(provider)]);
      if (chain?.enum !== BITCOIN || !accounts.includes(address)) throw new Error("Sélectionnez le même compte sur Bitcoin mainnet dans UniSat.");
      const inscription = owned.find(item => item.inscriptionId.toLowerCase() === inscriptionId.toLowerCase());
      if (!inscription?.location) throw new Error("L’inscription n’apparaît pas encore dans le wallet UniSat. Attendez sa synchronisation puis réessayez.");
      const match = inscription.location.match(/^([a-f0-9]{64}):(\d+):(\d+)$/i);
      if (!match) throw new Error("UniSat n’a pas fourni l’emplacement actuel de l’inscription.");
      const feeEstimate = await getRecommendedFeeEstimate(BITCOIN);
      const feeRate = Math.max(1, Math.ceil(feeEstimate.feeRate));
      const [inscriptionOutput, feeUtxos] = await Promise.all([
        fetchOutpoint(match[1], Number(match[2]), address, inscription.outputValue === undefined ? undefined : Number(inscription.outputValue)),
        getSpendableUtxos(BITCOIN, address, Math.max(2_000, feeRate * 400 + 1_200), { mobile: true }),
      ]);
      const mempool = getMempoolConfig(BITCOIN)!;
      const candidates = [...feeUtxos].sort((a, b) => b.satoshi - a.satoshi).slice(0, 19);
      const resolvedFees = await Promise.all(candidates.map(async item => ({ txid: item.txid, vout: item.vout, valueSats: item.satoshi, scriptHex: item.scriptPk, rawTxHex: await fetchText(`${mempool.api}/api/tx/${encodeURIComponent(item.txid)}/hex`) })));
      const built = buildBrc20ProgActivationPsbt({ walletAddress: address, publicKeyHex: publicKey, inscriptionId, inscriptionLocation: inscription.location, ownedInscriptions: owned, inscriptionOutput, spendableFeeUtxos: resolvedFees, feeRateSatVb: feeRate });
      setPlan(built); setStage("prepared"); setFeeLabel(describeFeeSources(feeEstimate.strategy, feeEstimate.sources));
      setMessage("La transaction est préparée. Vérifiez le résumé et les sorties avant d’ouvrir l’approbation UniSat.");
    } catch (cause) {
      setStage("ready"); setMessage(cause instanceof Error ? cause.message : "Impossible de préparer une transaction d’activation sûre.");
    }
  };

  const approveActivation = () => {
    const provider = wallet();
    if (!provider?.signPsbt || !plan) return setMessage("Cette version UniSat ne permet pas de signer des PSBT. Aucun envoi n’a été diffusé.");
    if (!activationConfirmed) return setMessage("Confirmez la dépense de l’inscription vers l’OP_RETURN BRC20PROG et les frais Bitcoin.");
    setStage("signing"); setMessage("Approbation de la transaction d’activation dans UniSat…");
    saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted, inscriptionId, activationStarted: true, activationTxid: "" });
    // Invoke the wallet immediately from the explicit user click; no network request precedes this prompt.
    let signedTxid = "";
    let signing: Promise<string>;
    try { signing = provider.signPsbt(plan.psbtHex, { autoFinalized: true, toSignInputs: plan.inputs.map((input, index) => ({ index, address, useTweakedSigner: input.spendType === "taproot" })) }); }
    catch (cause) {
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted, inscriptionId, activationStarted: false, activationTxid: "" });
      setStage("prepared"); setMessage(cause instanceof Error ? cause.message : "UniSat a refusé la demande de signature."); return;
    }
    void signing.then(async signed => {
      const { txHex, txid } = extractVerifiedBrc20ProgActivation(signed, plan);
      signedTxid = txid;
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted, inscriptionId, activationStarted: true, activationTxid: txid });
      if (provider.pushPsbt) {
        const pushed = await provider.pushPsbt(signed);
        const broadcastTxid = typeof pushed === "string" ? pushed : "";
        if (!/^[a-f0-9]{64}$/i.test(broadcastTxid) || broadcastTxid.toLowerCase() !== txid.toLowerCase()) throw new Error(`UniSat a retourné un résultat de diffusion incertain. Vérifiez ${txid} dans Mempool avant tout nouvel essai.`);
      } else {
        const response = await fetch(`${API_BASE}/api/brc20-prog/activation/broadcast`, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ txHex, inscriptionOutpoint: plan.inscriptionOutpoint }),
        });
        const result = await response.json() as { txid?: string; error?: string };
        const broadcastTxid = result.txid || "";
        if (!response.ok || !/^[a-f0-9]{64}$/i.test(broadcastTxid) || broadcastTxid.toLowerCase() !== txid.toLowerCase()) throw new Error(result.error || `Le Worker n’a pas confirmé le TXID prévu. Vérifiez ${txid} dans Mempool avant toute nouvelle tentative.`);
      }
      saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted, inscriptionId, activationStarted: false, activationTxid: txid });
      setStage("done"); setMessage(`Activation BRC2.0 diffusée sur Bitcoin mainnet · TXID ${txid}. Les frais estimés étaient de ${plan.feeSats.toLocaleString()} sats; vérifiez la confirmation et l’exécution de l’indexeur.`);
    }).catch(cause => {
      const detail = cause instanceof Error ? cause.message : "Signature ou diffusion interrompue.";
      const cancelled = Boolean(cause && typeof cause === "object" && (cause as { code?: unknown }).code === 4001) || /user (rejected|denied)|cancelled by user|request rejected/i.test(detail);
      if (cancelled) saveFlow(site, { mode, data, contract, inscriptionIdTarget, orderId, payAddress, payAmount, feeRate: paymentFeeRate, flowAddress, paymentTxid, paymentStarted, inscriptionId, activationStarted: false, activationTxid: "" });
      setStage(cancelled ? "prepared" : "uncertain");
      setMessage(cancelled ? "La demande a été annulée dans UniSat; aucun envoi n’a été demandé. Vous pouvez réexaminer le plan." : `${detail} ${signedTxid ? `Vérifiez ${signedTxid} dans Mempool avant toute nouvelle action.` : "Vérifiez UniSat et Mempool avant toute nouvelle action."}`);
    });
  };

  return (
    <section className="border border-[#3b434d] bg-[#10151a] p-3" aria-labelledby="brc20-prog-module-title">
      <div className="flex items-start gap-2"><FileCode2 size={15} className="mt-0.5 shrink-0 text-[#f2bd63]" /><div>
        <h3 id="brc20-prog-module-title" className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]">Transactions BRC2.0 · Bitcoin mainnet</h3>
        <p className="mt-1 font-mono text-[9px] leading-5 text-[#9ea7b3]">Inscription deploy/call, puis transaction d’activation OP_RETURN « BRC20PROG ». Les deux étapes exigent une approbation UniSat séparée.</p>
      </div></div>
      <p className="mt-2 border border-[#d99a54]/40 bg-[#151a1f] p-2 font-mono text-[9px] leading-5 text-[#d9d3c6]">Bitcoin mainnet uniquement. L’inscription d’activation sera dépensée par la seconde transaction. Vérifiez le payload, le réseau, le montant des frais et l’écran final UniSat avant chaque approbation.</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Type d’opération BRC2.0">
        {(["deploy", "call"] as const).map(option => <button key={option} type="button" onClick={() => { setMode(option); setStage("idle"); setMessage(""); setOrderId(""); setPaymentTxid(""); setInscriptionId(""); setPlan(null); }} aria-pressed={mode === option} disabled={busy || Boolean(orderId)} className={`min-h-10 border px-3 py-2 font-mono text-[9px] uppercase ${mode === option ? "border-[#d99a54] bg-[#d99a54] text-[#0b0d10]" : "border-[#3b434d] text-[#9ea7b3]"}`}>{option === "deploy" ? "Déployer contrat" : "Appeler contrat"}</button>)}
      </div>
      <div className="mt-3 grid gap-2">
        {mode === "call" && <>
          <label className="font-mono text-[9px] text-[#9ea7b3]">Adresse EVM du contrat (0x…)
            <input value={contract} onChange={event => { setContract(event.target.value); if (event.target.value) setInscriptionIdTarget(""); }} disabled={busy || Boolean(orderId)} placeholder="0x + 40 caractères hex" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]" />
          </label>
          <label className="font-mono text-[9px] text-[#9ea7b3]">ou inscription de déploiement (ID)
            <input value={inscriptionIdTarget} onChange={event => { setInscriptionIdTarget(event.target.value); if (event.target.value) setContract(""); }} disabled={busy || Boolean(orderId)} placeholder="64 caractères hex + i + numéro" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]" />
          </label>
        </>}
        <label className="font-mono text-[9px] text-[#9ea7b3]">{mode === "deploy" ? "Bytecode + arguments du constructeur (hex)" : "Calldata ABI encodée (hex)"}
          <textarea value={data} onChange={event => mode === "deploy" ? setBytecode(event.target.value) : setCalldata(event.target.value)} disabled={busy || Boolean(orderId)} rows={4} spellCheck={false} placeholder="0x… (octets hexadécimaux complets)" className="mt-1 w-full resize-y border border-[#3b434d] bg-[#0b0d10] p-3 font-mono text-[10px] text-[#d9d3c6]" />
        </label>
      </div>
      {mode === "call" && !contractTargetValid && <p className="mt-2 font-mono text-[9px] text-[#e08b7d]">Indiquez exactement une adresse EVM valide ou un ID d’inscription de déploiement.</p>}
      {data && !HEX_DATA.test(data) && <p className="mt-2 font-mono text-[9px] text-[#e08b7d]">La donnée doit commencer par 0x et contenir des octets hexadécimaux complets.</p>}
      {payload && <pre className="mt-3 max-h-40 overflow-auto border border-[#3b434d] bg-[#0b0d10] p-3 font-mono text-[9px] leading-4 text-[#70c7a0]">{payload}</pre>}
      <label className="mt-3 flex items-start gap-2 font-mono text-[9px] leading-5 text-[#d9d3c6]"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || Boolean(orderId)} className="mt-1 accent-[#d99a54]" /><span><ShieldCheck size={12} className="mr-1 inline text-[#f2bd63]" />Je confirme Bitcoin mainnet et ce payload. Je comprends qu’une première transaction paiera l’inscription et qu’une seconde transaction distincte consommera cette inscription vers OP_RETURN BRC20PROG avec des frais Bitcoin.</span></label>
      {confirmed && valid && <UniSatOwnershipProof key={`${contextKey}:${proofVersion}`} site={site} address={address!} network={BITCOIN} provider={wallet()} contextKey={contextKey} onVerified={setProofKey} />}
      {confirmed && valid && <UniSatMobileOpenDappLink site={site} walletMethodAvailable={typeof wallet()?.signPsbt === "function"} methodLabel="signature PSBT pour l’activation BRC2.0" />}
      {!address && <p className="mt-2 font-mono text-[9px] text-[#e08b7d]">Connectez d’abord un wallet UniSat.</p>}
      {stage === "payment-ready" && orderId && <div className="mt-3 border border-[#d99a54]/50 bg-[#151a1f] p-3 font-mono text-[9px] leading-5 text-[#d9d3c6]"><p>Reçu UniSat : {orderId}</p><p>Montant : {payAmount.toLocaleString()} sats · frais : {paymentFeeRate} sat/vB</p><p className="break-all">Destination : {payAddress}</p><p>Aucun paiement n’a encore été demandé.</p></div>}
      {stage === "ready" && inscriptionId && <div className="mt-3 border border-[#70c7a0]/40 bg-[#101a16] p-3 font-mono text-[9px] text-[#d9d3c6]"><p>Inscription prête : <span className="break-all text-[#70c7a0]">{inscriptionId}</span></p><p className="mt-1">Paiement d’inscription : {paymentTxid || "TXID non confirmé par l’interface"}</p></div>}
      {plan && stage === "prepared" && <div className="mt-3 border border-[#d99a54]/50 bg-[#151a1f] p-3 font-mono text-[9px] leading-5 text-[#d9d3c6]"><p className="text-[#f2bd63]">Résumé de la seconde transaction</p><p>Réseau : Bitcoin mainnet</p><p>Destination protocole : OP_RETURN « BRC20PROG »</p><p>Inscription consommée : {plan.inscriptionId}</p><p>Entrées totales : {plan.inputs.length} · sortie de monnaie : {plan.changeSats.toLocaleString()} sats</p><p>Frais estimés : {plan.feeSats.toLocaleString()} sats à {plan.feeRateSatVb} sat/vB · source : {feeLabel}</p><a href="https://mempool.space" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[#f2bd63] underline">Vérifier Bitcoin mainnet <ExternalLink size={10} /></a></div>}
      {plan && <label className="mt-3 flex items-start gap-2 font-mono text-[9px] leading-5 text-[#d9d3c6]"><input type="checkbox" checked={activationConfirmed} onChange={event => setActivationConfirmed(event.target.checked)} disabled={busy} className="mt-1 accent-[#d99a54]" /><span>J’autorise la dépense de l’inscription vers OP_RETURN BRC20PROG et les frais estimés ci-dessus. Je vérifierai la transaction dans UniSat.</span></label>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {!orderId && <button type="button" onClick={() => void createInscription()} disabled={!restored || busy || !valid || !confirmed || proofKey !== contextKey} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? <><Loader2 size={13} className="animate-spin" /> Préparation…</> : "1 · Créer le reçu"}</button>}
        {stage === "payment-ready" && <button type="button" onClick={() => void payExistingOrder()} disabled={busy || network !== BITCOIN || address !== flowAddress} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">Payer le reçu existant · {payAmount.toLocaleString()} sats</button>}
        {stage === "waiting" && <button type="button" onClick={() => void refreshInscription()} disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">Vérifier l’ordre existant</button>}
        {stage === "ready" && <button type="button" onClick={() => void prepareActivation()} disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">2 · Préparer OP_RETURN</button>}
        {stage === "prepared" && <button type="button" onClick={approveActivation} disabled={busy || !activationConfirmed} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? <><Loader2 size={13} className="animate-spin" /> Signature…</> : "Approuver et diffuser l’activation"}</button>}
        {stage === "uncertain" && <div className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#e08b7d]/50 px-3 py-2 font-mono text-[9px] uppercase text-[#e08b7d]">Résultat à vérifier avant nouvel essai</div>}
        {stage === "done" && <div className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#70c7a0]/50 px-3 py-2 font-mono text-[9px] uppercase text-[#70c7a0]"><CheckCircle2 size={13} /> Activation diffusée</div>}
      </div>
      {stage === "done" && <button type="button" onClick={() => { try { localStorage.removeItem(flowStorageKey(site)); } catch {} setOrderId(""); setPaymentTxid(""); setPayAddress(""); setPayAmount(0); setPaymentFeeRate(0); setFlowAddress(""); setPaymentStarted(false); setInscriptionId(""); setPlan(null); setStage("idle"); setMessage(""); setConfirmed(false); setActivationConfirmed(false); setProofKey(null); }} className="mt-3 min-h-10 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3]">Nouvelle opération</button>}
      {message && <p className="mt-3 font-mono text-[9px] leading-5 text-[#9ea7b3]" role="status">{message}</p>}
      <p className="mt-3 font-mono text-[9px] leading-5 text-[#718092]">Les clés privées ne quittent jamais UniSat. La preuve BIP-322 ne signe pas les transactions. Les approbations de paiement et d’activation sont séparées. Après diffusion, confirmez le TXID sur Bitcoin mainnet et auprès d’un indexeur BRC2.0.</p>
    </section>
  );
}
