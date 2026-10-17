import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Send, ShieldCheck } from "lucide-react";
import {
  describeFeeSources,
  getMempoolConfig,
  getRecommendedFeeEstimate,
  validateMempoolAddress,
} from "@/lib/mempool";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";
import { UniSatMobileOpenDappLink } from "@/components/UniSatMobileOpenDappLink";
import { sendOrdinalInscriptionWithCustomPsbt, type UniSatCustomTransferProvider } from "@/lib/custom-ordinal-transfer";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { sendNativeUniSatBitcoinPayment } from "@/lib/native-unisat-actions";
import { loadOwnedInscriptionsForMobileTransfer } from "@/lib/brc20-mobile-inscriptions";
import type { OrdinalTransferPlan } from "@/lib/ordinal-transfer-psbt";
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
  getBitcoinUtxos?: (cursor: number, size: number) => Promise<unknown>;
  getInscriptions?: (cursor: number, size: number) => Promise<{ total?: number; list?: Array<{ inscriptionId?: string; location?: string }> }>;
  signPsbt?: UniSatCustomTransferProvider["signPsbt"];
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
type MobilePsbtReview = { plan: OrdinalTransferPlan; recipient: string; inscriptionId: string; networkLabel: string; feeSourceLabel: string };
type MobilePsbtReviewResolver = { resolve: (result: boolean | string) => void; reject: (cause: unknown) => void };
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
  const [mobilePsbtReview, setMobilePsbtReview] = useState<MobilePsbtReview | null>(null);
  const [mobilePsbtSigning, setMobilePsbtSigning] = useState(false);
  const mobilePsbtReviewResolverRef = useRef<MobilePsbtReviewResolver | null>(null);
  const mobilePsbtSignerRef = useRef<((plan: OrdinalTransferPlan) => Promise<string>) | null>(null);
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

  useEffect(() => () => {
    mobilePsbtReviewResolverRef.current?.resolve(false);
    mobilePsbtReviewResolverRef.current = null;
    mobilePsbtSignerRef.current = null;
  }, []);

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
  const requestMobilePsbtReview = (review: MobilePsbtReview, provider: Wallet) => new Promise<boolean | string>((resolve, reject) => {
    if (!provider.signPsbt) { reject(new Error("UniSat mobile does not expose signPsbt; no transaction was signed or broadcast.")); return; }
    mobilePsbtReviewResolverRef.current = { resolve, reject };
    mobilePsbtSignerRef.current = plan => provider.signPsbt!(plan.psbtHex, {
      autoFinalized: false,
      toSignInputs: plan.inputs.map((input, index) => ({
        index,
        address,
        publicKey: plan.publicKeyHex,
        ...(input.spendType === "taproot" ? { useTweakedSigner: true } : {}),
      })),
    });
    setMobilePsbtReview(review);
  });
  const approveMobilePsbtSigning = () => {
    const review = mobilePsbtReview;
    const signer = mobilePsbtSignerRef.current;
    const pending = mobilePsbtReviewResolverRef.current;
    if (!review || !signer || !pending) return;
    setMobilePsbtSigning(true);
    setOwnershipProofKey(null);
    setOwnershipProofVersion(value => value + 1);
    setMessage("Review accepted. Confirm the separate PSBT signature request in UniSat; the site will validate it before broadcast.");
    try {
      // Dispatch UniSat signPsbt synchronously in this explicit tap handler.
      const signing = signer(review.plan);
      setMobilePsbtReview(null);
      mobilePsbtSignerRef.current = null;
      void signing
        .then(signedPsbt => pending.resolve(signedPsbt))
        .catch(cause => pending.reject(cause))
        .finally(() => {
          if (mobilePsbtReviewResolverRef.current === pending) mobilePsbtReviewResolverRef.current = null;
          setMobilePsbtSigning(false);
        });
    } catch (cause) {
      setMobilePsbtReview(null);
      mobilePsbtSignerRef.current = null;
      mobilePsbtReviewResolverRef.current = null;
      pending.reject(cause);
      setMobilePsbtSigning(false);
    }
  };
  const cancelMobilePsbtReview = () => {
    const pending = mobilePsbtReviewResolverRef.current;
    mobilePsbtReviewResolverRef.current = null;
    mobilePsbtSignerRef.current = null;
    setMobilePsbtReview(null);
    pending?.resolve(false);
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
    setMessage(restored ? "An in-progress BRC-20 transfer was restored for this wallet and network." : "");
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
      if (!response.ok || !data) throw new Error(data?.error || "Unable to read the UniSat order status.");
      const file = data.files?.find(item => typeof item.inscriptionId === "string");
      if (file?.inscriptionId) return file.inscriptionId;
      if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(String(data.status))) {
        throw new Error(`L’ordre d’inscription est ${data.status}.`);
      }
      await new Promise(resolve => window.setTimeout(resolve, 5000));
    }
    throw new Error("The inscription is not indexed yet. No second payment was sent; check the UniSat order and use “Verify inscription” to resume.");
  };

  const prepareTransfer = async () => {
    const provider = wallet();
    if (kind === "prog" && !/^[a-z0-9-]{6}$/i.test(ticker)) {
      setMessage("BRC20-Prog requires a 6-character ticker on Bitcoin or Fractal Bitcoin."); return;
    }
    if (!provider?.getPublicKey || !provider.getAccounts || !provider.getChain) {
      setMessage("UniSat must provide getAccounts, getChain, and getPublicKey. Update UniSat Wallet."); return;
    }
    if (!recipient.trim() || !confirmed) {
      setMessage("Enter the recipient address and confirm the ticker, network, and amount."); return;
    }
    if (!validDecimal(amountToTransfer) || !amountWithinBalance) {
      setMessage(`The amount must be greater than zero and no more than the available balance (${amount}).`); return;
    }
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) {
      setMessage("Complete the BIP-322 ownership proof for this address, network, recipient, and amount."); return;
    }
    if (progressRef.current) {
      setMessage("A transfer order already exists for this ticker. Resume the displayed step instead of creating another one."); return;
    }
    setBusyAction("preparing");
    setMessage("");
    try {
      const [accounts, chain, publicKey] = await Promise.all([
        provider.getAccounts(), provider.getChain(), provider.getPublicKey(),
      ]);
      if (chain?.enum !== network || !accounts.includes(address)) {
        throw new Error("The UniSat account or network changed. No order was created.");
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
        throw new Error(order?.error || "UniSat did not create the inscription order.");
      }
      const next: Brc20TransferProgress = {
        version: 1, ...identity, amount: amountToTransfer, recipient: recipient.trim(),
        orderId: order.orderId, payAddress: order.payAddress, payAmount: orderAmount, feeRate: liveFeeRate,
        paymentStarted: false, paymentTxid: "", inscriptionId: "", transferStarted: false, transferTxid: "",
      };
      storeProgress(next);
      setValidatedRecipient(recipient.trim());
      setMessage(`Order created · ${orderAmount.toLocaleString()} sats. Step 1/3 is ready: separately select “Pay to create inscription” in UniSat.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to prepare the transfer inscription.");
    } finally {
      setBusyAction("");
    }
  };

  const payForTransferInscription = () => {
    const provider = wallet();
    const current = progressRef.current;
    if (!provider?.sendBitcoin) { setMessage("This UniSat version does not provide sendBitcoin."); return; }
    if (!current || getBrc20TransferNextAction(current) !== "pay") { setMessage("No inscription payment is ready for approval."); return; }
    if (!confirmed || !ownershipContextKey || ownershipProofKey !== ownershipContextKey || validatedRecipient !== recipient.trim()) {
      setMessage("Confirm the recipient, verify the address, and complete the ownership proof before payment."); return;
    }
    const attempted: Brc20TransferProgress = { ...current, recipient: recipient.trim(), paymentStarted: true };
    storeProgress(attempted);
    setBusyAction("paying");
    setMessage(`Approve the ${current.payAmount.toLocaleString()} sats payment in UniSat to create the transferable inscription.`);
    let paymentRequest: Promise<string | { txid?: string }>;
    try {
      // Call UniSat synchronously in this explicit click handler to preserve the wallet user gesture.
      paymentRequest = sendNativeUniSatBitcoinPayment(provider, current.payAddress, current.payAmount, current.feeRate);
    } catch (cause) {
      if (isUserRejection(cause)) storeProgress({ ...attempted, paymentStarted: false });
      setBusyAction("");
      setMessage(cause instanceof Error ? cause.message : "UniSat could not open the payment request.");
      return;
    }
    void (async () => {
      try {
        const paymentTxid = txidOf(await paymentRequest);
        if (!/^[a-f0-9]{64}$/i.test(paymentTxid)) throw new Error("UniSat did not return a confirmed TXID. Check wallet activity before taking any further action.");
        const paid: Brc20TransferProgress = { ...attempted, paymentTxid };
        storeProgress(paid);
        setBusyAction("waiting");
        setMessage(`Payment ${paymentTxid} submitted. Waiting for the transfer inscription to be created…`);
        const inscriptionId = await pollOrder(current.orderId);
        storeProgress({ ...paid, inscriptionId });
        setMessage(`Step 2/3 complete: inscription ${inscriptionId} was created. Verify the address, then separately select “Send inscription” to transfer the tokens.`);
      } catch (cause) {
        if (isUserRejection(cause)) storeProgress({ ...attempted, paymentStarted: false, paymentTxid: "" });
        setMessage(cause instanceof Error ? cause.message : "Payment or inscription status is uncertain. Check UniSat before retrying.");
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
      ? `No new payment: checking the inscription linked to TXID ${current.paymentTxid}…`
      : "No new payment: checking the UniSat order to see if payment was received…");
    try {
      const inscriptionId = await pollOrder(current.orderId);
      storeProgress({ ...current, paymentStarted: true, inscriptionId });
      setMessage(`Step 2/3 complete: inscription ${inscriptionId} was created. Verify the address, then separately select “Send inscription” to transfer the tokens.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The inscription is not available yet. No additional payment was sent.");
    } finally {
      setBusyAction("");
    }
  };

  const validateChangedRecipient = async () => {
    const candidate = recipient.trim();
    if (!candidate) { setMessage("Enter the recipient address to verify."); return; }
    setBusyAction("checking-recipient");
    try {
      await validateMempoolAddress(network, candidate);
      setValidatedRecipient(candidate);
      updateProgress({ recipient: candidate });
      setMessage(`Address verified for ${chainLabel}. Confirm it and complete the ownership proof before sending.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The recipient address could not be validated.");
    } finally {
      setBusyAction("");
    }
  };

  const sendMobileTransferInscription = async (
    provider: Wallet,
    current: Brc20TransferProgress,
    target: string,
    attempted: Brc20TransferProgress,
  ) => {
    let broadcastMayHaveStarted = false;
    setBusyAction("sending");
    setMessage(`Preparing a verified ${chainLabel} PSBT for inscription ${current.inscriptionId}…`);
    try {
      if (!provider.getChain || !provider.getAccounts || !provider.getPublicKey || !provider.getBitcoinUtxos || !provider.getInscriptions || !provider.signPsbt) {
        throw new Error("Open this site in the updated UniSat Mobile in-app browser with getInscriptions, getBitcoinUtxos, and signPsbt. No transaction was signed or broadcast.");
      }
      const mempool = getMempoolConfig(network);
      if (!mempool) throw new Error("The selected network Mempool is not configured; no transaction was signed or broadcast.");
      await validateMempoolAddress(network, target);
      const ownedInscriptions = await loadOwnedInscriptionsForMobileTransfer(provider, current.inscriptionId);
      const selectedInscription = ownedInscriptions.find(item => item.inscriptionId.toLowerCase() === current.inscriptionId.toLowerCase());
      if (!selectedInscription?.location) throw new Error("UniSat has not returned the transfer inscription's current outpoint. Refresh and verify the order; no transaction was signed or broadcast.");
      const feeEstimate = await getRecommendedFeeEstimate(network);
      const psbtProvider: UniSatCustomTransferProvider = {
        getBitcoinUtxos: provider.getBitcoinUtxos.bind(provider),
        getPublicKey: provider.getPublicKey.bind(provider),
        getAccounts: provider.getAccounts.bind(provider),
        getChain: provider.getChain.bind(provider),
        signPsbt: provider.signPsbt.bind(provider),
      };
      const result = await sendOrdinalInscriptionWithCustomPsbt({
        provider: psbtProvider,
        mempool: { api: mempool.api, label: mempool.label, chain: network === "BITCOIN_MAINNET" ? "bitcoin" : "fractal" },
        expectedNetworkEnum: network,
        currentAddress: address,
        recipientAddress: target,
        selectedInscription,
        ownedInscriptions,
        feeRateSatVb: feeEstimate.feeRate,
        beforeSign: plan => requestMobilePsbtReview({
          plan,
          recipient: target,
          inscriptionId: current.inscriptionId,
          networkLabel: mempool.label,
          feeSourceLabel: describeFeeSources(feeEstimate.strategy, feeEstimate.sources),
        }, provider),
        beforeBroadcast: async publicKeyHex => {
          const [latestChain, latestAccounts, latestPublicKey] = await Promise.all([
            provider.getChain!(), provider.getAccounts!(), provider.getPublicKey!(),
          ]);
          if (latestChain.enum !== network || !latestAccounts.includes(address) || latestPublicKey.toLowerCase() !== publicKeyHex.toLowerCase()) {
            throw new Error("The UniSat account, key, or network changed before broadcast. The signed transaction was not submitted.");
          }
          if (progressRef.current?.orderId !== current.orderId || progressRef.current.inscriptionId !== current.inscriptionId || !progressRef.current.transferStarted) {
            throw new Error("The BRC-20 transfer state changed before broadcast. The signed transaction was not submitted.");
          }
          broadcastMayHaveStarted = true;
        },
      });
      if (!/^[a-f0-9]{64}$/i.test(result.txid)) throw new Error("The transfer did not return a valid TXID. Check UniSat and Mempool before retrying.");
      storeProgress({ ...attempted, transferTxid: result.txid });
      setMessage(`BRC-20 ${ticker} (${current.amount}) transferred to ${target} · TXID ${result.txid}`);
      onDone();
    } catch (cause) {
      if (!broadcastMayHaveStarted) storeProgress({ ...attempted, transferStarted: false });
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage(!broadcastMayHaveStarted
        ? `${detail} No transaction was broadcast. You may retry after correcting the issue.`
        : `${detail} The broadcast outcome may be uncertain. Check UniSat and the ${chainLabel} Mempool before retrying to avoid a duplicate transfer.`);
    } finally {
      setBusyAction("");
    }
  };

  const sendTransferInscription = () => {
    const provider = wallet();
    const current = progressRef.current;
    const mobile = isMobileUniSatDevice();
    if (!provider) { setMessage("UniSat is not available in this browser. Open the site in the UniSat in-app browser; nothing was sent."); return; }
    if (!mobile && !provider.sendInscription) { setMessage("This UniSat desktop version does not provide sendInscription. The inscription was created, but nothing was broadcast."); return; }
    if (mobile && (!provider.getInscriptions || !provider.getBitcoinUtxos || !provider.getPublicKey || !provider.getAccounts || !provider.getChain || !provider.signPsbt)) {
      setMessage("This mobile browser does not expose the verified PSBT methods. Open the site inside the updated UniSat Mobile app; nothing was sent."); return;
    }
    if (!current?.inscriptionId || getBrc20TransferNextAction(current) !== "send-inscription") {
      setMessage("The transfer inscription is not ready, or a previous send is still uncertain."); return;
    }
    const target = recipient.trim();
    if (!target || validatedRecipient !== target || !confirmed) {
      setMessage("Verify and confirm the recipient address before sending."); return;
    }
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) {
      setMessage("Complete the ownership proof again before sending the inscription."); return;
    }
    const attempted: Brc20TransferProgress = { ...current, recipient: target, transferStarted: true };
    storeProgress(attempted);
    if (mobile) {
      void sendMobileTransferInscription(provider, current, target, attempted);
      return;
    }
    if (!provider.sendInscription) { setMessage("This UniSat desktop version does not provide sendInscription. The inscription was created, but nothing was broadcast."); return; }
    setBusyAction("sending");
    setMessage(`Review the inscription transfer to ${target} in the separate UniSat approval step.`);
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
        if (!/^[a-f0-9]{64}$/i.test(transferTxid)) throw new Error("UniSat did not return a confirmed TXID. Check UniSat and Mempool before trying again.");
        storeProgress({ ...attempted, transferTxid });
        setMessage(`BRC-20 ${ticker} (${current.amount}) transferred to ${target} · TXID ${transferTxid}`);
        onDone();
      } catch (cause) {
        if (isUserRejection(cause)) storeProgress({ ...attempted, transferStarted: false });
        setMessage(cause instanceof Error ? cause.message : "Inscription send status is uncertain. Check UniSat and Mempool before retrying.");
      } finally {
        setBusyAction("");
      }
    })();
  };

  const discardUnpaidOrder = () => {
    const current = progressRef.current;
    if (!current || current.paymentStarted || current.paymentTxid || current.inscriptionId) {
      setMessage("A payment may have been sent: the order cannot be cleared without verification."); return;
    }
    clearProgress();
    setValidatedRecipient("");
    setMessage("Unpaid draft discarded. No payment was requested.");
  };
  const startAnotherTransfer = () => {
    clearProgress();
    setValidatedRecipient("");
    setAmountToTransfer(amount);
    setRecipient("");
    setConfirmed(false);
    setOwnershipProofKey(null);
    setMessage("Ready for a new transfer inscription.");
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
        Create inscription, then send · {kind === "prog" ? "BRC20-Prog" : "Classic BRC-20"} {ticker}
      </p>
      <p className="mt-1 font-mono text-[9px] leading-5 text-[#718092]">
        Network: {chainLabel} · available: <strong className="text-[#70c7a0]">{amount}</strong>. Three separate actions: prepare the order, approve payment to create the transferable amount, then send the inscription to the recipient.
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
          placeholder={`Recipient address · ${chainLabel}`}
          className="min-h-11 border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]"
        />
        <label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">
          Amount {kind === "prog" ? "BRC20-Prog" : "BRC-20"}
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
          {busyAction === "checking-recipient" ? "Verifying…" : "Verify new recipient address"}
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
          I confirm the address, network, and amount. I understand that the transferable inscription is created first, and sending it to the address requires a separate UniSat approval.
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
          {busyAction === "preparing" ? <><Loader2 size={13} className="animate-spin" /> Preparing…</> : <><Send size={13} /> 1 · Prepare transferable inscription</>}
        </button>
      )}
      {nextAction === "pay" && progress && (
        <button type="button" onClick={payForTransferInscription} disabled={!canPay}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">
          {busyAction === "paying" ? <><Loader2 size={13} className="animate-spin" /> Paying…</> : <><Send size={13} /> 2 · Pay to create inscription</>}
        </button>
      )}
      {nextAction === "check-order" && progress && (
        <button type="button" onClick={() => void checkOrder()} disabled={Boolean(busyAction)}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#3b434d] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#d9d3c6] disabled:opacity-40">
          {busyAction === "waiting" ? <><Loader2 size={13} className="animate-spin" /> Waiting for inscription…</> : <>Verify order and inscription</>}
        </button>
      )}
      {nextAction === "send-inscription" && progress && (
        <button type="button" onClick={sendTransferInscription} disabled={!canSend}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">
          {busyAction === "sending" ? <><Loader2 size={13} className="animate-spin" /> Sending…</> : <><Send size={13} /> 3 · Send inscription to recipient</>}
        </button>
      )}
      {nextAction === "verify-transfer" && (
        <p className="mt-3 border border-[#d99a54]/50 p-2 font-mono text-[10px] text-[#f2bd63]">
          The transfer was requested, but no TXID was confirmed. Do not retry yet: check UniSat and the {chainLabel} Mempool to avoid sending twice.
        </p>
      )}
      {nextAction === "complete" && (
        <button type="button" onClick={startAnotherTransfer} disabled={Boolean(busyAction)}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#3b434d] px-4 py-2 font-mono text-[10px] font-semibold uppercase text-[#d9d3c6] disabled:opacity-40">
          <CheckCircle2 size={13} /> Done · prepare another transfer
        </button>
      )}
      {progress && nextAction === "pay" && (
        <button type="button" onClick={discardUnpaidOrder} disabled={Boolean(busyAction)}
          className="mt-2 w-full font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">
          Discard unpaid draft
        </button>
      )}
      {progress && (
        <p className="mt-2 break-all font-mono text-[9px] text-[#718092]">
          Order: {progress.orderId} · Payment TXID: {progress.paymentTxid || "pending"} · Transfer inscription: {progress.inscriptionId || "pending"} · Send TXID: {progress.transferTxid || "pending"}
        </p>
      )}
      {message && (
        <p className="mt-2 break-all border border-[#3b434d] p-2 font-mono text-[10px] text-[#d9d3c6]">{message}</p>
      )}
      {nextAction === "send-inscription" && (
        <UniSatMobileOpenDappLink
          site={site}
          walletMethodAvailable={Boolean(wallet()?.signPsbt && wallet()?.getInscriptions && wallet()?.getBitcoinUtxos && wallet()?.getPublicKey && wallet()?.getAccounts && wallet()?.getChain)}
          methodLabel="verified PSBT signing (signPsbt and inscription/UTXO access)"
        />
      )}
      {mobilePsbtReview && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/80 p-2 sm:items-center sm:p-5" role="presentation">
          <section className="max-h-[92vh] w-full max-w-xl overflow-y-auto border border-[#d99a54] bg-[#10151a] p-4 font-mono text-[#d9d3c6] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="brc20-mobile-psbt-title">
            <h2 id="brc20-mobile-psbt-title" className="text-xs font-semibold uppercase tracking-[0.12em] text-[#f2bd63]">Review mobile BRC-20 transfer</h2>
            <p className="mt-2 text-[10px] leading-5 text-[#9ea7b3]">UniSat will sign this PSBT. The site will verify the signed transaction and broadcast it to the selected Mempool only after those checks pass.</p>
            <dl className="mt-3 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-2 break-all border border-[#3b434d] bg-[#0b0d10] p-3 text-[10px]">
              <dt className="text-[#718092]">Network</dt><dd>{mobilePsbtReview.networkLabel}</dd>
              <dt className="text-[#718092]">Recipient</dt><dd>{mobilePsbtReview.recipient}</dd>
              <dt className="text-[#718092]">Transfer inscription</dt><dd>{mobilePsbtReview.inscriptionId}</dd>
              <dt className="text-[#718092]">Wallet address</dt><dd>{address}</dd>
              <dt className="text-[#718092]">Fee rate</dt><dd>{mobilePsbtReview.plan.feeRateSatVb} sat/vB</dd>
              <dt className="text-[#718092]">Estimated network fee</dt><dd>{mobilePsbtReview.plan.feeSats.toLocaleString()} sats</dd>
              <dt className="text-[#718092]">Recipient output</dt><dd>{mobilePsbtReview.plan.recipientOutputSats.toLocaleString()} sats</dd>
              <dt className="text-[#718092]">Wallet change</dt><dd>{mobilePsbtReview.plan.changeOutputSats.toLocaleString()} sats</dd>
              <dt className="text-[#718092]">Inputs</dt><dd>{mobilePsbtReview.plan.inputs.length} · {mobilePsbtReview.plan.totalInputSats.toLocaleString()} sats</dd>
              <dt className="text-[#718092]">Fee source</dt><dd>{mobilePsbtReview.feeSourceLabel}</dd>
            </dl>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={cancelMobilePsbtReview} disabled={mobilePsbtSigning} className="min-h-11 border border-[#3b434d] px-3 py-2 text-[10px] uppercase text-[#d9d3c6] disabled:opacity-40">Cancel — do not sign</button>
              <button type="button" onClick={approveMobilePsbtSigning} disabled={mobilePsbtSigning} className="min-h-11 border border-[#d99a54] bg-[#d99a54] px-3 py-2 text-[10px] font-semibold uppercase text-[#0b0d10] disabled:opacity-40">{mobilePsbtSigning ? "Waiting for UniSat…" : "Sign PSBT with UniSat"}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
