import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Send, ShieldCheck } from "lucide-react";
import { describeFeeSources, getRecommendedFeeEstimate, validateMempoolAddress } from "@/lib/mempool";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";
import type { ProtocolNetwork } from "@/lib/protocol-balances";

type Wallet = {
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<{ enum?: string }>;
  getPublicKey?: () => Promise<string>;
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
  sendBitcoin?: (address: string, satoshis: number, options?: { feeRate?: number }) => Promise<string | { txid?: string }>;
  sendInscription?: (recipient: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<string | { txid?: string }>;
};
type OrderStatus = { status?: string; files?: Array<{ inscriptionId?: string }> };
type SiteName = "punks" | "pokedex";
const API_BASE = (import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription").replace(/\/api\/live-inscription\/?$/, "");
const wallet = () => (window as Window & { unisat?: Wallet }).unisat;
const txidOf = (value: string | { txid?: string }) => typeof value === "string" ? value : value.txid || "";
const dataUrl = (text: string) => `data:application/json;base64,${btoa(text)}`;
const validDecimal = (value: string) => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value !== "0" && !/^0+\.0+$/.test(value);
function decimalCompare(left: string, right: string) {
  const [li, lf = ""] = left.split("."); const [ri, rf = ""] = right.split(".");
  const lint = li.replace(/^0+/, "") || "0"; const rint = ri.replace(/^0+/, "") || "0";
  if (lint.length !== rint.length) return lint.length - rint.length;
  if (lint !== rint) return lint > rint ? 1 : -1;
  const width = Math.max(lf.length, rf.length); const lfrac = lf.padEnd(width, "0"); const rfrac = rf.padEnd(width, "0");
  return lfrac === rfrac ? 0 : lfrac > rfrac ? 1 : -1;
}
export function Brc20TransferFlow({ address, network, ticker, amount, onDone, site = "pokedex" }: { address: string; network: ProtocolNetwork; ticker: string; amount: string; onDone: () => void; site?: SiteName }) {
  const [recipient, setRecipient] = useState(""); const [amountToTransfer, setAmountToTransfer] = useState(amount); const [confirmed, setConfirmed] = useState(false);
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null); const [ownershipProofVersion, setOwnershipProofVersion] = useState(0);
  const [busy, setBusy] = useState(false); const [step, setStep] = useState<"idle" | "preparing" | "payment" | "waiting" | "sending" | "done">("idle");
  const [message, setMessage] = useState(""); const [orderId, setOrderId] = useState(""); const [inscriptionId, setInscriptionId] = useState(""); const [feeRate, setFeeRate] = useState(1);
  const chainLabel = network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin";
  const ownershipContextKey = recipient.trim() && validDecimal(amountToTransfer) ? JSON.stringify(["brc20-transfer", site, address, network, ticker, recipient.trim(), amountToTransfer]) : "";
  useEffect(() => { setRecipient(""); setAmountToTransfer(amount); setConfirmed(false); setOwnershipProofKey(null); setOwnershipProofVersion(value => value + 1); setStep("idle"); setMessage(""); setOrderId(""); setInscriptionId(""); }, [ticker, amount, network, address]);
  useEffect(() => { setOwnershipProofKey(null); setOwnershipProofVersion(value => value + 1); }, [recipient, amountToTransfer]);
  const pollOrder = async (id: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(`${API_BASE}/api/inscribe/order?${new URLSearchParams({ orderId: id, chain: network })}`, { cache: "no-store" });
      const data = await response.json() as OrderStatus; const file = data.files?.find(item => typeof item.inscriptionId === "string");
      if (file?.inscriptionId) return file.inscriptionId;
      if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(String(data.status))) throw new Error(`L’ordre d’inscription est ${data.status}.`);
      await new Promise(resolve => window.setTimeout(resolve, 5000));
    }
    throw new Error("L’inscription n’est pas encore indexée. Ne payez pas une seconde fois : vérifiez l’ordre UniSat.");
  };
  const start = async () => {
    const provider = wallet();
    if (!provider?.getPublicKey || !provider.getAccounts || !provider.getChain || !provider.sendBitcoin || !provider.sendInscription) return setMessage("UniSat doit exposer getAccounts, getChain, getPublicKey, sendBitcoin et sendInscription. Mettez UniSat à jour.");
    if (!recipient.trim() || !confirmed) return setMessage("Vérifiez l’adresse destinataire et confirmez les deux étapes.");
    if (!validDecimal(amountToTransfer) || decimalCompare(amountToTransfer, amount) > 0) return setMessage(`La quantité doit être supérieure à zéro et ne pas dépasser le solde disponible (${amount}).`);
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) return setMessage("Complétez la preuve de propriété BIP-322 pour cette adresse, ce réseau, ce destinataire et cette quantité.");
    setBusy(true); setStep("preparing"); setMessage("");
    try {
      const [accounts, chain, publicKey] = await Promise.all([provider.getAccounts(), provider.getChain(), provider.getPublicKey()]);
      if (chain?.enum !== network || !accounts.includes(address)) throw new Error("Le compte ou le réseau UniSat a changé. Aucun ordre n’a été créé.");
      await validateMempoolAddress(network, address); await validateMempoolAddress(network, recipient.trim());
      const estimate = await getRecommendedFeeEstimate(network); const liveFeeRate = Math.max(1, Math.ceil(estimate.feeRate)); setFeeRate(liveFeeRate);
      const operation = JSON.stringify({ p: "brc-20", op: "transfer", tick: ticker, amt: amountToTransfer });
      const response = await fetch(`${API_BASE}/api/inscribe/order`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: publicKey, feeRate: liveFeeRate, outputValue: 546, chain: network, files: [{ filename: `brc20-transfer-${ticker}.json`, dataURL: dataUrl(operation) }] }) });
      const order = await response.json() as { orderId?: string; payAddress?: string; amount?: number; error?: string };
      const orderAmount = order.amount;
      if (!response.ok || !order.orderId || !order.payAddress || typeof orderAmount !== "number" || !Number.isSafeInteger(orderAmount) || orderAmount <= 0) throw new Error(order.error || "UniSat n’a pas créé l’ordre d’inscription.");
      setOrderId(order.orderId); setStep("payment"); setMessage(`Étape 1/2 : approuvez dans UniSat le paiement de ${orderAmount.toLocaleString()} sats pour inscrire ${amountToTransfer} ${ticker}. Frais live : ${describeFeeSources(estimate.strategy, estimate.sources)}.`);
      const payment = txidOf(await provider.sendBitcoin(order.payAddress, orderAmount, { feeRate: liveFeeRate })); if (!payment) throw new Error("UniSat n’a pas retourné de TXID. Vérifiez l’activité du wallet avant de recommencer.");
      setStep("waiting"); setMessage(`Paiement confirmé (${payment}). Attente de l’inscription transfer…`);
      const createdInscription = await pollOrder(order.orderId); setInscriptionId(createdInscription); setStep("sending"); setMessage(`Étape 2/2 : l’inscription ${createdInscription.slice(0, 18)}… est prête. Vérifiez puis approuvez son envoi vers ${recipient.trim()}.`);
      const sent = txidOf(await provider.sendInscription(recipient.trim(), createdInscription, { feeRate: liveFeeRate })); if (!sent) throw new Error("UniSat n’a pas retourné le TXID du transfert BRC-20.");
      setStep("done"); setMessage(`BRC-20 ${ticker} (${amountToTransfer}) transféré vers ${recipient.trim()} · TXID inscription: ${sent}`); onDone();
    } catch (cause) { setStep(inscriptionId ? "sending" : "idle"); setMessage(cause instanceof Error ? cause.message : "Le flux BRC-20 a été refusé ou a échoué. Vérifiez UniSat avant toute nouvelle tentative."); } finally { setBusy(false); }
  };
  return <div className="mt-3 border border-[#d99a54]/50 bg-[#10151a] p-3"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">Inscrire puis transférer · BRC-20 {ticker}</p><p className="mt-1 font-mono text-[9px] leading-5 text-[#718092]">Réseau : {chainLabel} · quantité détectée : <strong className="text-[#70c7a0]">{amount}</strong>. Le site vérifie la quantité exacte, le réseau et le wallet avant les deux approbations UniSat.</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={recipient} onChange={event => { setRecipient(event.target.value); setConfirmed(false); }} disabled={busy} placeholder={`Adresse destinataire ${chainLabel}`} className="min-h-11 border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]" /><label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">Quantité BRC-20<input value={amountToTransfer} onChange={event => { setAmountToTransfer(event.target.value); setConfirmed(false); }} disabled={busy} inputMode="decimal" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-xs normal-case text-[#d9d3c6]" /><span className="mt-1 block normal-case text-[#718092]">Disponible : {amount} · frais : {feeRate} sat/vB</span></label></div><label className="mt-3 flex items-start gap-2 font-mono text-[10px] leading-5 text-[#d9d3d6]"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} className="mt-1 accent-[#d99a54]" /><span><ShieldCheck size={12} className="mr-1 inline text-[#f2bd63]" />Je confirme l’adresse, le réseau et la quantité. Je comprends que deux approbations UniSat seront demandées.</span></label>{confirmed && recipient.trim() && <UniSatOwnershipProof key={`${ownershipContextKey}:${ownershipProofVersion}`} site={site} address={address} network={network} provider={wallet()} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />}<button type="button" onClick={() => void start()} disabled={busy || !recipient.trim() || !confirmed || !validDecimal(amountToTransfer) || decimalCompare(amountToTransfer, amount) > 0 || ownershipProofKey !== ownershipContextKey} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">{busy ? <><Loader2 size={13} className="animate-spin" /> {step === "waiting" ? "Attente de l’inscription…" : step === "sending" ? "Transfert…" : "Préparation…"}</> : step === "done" ? <><CheckCircle2 size={13} /> Terminé</> : <><Send size={13} /> Inscrire puis transférer</>}</button>{(orderId || inscriptionId) && <p className="mt-2 break-all font-mono text-[9px] text-[#718092]">Ordre : {orderId || "—"} · Inscription : {inscriptionId || "en attente"}</p>}{message && <p className="mt-2 break-all border border-[#3b434d] p-2 font-mono text-[10px] text-[#d9d3c6]">{message}</p>}</div>;
}
