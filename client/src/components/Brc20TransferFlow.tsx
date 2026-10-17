import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Send, ShieldCheck } from "lucide-react";
import {
  describeFeeSources,
  getRecommendedFeeEstimate,
  validateMempoolAddress,
} from "@/lib/mempool";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";
import type { ProtocolNetwork } from "@/lib/protocol-balances";
import {
  buildBrc20TransferInscription,
  getBrc20TransferNextAction,
  getBrc20TransferStorageKey,
  parseBrc20TransferProgress,
  type Brc20TransferIdentity,
  type Brc20TransferProgress,
} from "@/lib/brc20-transfer-flow";

type Wallet = {
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<{ enum?: string }>;
  getPublicKey?: () => Promise<string>;
  signMessage?: (message: string, type: "ecdsa" | "bip322-simple") => Promise<string>;
  sendBitcoin?: (
    address: string,
    satoshis: number,
    options?: { feeRate?: number }
  ) => Promise<string | { txid?: string }>;
  sendInscription?: (
    recipient: string,
    inscriptionId: string,
    options?: { feeRate?: number }
  ) => Promise<string | { txid?: string }>;
};
type OrderStatus = {
  status?: string;
  files?: Array<{ inscriptionId?: string }>;
  error?: string;
};
type SiteName = "punks" | "pokedex";
type Brc20Kind = "classic" | "prog";
type BusyAction = "" | "preparing" | "paying" | "waiting" | "checking-recipient" | "sending";
const API_BASE = (
  import.meta.env.VITE_LIVE_DATA_URL ||
  "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription"
).replace(/\/api\/live-inscription\/?$/, "");
const wallet = () => (window as Window & { unisat?: Wallet }).unisat;
const txidOf = (value: string | { txid?: string }) =>
  typeof value === "string" ? value : value.txid || "";
const dataUrl = (text: string) => `data:application/json;base64,${btoa(text)}`;
const validDecimal = (value: string) =>
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
  value !== "0" &&
  !/^0+\.0+$/.test(value);
function decimalCompare(left: string, right: string) {
  const [li, lf = ""] = left.split(".");
  const [ri, rf = ""] = right.split(".");
  const lint = li.replace(/^0+/, "") || "0";
  const rint = ri.replace(/^0+/, "") || "0";
  if (lint.length !== rint.length) return lint.length - rint.length;
  if (lint !== rint) return lint > rint ? 1 : -1;
  const width = Math.max(lf.length, rf.length);
  const lfrac = lf.padEnd(width, "0");
  const rfrac = rf.padEnd(width, "0");
  return lfrac === rfrac ? 0 : lfrac > rfrac ? 1 : -1;
}
function isUserRejection(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && (cause as { code?: unknown }).code === 4001) ||
    /user (rejected|denied)|cancelled by user|request rejected/i.test(cause instanceof Error ? cause.message : String(cause));
}
function readProgress(identity: Brc20TransferIdentity): Brc20TransferProgress | null {
  if (typeof window === "undefined") return null;
  try {
    return parseBrc20TransferProgress(
      window.localStorage.getItem(getBrc20TransferStorageKey(identity)),
      identity,
    );
  } catch {
    return null;
  }
}

export function Brc20TransferFlow({
  address,
  network,
  ticker,
  amount,
  onDone,
  site = "pokedex",
  kind = "classic",
}: {
  address: string;
  network: ProtocolNetwork;
  ticker: string;
  amount: string;
  onDone: () => void;
  site?: SiteName;
  kind?: Brc20Kind;
}) {
  const identity: Brc20TransferIdentity = { site, address, network, ticker, kind };
  const storageKey = getBrc20TransferStorageKey(identity);
  const initialProgress = readProgress(identity);
  const [progress, setProgress] = useState<Brc20TransferProgress | null>(initialProgress);
  const progressRef = useRef<Brc20TransferProgress | null>(initialProgress);
  const [recipient, setRecipient] = useState(initialProgress?.recipient || "");
  const [amountToTransfer, setAmountToTransfer] = useState(initialProgress?.amount || amount);
  const [validatedRecipient, setValidatedRecipient] = useState(initialProgress?.recipient || "");
  const [confirmed, setConfirmed] = useState(false);
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const [ownershipProofVersion, setOwnershipProofVersion] = useState(0);
  const [busyAction, setBusyAction] = useState<BusyAction>("");
  const [message, setMessage] = useState("");
  const [feeRate, setFeeRate] = useState(initialProgress?.feeRate || 1);
  const chainLabel = network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin";
  const ownershipContextKey = recipient.trim() && validDecimal(amountToTransfer)
    ? JSON.stringify(["brc20-transfer", kind, site, address, network, ticker, recipient.trim(), amountToTransfer])
    : "";
  const nextAction = getBrc20TransferNextAction(progress);
  const activeFeeRate = progress?.feeRate || feeRate;
  const amountWithinBalance = Boolean(progress) || decimalCompare(amountToTransfer, amount) <= 0;

  const storeProgress = (next: Brc20TransferProgress) => {
    progressRef.current = next;
    setProgress(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the active flow usable in memory if storage is blocked. */ }
  };
  const updateProgress = (patch: Partial<Brc20TransferProgress>) => {
    const current = progressRef.current;
    if (current) storeProgress({ ...current, ...patch });
  };
  const clearProgress = () => {
    progressRef.current = null;
    setProgress(null);
    try { window.localStorage.removeItem(storageKey); } catch { /* Storage is optional for a new draft. */ }
  };

  useEffect(() => {
    const restored = readProgress(identity);
    progressRef.current = restored;
    setProgress(restored);
    setRecipient(restored?.recipient || "");
    setAmountToTransfer(restored?.amount || amount);
    setValidatedRecipient(restored?.recipient || "");
    setFeeRate(restored?.feeRate || 1);
    setConfirmed(false);
    setOwnershipProofKey(null);
    setOwnershipProofVersion(value => value + 1);
    setMessage(restored ? "Un transfert BRC-20 en cours a été restauré pour ce wallet et ce réseau." : "");
  }, [storageKey]);
  useEffect(() => {
    if (!progressRef.current) setAmountToTransfer(amount);
  }, [amount, storageKey]);
  useEffect(() => {
    setOwnershipProofKey(null);
    setOwnershipProofVersion(value => value + 1);
  }, [ownershipContextKey]);

  const pollOrder = async (id: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(
        `${API_BASE}/api/inscribe/order?${new URLSearchParams({ orderId: id, chain: network })}`,
        { cache: "no-store" },
      );
      const data = await response.json().catch(() => null) as OrderStatus | null;
      if (!response.ok || !data) throw new Error(data?.error || "Impossible de lire l’état de l’ordre UniSat.");
      const file = data.files?.find(item => typeof item.inscriptionId === "string");
      if (file?.inscriptionId) return file.inscriptionId;
      if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(String(data.status))) {
        throw new Error(`L’ordre d’inscription est ${data.status}.`);
      }
      await new Promise(resolve => window.setTimeout(resolve, 5000));
    }
    throw new Error("L’inscription n’est pas encore indexée. Aucun second paiement n’a été envoyé; vérifiez l’ordre UniSat et utilisez ‘Vérifier l’inscription’ pour reprendre.");
  };

  const prepareTransfer = async () => {
    const provider = wallet();
    if (kind === "prog" && !/^[a-z0-9-]{6}$/i.test(ticker)) {
      setMessage("BRC20-Prog exige un ticker de 6 caractères sur Bitcoin ou Fractal Bitcoin."); return;
    }
    if (!provider?.getPublicKey || !provider.getAccounts || !provider.getChain) {
      setMessage("UniSat doit exposer getAccounts, getChain et getPublicKey. Mettez UniSat à jour."); return;
    }
    if (!recipient.trim() || !confirmed) {
      setMessage("Saisissez l’adresse destinataire et confirmez le ticker, le réseau et le montant."); return;
    }
    if (!validDecimal(amountToTransfer) || !amountWithinBalance) {
      setMessage(`La quantité doit être supérieure à zéro et ne pas dépasser le solde disponible (${amount}).`); return;
    }
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) {
      setMessage("Complétez la preuve de propriété BIP-322 pour cette adresse, ce réseau, ce destinataire et cette quantité."); return;
    }
    if (progressRef.current) {
      setMessage("Un ordre de transfert existe déjà pour ce ticker. Reprenez l’étape affichée au lieu d’en créer un second."); return;
    }
    setBusyAction("preparing");
    setMessage("");
    try {
      const [accounts, chain, publicKey] = await Promise.all([
        provider.getAccounts(), provider.getChain(), provider.getPublicKey(),
      ]);
      if (chain?.enum !== network || !accounts.includes(address)) {
        throw new Error("Le compte ou le réseau UniSat a changé. Aucun ordre n’a été créé.");
      }
      await validateMempoolAddress(network, address);
      await validateMempoolAddress(network, recipient.trim());
      const estimate = await getRecommendedFeeEstimate(network);
      const liveFeeRate = Math.max(1, Math.ceil(estimate.feeRate));
      setFeeRate(liveFeeRate);
      const operation = buildBrc20TransferInscription(ticker, amountToTransfer);
      const response = await fetch(`${API_BASE}/api/inscribe/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          receiver: address,
          refundAddress: address,
          userAddress: address,
          userPubkey: publicKey,
          feeRate: liveFeeRate,
          outputValue: 546,
          chain: network,
          files: [{ filename: `brc20-transfer-${ticker}.json`, dataURL: dataUrl(operation) }],
        }),
      });
      const order = await response.json().catch(() => null) as {
        orderId?: string; payAddress?: string; amount?: number; error?: string;
      } | null;
      const orderAmount = order?.amount;
      if (!response.ok || !order?.orderId || !order.payAddress || typeof orderAmount !== "number" || !Number.isSafeInteger(orderAmount) || orderAmount <= 0) {
        throw new Error(order?.error || "UniSat n’a pas créé l’ordre d’inscription.");
      }
      const next: Brc20TransferProgress = {
        version: 1, ...identity, amount: amountToTransfer, recipient: recipient.trim(),
        orderId: order.orderId, payAddress: order.payAddress, payAmount: orderAmount, feeRate: liveFeeRate,
        paymentStarted: false, paymentTxid: "", inscriptionId: "", transferStarted: false, transferTxid: "",
      };
      storeProgress(next);
      setValidatedRecipient(recipient.trim());
      setMessage(`Ordre créé · ${orderAmount.toLocaleString()} sats. Étape 1/3 prête : cliquez séparément sur « Payer pour créer l’inscription » dans UniSat.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Impossible de préparer l’inscription de transfert.");
    } finally {
      setBusyAction("");
    }
  };

  const payForTransferInscription = () => {
    const provider = wallet();
    const current = progressRef.current;
    if (!provider?.sendBitcoin) { setMessage("Cette version UniSat ne fournit pas sendBitcoin."); return; }
    if (!current || getBrc20TransferNextAction(current) !== "pay") { setMessage("Aucun paiement d’inscription n’est prêt à être approuvé."); return; }
    if (!confirmed || !ownershipContextKey || ownershipProofKey !== ownershipContextKey || validatedRecipient !== recipient.trim()) {
      setMessage("Confirmez le destinataire, vérifiez son adresse et complétez la preuve de propriété avant le paiement."); return;
    }
    const attempted: Brc20TransferProgress = { ...current, recipient: recipient.trim(), paymentStarted: true };
    storeProgress(attempted);
    setBusyAction("paying");
    setMessage(`Approuvez maintenant le paiement de ${current.payAmount.toLocaleString()} sats dans UniSat pour créer l’inscription transférable.`);
    let paymentRequest: Promise<string | { txid?: string }>;
    try {
      // Call UniSat synchronously in this explicit click handler to preserve the wallet user gesture.
      paymentRequest = provider.sendBitcoin(current.payAddress, current.payAmount, { feeRate: current.feeRate });
    } catch (cause) {
      if (isUserRejection(cause)) storeProgress({ ...attempted, paymentStarted: false });
      setBusyAction("");
      setMessage(cause instanceof Error ? cause.message : "UniSat n’a pas pu ouvrir la demande de paiement.");
      return;
    }
    void (async () => {
      try {
        const paymentTxid = txidOf(await paymentRequest);
        if (!/^[a-f0-9]{64}$/i.test(paymentTxid)) throw new Error("UniSat n’a pas retourné de TXID certain. Vérifiez l’activité du wallet avant toute autre action.");
        const paid: Brc20TransferProgress = { ...attempted, paymentTxid };
        storeProgress(paid);
        setBusyAction("waiting");
        setMessage(`Paiement ${paymentTxid} transmis. Attente de la création de l’inscription transfer…`);
        const inscriptionId = await pollOrder(current.orderId);
        storeProgress({ ...paid, inscriptionId });
        setMessage(`Étape 2/3 terminée : l’inscription ${inscriptionId} est créée. Vérifiez l’adresse puis cliquez séparément sur « Envoyer l’inscription » pour transférer les tokens.`);
      } catch (cause) {
        if (isUserRejection(cause)) storeProgress({ ...attempted, paymentStarted: false, paymentTxid: "" });
        setMessage(cause instanceof Error ? cause.message : "Le paiement ou l’inscription est incertain. Vérifiez UniSat avant toute nouvelle tentative.");
      } finally {
        setBusyAction("");
      }
    })();
  };

  const checkOrder = async () => {
    const current = progressRef.current;
    if (!current?.orderId || current.inscriptionId) return;
    setBusyAction("waiting");
    setMessage(current.paymentTxid
      ? `Aucun nouveau paiement : vérification de l’inscription liée au TXID ${current.paymentTxid}…`
      : "Aucun nouveau paiement : vérification de l’ordre UniSat pour voir si le paiement a été reçu…");
    try {
      const inscriptionId = await pollOrder(current.orderId);
      storeProgress({ ...current, paymentStarted: true, inscriptionId });
      setMessage(`Étape 2/3 terminée : l’inscription ${inscriptionId} est créée. Vérifiez l’adresse puis cliquez séparément sur « Envoyer l’inscription » pour transférer les tokens.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "L’inscription n’est pas encore disponible. Aucun paiement supplémentaire n’a été envoyé.");
    } finally {
      setBusyAction("");
    }
  };

  const validateChangedRecipient = async () => {
    const candidate = recipient.trim();
    if (!candidate) { setMessage("Saisissez l’adresse destinataire à vérifier."); return; }
    setBusyAction("checking-recipient");
    try {
      await validateMempoolAddress(network, candidate);
      setValidatedRecipient(candidate);
      updateProgress({ recipient: candidate });
      setMessage(`Adresse validée pour ${chainLabel}. Confirmez-la et complétez la preuve de propriété avant l’envoi.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "L’adresse destinataire n’a pas pu être validée.");
    } finally {
      setBusyAction("");
    }
  };

  const sendTransferInscription = () => {
    const provider = wallet();
    const current = progressRef.current;
    if (!provider?.sendInscription) { setMessage("Cette version UniSat ne fournit pas sendInscription. L’inscription est créée, mais aucun envoi n’a été diffusé."); return; }
    if (!current?.inscriptionId || getBrc20TransferNextAction(current) !== "send-inscription") {
      setMessage("L’inscription transfer n’est pas prête ou un envoi précédent reste incertain."); return;
    }
    const target = recipient.trim();
    if (!target || validatedRecipient !== target || !confirmed) {
      setMessage("Vérifiez et confirmez l’adresse destinataire avant l’envoi."); return;
    }
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) {
      setMessage("Complétez à nouveau la preuve de propriété avant d’envoyer l’inscription."); return;
    }
    const attempted: Brc20TransferProgress = { ...current, recipient: target, transferStarted: true };
    storeProgress(attempted);
    setBusyAction("sending");
    setMessage(`Approuvez maintenant dans UniSat l’envoi de l’inscription ${current.inscriptionId} vers ${target}.`);
    let sendRequest: Promise<string | { txid?: string }>;
    try {
      // This is a separate explicit click: invoke the UniSat bridge before any awaited work.
      sendRequest = provider.sendInscription(target, current.inscriptionId, { feeRate: current.feeRate });
    } catch (cause) {
      if (isUserRejection(cause)) storeProgress({ ...attempted, transferStarted: false });
      setBusyAction("");
      setMessage(cause instanceof Error ? cause.message : "UniSat n’a pas pu ouvrir la demande d’envoi.");
      return;
    }
    void (async () => {
      try {
        const transferTxid = txidOf(await sendRequest);
        if (!/^[a-f0-9]{64}$/i.test(transferTxid)) throw new Error("UniSat n’a pas retourné de TXID certain. Vérifiez UniSat et Mempool avant tout nouvel essai.");
        storeProgress({ ...attempted, transferTxid });
        setMessage(`BRC-20 ${ticker} (${current.amount}) transféré vers ${target} · TXID ${transferTxid}`);
        onDone();
      } catch (cause) {
        if (isUserRejection(cause)) storeProgress({ ...attempted, transferStarted: false });
        setMessage(cause instanceof Error ? cause.message : "L’envoi de l’inscription est incertain. Vérifiez UniSat et Mempool avant toute nouvelle tentative.");
      } finally {
        setBusyAction("");
      }
    })();
  };

  const discardUnpaidOrder = () => {
    const current = progressRef.current;
    if (!current || current.paymentStarted || current.paymentTxid || current.inscriptionId) {
      setMessage("Un paiement a peut-être été envoyé : l’ordre ne peut pas être effacé sans vérification."); return;
    }
    clearProgress();
    setValidatedRecipient("");
    setMessage("Brouillon non payé abandonné. Aucun paiement n’a été demandé.");
  };
  const startAnotherTransfer = () => {
    clearProgress();
    setValidatedRecipient("");
    setAmountToTransfer(amount);
    setRecipient("");
    setConfirmed(false);
    setOwnershipProofKey(null);
    setMessage("Prêt pour une nouvelle inscription de transfert.");
  };

  const canPrepare = nextAction === "prepare" && !busyAction && Boolean(recipient.trim()) && confirmed &&
    validDecimal(amountToTransfer) && amountWithinBalance && ownershipProofKey === ownershipContextKey;
  const canPay = nextAction === "pay" && !busyAction && confirmed && ownershipProofKey === ownershipContextKey &&
    validatedRecipient === recipient.trim();
  const canSend = nextAction === "send-inscription" && !busyAction && Boolean(recipient.trim()) && confirmed &&
    validatedRecipient === recipient.trim() && ownershipProofKey === ownershipContextKey;

  return (
    <div className="mt-3 border border-[#d99a54]/50 bg-[#10151a] p-3">
      <p className="font-mono text-[10px] uppercase text-[#f2bd63]">
        Créer l’inscription puis envoyer · {kind === "prog" ? "BRC20-Prog" : "BRC-20 classique"} {ticker}
      </p>
      <p className="mt-1 font-mono text-[9px] leading-5 text-[#718092]">
        Réseau : {chainLabel} · disponible : <strong className="text-[#70c7a0]">{amount}</strong>. Trois actions distinctes : préparer l’ordre, approuver le paiement pour créer le montant transférable, puis envoyer l’inscription vers le destinataire.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          value={recipient}
          onChange={event => {
            const nextRecipient = event.target.value;
            setRecipient(nextRecipient);
            setConfirmed(false);
            setValidatedRecipient("");
            if (progressRef.current) updateProgress({ recipient: nextRecipient.trim() });
          }}
          disabled={Boolean(busyAction)}
          placeholder={`Adresse destinataire ${chainLabel}`}
          className="min-h-11 border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]"
        />
        <label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">
          Quantité {kind === "prog" ? "BRC20-Prog" : "BRC-20"}
          <input
            value={amountToTransfer}
            onChange={event => { setAmountToTransfer(event.target.value); setConfirmed(false); }}
            disabled={Boolean(busyAction) || Boolean(progress)}
            inputMode="decimal"
            className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-xs normal-case text-[#d9d3c6]"
          />
          <span className="mt-1 block normal-case text-[#718092]">
            Disponible : {amount} · frais : {activeFeeRate} sat/vB
          </span>
        </label>
      </div>
      {progress && progress.inscriptionId && validatedRecipient !== recipient.trim() && recipient.trim() && (
        <button
          type="button"
          onClick={() => void validateChangedRecipient()}
          disabled={Boolean(busyAction)}
          className="mt-2 min-h-10 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40"
        >
          {busyAction === "checking-recipient" ? "Vérification…" : "Vérifier la nouvelle adresse destinataire"}
        </button>
      )}
      <label className="mt-3 flex items-start gap-2 font-mono text-[10px] leading-5 text-[#d9d3d6]">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={event => setConfirmed(event.target.checked)}
          disabled={Boolean(busyAction)}
          className="mt-1 accent-[#d99a54]"
        />
        <span>
          <ShieldCheck size={12} className="mr-1 inline text-[#f2bd63]" />
          Je confirme l’adresse, le réseau et la quantité. Je comprends que l’inscription transférable est créée d’abord et que son envoi à l’adresse sera une approbation UniSat distincte.
        </span>
      </label>
      {confirmed && recipient.trim() && (
        <UniSatOwnershipProof
          key={`${ownershipContextKey}:${ownershipProofVersion}`}
          site={site}
          address={address}
          network={network}
          provider={wallet()}
          contextKey={ownershipContextKey}
          onVerified={setOwnershipProofKey}
        />
      )}

      {nextAction === "prepare" && (
        <button type="button" onClick={() => void prepareTransfer()} disabled={!canPrepare}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">
          {busyAction === "preparing" ? <><Loader2 size={13} className="animate-spin" /> Préparation…</> : <><Send size={13} /> 1 · Préparer l’inscription transférable</>}
        </button>
      )}
      {nextAction === "pay" && progress && (
        <button type="button" onClick={payForTransferInscription} disabled={!canPay}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">
          {busyAction === "paying" ? <><Loader2 size={13} className="animate-spin" /> Paiement…</> : <><Send size={13} /> 2 · Payer pour créer l’inscription</>}
        </button>
      )}
      {nextAction === "check-order" && progress && (
        <button type="button" onClick={() => void checkOrder()} disabled={Boolean(busyAction)}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#3b434d] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#d9d3c6] disabled:opacity-40">
          {busyAction === "waiting" ? <><Loader2 size={13} className="animate-spin" /> Attente de l’inscription…</> : <>Vérifier l’ordre et l’inscription</>}
        </button>
      )}
      {nextAction === "send-inscription" && progress && (
        <button type="button" onClick={sendTransferInscription} disabled={!canSend}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">
          {busyAction === "sending" ? <><Loader2 size={13} className="animate-spin" /> Envoi…</> : <><Send size={13} /> 3 · Envoyer l’inscription au destinataire</>}
        </button>
      )}
      {nextAction === "verify-transfer" && (
        <p className="mt-3 border border-[#d99a54]/50 p-2 font-mono text-[10px] text-[#f2bd63]">
          L’envoi a été demandé mais UniSat n’a pas retourné de TXID. Ne recommencez pas tout de suite : vérifiez l’activité UniSat et Mempool pour éviter un double envoi.
        </p>
      )}
      {nextAction === "complete" && (
        <button type="button" onClick={startAnotherTransfer} disabled={Boolean(busyAction)}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#3b434d] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#d9d3c6] disabled:opacity-40">
          <CheckCircle2 size={13} /> Terminé · préparer un autre transfert
        </button>
      )}
      {progress && nextAction === "pay" && (
        <button type="button" onClick={discardUnpaidOrder} disabled={Boolean(busyAction)}
          className="mt-2 w-full font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">
          Abandonner le brouillon non payé
        </button>
      )}
      {progress && (
        <p className="mt-2 break-all font-mono text-[9px] text-[#718092]">
          Ordre : {progress.orderId} · TXID paiement : {progress.paymentTxid || "en attente"} · Inscription transfer : {progress.inscriptionId || "en attente"} · TXID envoi : {progress.transferTxid || "en attente"}
        </p>
      )}
      {message && (
        <p className="mt-2 break-all border border-[#3b434d] p-2 font-mono text-[10px] text-[#d9d3c6]">{message}</p>
      )}
    </div>
  );
}
