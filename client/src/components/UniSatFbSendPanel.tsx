import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { describeFeeSources, getRecommendedFeeEstimate, trackMempoolTransaction, validateMempoolAddress, type FeeEstimate, type MempoolReceipt } from "@/lib/mempool";
import { normalizeUniSatTxid, parseFbAmountToSats } from "@/lib/native-fb-send";
import { ensureNativePaymentBalance, getMobileUtxoErrorGuidance, sendNativeUniSatBitcoinPayment } from "@/lib/native-unisat-actions";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { UniSatMobileOpenDappLink } from "@/components/UniSatMobileOpenDappLink";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";

const FRACTAL_NETWORK = "FRACTAL_BITCOIN_MAINNET";
const BITCOIN_NETWORK = "BITCOIN_MAINNET";
// Keep the legacy key so receipts saved by the mobile panel remain readable.
const STORAGE_PREFIX = "fractal-mobile-fb-send:v1:";
type Chain = { enum?: string; name?: string };
type Provider = {
  sendBitcoin?: (address: string, satoshis: number, options?: { feeRate?: number }) => Promise<string | { txid?: string }>;
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<Chain>;
  switchChain?: (chain: "FRACTAL_BITCOIN_MAINNET") => Promise<Chain>;
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
};
type NativeFbReceipt = {
  txid: string; network: string; sender: string; recipient: string; amountSats: number;
  feeRate: number; feeSource: string; createdAt: string; mempool: MempoolReceipt;
};

function storageKey(address: string) { return `${STORAGE_PREFIX}${address.toLowerCase()}`; }
function saveReceipt(address: string, receipt: NativeFbReceipt) { try { localStorage.setItem(storageKey(address), JSON.stringify(receipt)); } catch { /* private mode or storage quota */ } }
function readReceipt(address: string): NativeFbReceipt | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(address)) ?? "null") as Partial<NativeFbReceipt> | null;
    if (!value || typeof value.txid !== "string" || !/^[a-f0-9]{64}$/i.test(value.txid) || value.network !== "Fractal Bitcoin" || value.sender !== address || typeof value.recipient !== "string" || !Number.isSafeInteger(value.amountSats) || !Number.isFinite(value.feeRate) || typeof value.feeSource !== "string" || typeof value.createdAt !== "string" || !value.mempool || value.mempool.txid !== value.txid) return null;
    return value as NativeFbReceipt;
  } catch { return null; }
}

export function UniSatFbSendPanel({ provider, address, chain, network, onWalletRefresh, onSwitchToFractal, walletBusy, site = "pokedex" }: { provider?: Provider; address: string; chain: Chain | null; network?: "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET"; onWalletRefresh: () => void; onSwitchToFractal: () => void; walletBusy: boolean; site?: "punks" | "pokedex" }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [feeError, setFeeError] = useState("");
  const [receipt, setReceipt] = useState<NativeFbReceipt | null>(() => address ? readReceipt(address) : null);
  const [outcomeUnclear, setOutcomeUnclear] = useState(() => {
    try { return typeof window !== "undefined" && Boolean(address) && sessionStorage.getItem(`${storageKey(address)}:unclear`) === "1"; }
    catch { return false; }
  });
  const [outcomeChecked, setOutcomeChecked] = useState(false);
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const [ownershipProofVersion, setOwnershipProofVersion] = useState(0);
  const activeNetwork = network ?? FRACTAL_NETWORK;
  const isBitcoin = activeNetwork === BITCOIN_NETWORK;
  const assetLabel = isBitcoin ? "BTC" : "FB";
  const networkLabel = isBitcoin ? "Bitcoin" : "Fractal Bitcoin";
  const [mobileReadyContextKey, setMobileReadyContextKey] = useState<string | null>(null);
  const runningTxidRef = useRef("");
  const sats = parseFbAmountToSats(amount);
  const connected = Boolean(address && chain?.enum === activeNetwork);
  const ownershipContextKey = recipient.trim() && sats ? JSON.stringify(["fb-transfer", site, address, chain?.enum, recipient.trim(), sats]) : "";
  const currentMobilePreflightKey = ownershipContextKey && feeEstimate && Number.isFinite(feeEstimate.feeRate) && feeEstimate.feeRate > 0
    ? `${ownershipContextKey}:${Math.ceil(feeEstimate.feeRate)}`
    : "";
  const mobileReady = isMobileUniSatDevice() && Boolean(currentMobilePreflightKey) && mobileReadyContextKey === currentMobilePreflightKey;
  useEffect(() => {
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    setMobileReadyContextKey(null);
  }, [ownershipContextKey]);
  useEffect(() => {
    if (!ownershipProofKey) setMobileReadyContextKey(null);
  }, [ownershipProofKey]);

  const refreshFees = async () => {
    try { const estimate = await getRecommendedFeeEstimate(activeNetwork); setFeeEstimate(estimate); setFeeError(""); }
    catch (cause) { setFeeError(cause instanceof Error ? cause.message : "Impossible de lire les frais Fractal en direct."); }
  };
  useEffect(() => {
    setReceipt(address ? readReceipt(address) : null);
    try { setOutcomeUnclear(Boolean(address) && sessionStorage.getItem(`${storageKey(address)}:unclear`) === "1"); }
    catch { setOutcomeUnclear(false); }
    setOutcomeChecked(false);
    setConfirmed(false);
    setRecipient("");
    setAmount("");
    setError("");
  }, [address, chain?.enum]);
  useEffect(() => {
    if (!connected) {
      setFeeEstimate(null);
      setFeeError("");
      return;
    }
    void refreshFees();
    const timer = window.setInterval(() => void refreshFees(), 30_000);
    return () => window.clearInterval(timer);
  }, [connected]);

  const updateReceipt = (next: NativeFbReceipt) => { setReceipt(next); saveReceipt(next.sender, next); };
  const startTracking = (activeReceipt: NativeFbReceipt) => {
    if (runningTxidRef.current === activeReceipt.txid) return;
    runningTxidRef.current = activeReceipt.txid;
    void trackMempoolTransaction(activeReceipt.txid, activeNetwork, update => {
      setReceipt(current => {
        if (!current || current.txid !== activeReceipt.txid) return current;
        const next = { ...current, mempool: update };
        saveReceipt(current.sender, next);
        return next;
      });
    }).catch(cause => {
      setReceipt(current => {
        if (!current || current.txid !== activeReceipt.txid) return current;
        const next = { ...current, mempool: { ...current.mempool, status: "error" as const, message: cause instanceof Error ? cause.message : "Suivi Mempool indisponible.", checkedAt: new Date().toISOString() } };
        saveReceipt(current.sender, next);
        return next;
      });
    }).finally(() => { if (runningTxidRef.current === activeReceipt.txid) runningTxidRef.current = ""; });
  };

  const openMobilePayment = () => {
    const to = recipient.trim();
    const estimate = feeEstimate;
    if (!isMobileUniSatDevice() || !ownershipContextKey || !mobileReady || ownershipProofKey !== ownershipContextKey) { setError("The wallet ownership check or mobile pre-check is no longer valid. Restart before any payment."); return; }
    if (!connected || !provider?.sendBitcoin || !estimate || !sats || !confirmed || outcomeUnclear) { setError("The wallet, preview, or confirmation no longer matches this send."); return; }
    const feeRate = Math.ceil(estimate.feeRate);
    if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 10_000) { setError("The live fee rate is invalid; no send was requested."); return; }
    setError("");
    setSending(true);
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    setMobileReadyContextKey(null);
    let paymentPromise: Promise<unknown>;
    try {
      // Open the UniSat transaction prompt synchronously from this explicit tap.
      paymentPromise = sendNativeUniSatBitcoinPayment(provider, to, sats, feeRate);
    } catch (cause) {
      setSending(false);
      setError(getMobileUtxoErrorGuidance(cause, "fb-transfer")?.message ?? (cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    void Promise.resolve(paymentPromise)
      .then(result => {
        const txid = normalizeUniSatTxid(result);
        if (!txid) {
          setOutcomeUnclear(true);
          try { sessionStorage.setItem(`${storageKey(address)}:unclear`, "1"); } catch { /* in-memory safety lock remains */ }
          throw new Error("UniSat did not return a valid TXID; the outcome is uncertain. Check UniSat activity and Mempool before retrying.");
        }
        const config = activeNetwork === BITCOIN_NETWORK
          ? { api: "https://mempool.space", explorer: "https://mempool.space/tx/", label: "Bitcoin" }
          : { api: "https://mempool.fractalbitcoin.io", explorer: "https://mempool.fractalbitcoin.io/tx/", label: "Fractal Bitcoin" };
        const initialMempool: MempoolReceipt = { txid, network: config.label, status: "checking", message: "Searching for the transaction in Mempool…", blockHeight: null, explorerUrl: `${config.explorer}${encodeURIComponent(txid)}`, checkedAt: new Date().toISOString() };
        const next: NativeFbReceipt = { txid, network: config.label, sender: address, recipient: to, amountSats: sats, feeRate, feeSource: describeFeeSources(estimate.strategy, estimate.sources), createdAt: new Date().toISOString(), mempool: initialMempool };
        updateReceipt(next);
        setConfirmed(false);
        setRecipient("");
        setAmount("");
        onWalletRefresh();
        window.setTimeout(onWalletRefresh, 3000);
        startTracking(next);
      })
      .catch(cause => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
        const cancelled = code === 4001 || /user (rejected|denied)|cancelled by user|request rejected/i.test(message);
        const mobileUtxoGuidance = getMobileUtxoErrorGuidance(cause, "fb-transfer");
        if (!cancelled && !mobileUtxoGuidance?.definitelyNotBroadcast) {
          setOutcomeUnclear(true);
          try { sessionStorage.setItem(`${storageKey(address)}:unclear`, "1"); } catch { /* in-memory safety lock remains */ }
        }
        setError(mobileUtxoGuidance?.message ?? (message || "L’envoi UniSat a échoué ou a été refusé."));
      })
      .finally(() => setSending(false));
  };

  const send = async () => {
    setError("");
    if (isMobileUniSatDevice() && mobileReady) { openMobilePayment(); return; }
    if (outcomeUnclear) { setError("Un envoi précédent a une issue incertaine. Vérifie UniSat et Mempool avant toute nouvelle demande."); return; }
    let walletPromptOpened = false;
    if (!connected || !provider?.sendBitcoin || !provider.getChain) { setError("Connect UniSat to the selected network mainnet before sending."); return; }
    if (!sats) { setError("Enter a valid {assetLabel} amount greater than zero with up to 8 decimals."); return; }
    const to = recipient.trim();
    if (!to || to.length > 100) { setError("Enter a valid receiving address."); return; }
    if (!confirmed) { setError("Verify the network, address and amount, then check the confirmation."); return; }
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) { setError("Complete the wallet ownership check shown below the preview first."); return; }
    setSending(true);
    try {
      const [accounts, currentChain] = await Promise.all([provider.getAccounts?.(), provider.getChain()]);
      if (currentChain.enum !== activeNetwork || (accounts && !accounts.includes(address))) throw new Error("The UniSat account or network changed. No send was requested; refresh the wallet and try again.");
      await validateMempoolAddress(activeNetwork, to);
      const estimate = await getRecommendedFeeEstimate(activeNetwork);
      if (!Number.isFinite(estimate.feeRate) || estimate.feeRate < 1 || estimate.feeRate > 10_000) throw new Error("The live fee rate is invalid; no send was requested.");
      setFeeEstimate(estimate);
      setFeeError("");
      const feeRate = Math.ceil(estimate.feeRate);
      await ensureNativePaymentBalance(activeNetwork, address, sats, feeRate, "fb-transfer", { mobile: isMobileUniSatDevice() });
      if (isMobileUniSatDevice()) {
        setMobileReadyContextKey(`${ownershipContextKey}:${feeRate}`);
        setError("Pre-check complete. Tap again to open transaction approval in UniSat.");
        return;
      }
      walletPromptOpened = true;
      const result = await sendNativeUniSatBitcoinPayment(provider, to, sats, feeRate);
      const txid = normalizeUniSatTxid(result);
      if (!txid) {
        setOutcomeUnclear(true);
        try { sessionStorage.setItem(`${storageKey(address)}:unclear`, "1"); } catch { /* in-memory safety lock remains */ }
        throw new Error("UniSat did not return a valid TXID; the outcome is uncertain. Check UniSat activity and Mempool before retrying.");
      }
      const config = activeNetwork === BITCOIN_NETWORK
          ? { api: "https://mempool.space", explorer: "https://mempool.space/tx/", label: "Bitcoin" }
          : { api: "https://mempool.fractalbitcoin.io", explorer: "https://mempool.fractalbitcoin.io/tx/", label: "Fractal Bitcoin" };
      const initialMempool: MempoolReceipt = { txid, network: config.label, status: "checking", message: "Searching for the transaction in Mempool…", blockHeight: null, explorerUrl: `${config.explorer}${encodeURIComponent(txid)}`, checkedAt: new Date().toISOString() };
      const next: NativeFbReceipt = { txid, network: config.label, sender: address, recipient: to, amountSats: sats, feeRate, feeSource: describeFeeSources(estimate.strategy, estimate.sources), createdAt: new Date().toISOString(), mempool: initialMempool };
      updateReceipt(next);
      setConfirmed(false);
      setRecipient("");
      setAmount("");
      onWalletRefresh();
      if (isMobileUniSatDevice()) window.setTimeout(onWalletRefresh, 3000);
      startTracking(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
      const cancelled = code === 4001 || /user (rejected|denied)|cancelled by user|request rejected/i.test(message);
      const mobileUtxoGuidance = isMobileUniSatDevice() ? getMobileUtxoErrorGuidance(cause, "fb-transfer") : null;
      if (walletPromptOpened && !cancelled && !mobileUtxoGuidance?.definitelyNotBroadcast) {
        setOutcomeUnclear(true);
        try { sessionStorage.setItem(`${storageKey(address)}:unclear`, "1"); } catch { /* in-memory safety lock remains */ }
      }
      setError(mobileUtxoGuidance?.message ?? (message || "L’envoi UniSat a échoué ou a été refusé."));
    } finally { setSending(false); }
  };

  return <section className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:p-4" aria-labelledby="fb-send-title">
    <UniSatMobileOpenDappLink site={site} walletMethodAvailable={typeof provider?.sendBitcoin === "function"} methodLabel="sendBitcoin" />
    <div className="flex items-start gap-2"><Send size={15} className="mt-0.5 shrink-0 text-[#f2bd63]" /><div><p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#d99a54]">Dashboard UniSat · {networkLabel}</p><h3 id="fb-send-title" className="mt-1 font-display text-lg text-[#f3efe5]">Envoyer des {assetLabel}</h3><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">Disponible sur desktop et mobile. UniSat affiche la transaction finale et exige ton approbation. Un {assetLabel} vaut 100 000 000 sats.</p></div></div>
    {!connected ? <div className="mt-3 border border-[#3b434d] p-3 font-mono text-[10px] text-[#e0b45f]" role="status"><p>Transfers require the selected Bitcoin network. {(!isBitcoin && provider?.switchChain) ? "You can request the network switch below." : "Select this network in UniSat, then try again."}</p>{!isBitcoin && provider?.switchChain && <button type="button" onClick={() => void onSwitchToFractal()} disabled={walletBusy || sending} className="mt-2 min-h-10 border border-[#d99a54] px-3 py-2 uppercase tracking-[0.08em] text-[#f2bd63] disabled:opacity-40">Switch UniSat to Fractal Bitcoin</button>}</div> : <>
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">Recipient address<input value={recipient} onChange={event => { setRecipient(event.target.value); setConfirmed(false); }} autoComplete="off" spellCheck={false} inputMode="text" maxLength={100} className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 py-2 font-mono text-xs normal-case text-[#f3efe5] outline-none focus:border-[#d99a54]" placeholder="Adresse {networkLabel}" /></label><label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">Amount to send ({assetLabel})<input value={amount} onChange={event => { setAmount(event.target.value); setConfirmed(false); }} autoComplete="off" inputMode="decimal" type="text" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 py-2 font-mono text-xs normal-case text-[#f3efe5] outline-none focus:border-[#d99a54]" placeholder="0.00000000" /></label></div>
      <div className="mt-3 flex items-center justify-between gap-3 border border-[#3b434d] bg-[#0b0d10] px-3 py-2 font-mono text-[10px]"><span className="text-[#9ea7b3]">Network fee · ~30 min target</span><strong className="text-[#f2bd63]">{feeEstimate ? `${Math.ceil(feeEstimate.feeRate)} sat/vB` : "Unavailables"}</strong><button type="button" onClick={() => void refreshFees()} aria-label="Actualiser les frais live" className="p-2 text-[#d99a54]"><RefreshCw size={13} /></button></div>
      {feeError && <p className="mt-2 font-mono text-[10px] text-[#e0b45f]">Live fee estimate unavailable: {feeError}. Sending remains disabled until a valid fee rate is retrieved.</p>}
      {sats && feeEstimate && <div className="mt-3 border border-[#d99a54]/40 bg-[#151a1f] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]" aria-label="Pre-authorization preview"><p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><ShieldCheck size={13} /> UniSat pre-approval preview</p><p className="mt-1 break-all">To: {recipient.trim() || "Adresse à saisir"}</p><p>Exact amount: {sats.toLocaleString("en-US")} sats ({amount} {assetLabel})</p><p>Network: {networkLabel} mainnet · fees: {Math.ceil(feeEstimate.feeRate)} sat/vB ({describeFeeSources(feeEstimate.strategy, feeEstimate.sources)})</p><p>Total fees are calculated and displayed by UniSat before signing.</p></div>}
      <label className="mt-3 flex cursor-pointer items-start gap-2 font-mono text-[10px] leading-5 text-[#d9d3c6]"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-[#d99a54]" /><span>I verify the address and amount above. I understand that a confirmed on-chain transfer cannot be reversed.</span></label>
      {confirmed && sats && feeEstimate && recipient.trim() && <UniSatOwnershipProof key={`${ownershipContextKey}:${ownershipProofVersion}`} site={site} address={address} network={chain?.enum ?? ""} provider={provider} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />}
      {mobileReady && <p className="mt-2 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#70c7a0]" role="status">Pre-check complete after the wallet ownership check. Tap again to open UniSat transaction approval.</p>}
      {outcomeUnclear && <div className="mt-3 border border-[#a45e54]/70 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e08b7d]" role="alert"><p className="uppercase tracking-[0.1em]">Previous send outcome unknown</p><p>Do not resend the funds. Check UniSat activity and selected network Mempool for a possible transaction.</p><label className="mt-2 flex cursor-pointer items-start gap-2 text-[#d9d3c6]"><input type="checkbox" checked={outcomeChecked} onChange={event => setOutcomeChecked(event.target.checked)} className="mt-1 accent-[#d99a54]" /><span>I checked UniSat and Mempool; no previous send is pending or confirmed.</span></label><button type="button" disabled={!outcomeChecked} onClick={() => { try { sessionStorage.removeItem(`${storageKey(address)}:unclear`); } catch { /* clear the in-memory lock after explicit verification */ } setOutcomeUnclear(false); setOutcomeChecked(false); }} className="mt-2 border border-[#a45e54] px-3 py-2 uppercase tracking-[0.08em] text-[#f3efe5] disabled:opacity-40">Unlock after verification</button></div>}
      <button type="button" onClick={() => void send()} disabled={sending || walletBusy || outcomeUnclear || !confirmed || !sats || !recipient.trim() || !feeEstimate || Boolean(feeError) || ownershipProofKey !== ownershipContextKey} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40">{sending ? <><Loader2 size={14} className="animate-spin" /> Pre-checking…</> : <><Send size={14} /> {mobileReady ? "Open UniSat · approve transaction" : isMobileUniSatDevice() ? "Pre-check before UniSat" : "Continue in UniSat"}</>}</button>
      {error && <p className="mt-3 border border-[#a45e54]/60 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e08b7d]" role="alert">{error}</p>}
    </>}
    {receipt && <div className="mt-4 border border-[#d99a54]/70 bg-[#0b0d10] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]" aria-live="polite"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">{assetLabel} send receipt · {receipt.mempool.status}</p><p>Status: {receipt.mempool.message}</p><p>Network: {receipt.network}</p><p className="break-all">From: {receipt.sender}</p><p className="break-all">To: {receipt.recipient}</p><p>Amount: {receipt.amountSats.toLocaleString("en-US")} sats ({(receipt.amountSats / 100_000_000).toLocaleString("en-US", { maximumFractionDigits: 8 })} {assetLabel})</p><p>Estimated fees: {receipt.feeRate} sat/vB · {receipt.feeSource}</p><p className="break-all">TXID: {receipt.txid}</p>{receipt.mempool.blockHeight !== null && <p>Block: {receipt.mempool.blockHeight}</p>}<p>Last checked: {new Date(receipt.mempool.checkedAt).toLocaleString("en-US")}</p><div className="mt-2 flex flex-wrap gap-3"><a href={receipt.mempool.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#d99a54] underline">View in Mempool <ExternalLink size={12} /></a>{receipt.mempool.status !== "confirmed" && <button type="button" onClick={() => startTracking(receipt)} className="text-[#f2bd63] underline">Resume tracking</button>}</div></div>}
  </section>;
}
