import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { describeFeeSources, getRecommendedFeeEstimate, trackMempoolTransaction, validateMempoolAddress, type FeeEstimate, type MempoolReceipt } from "@/lib/mempool";
import { normalizeUniSatTxid, parseFbAmountToSats } from "@/lib/native-fb-send";

const NETWORK = "FRACTAL_BITCOIN_MAINNET";
// Keep the legacy key so receipts saved by the mobile panel remain readable.
const STORAGE_PREFIX = "fractal-mobile-fb-send:v1:";
type Chain = { enum?: string; name?: string };
type Provider = {
  sendBitcoin?: (address: string, satoshis: number, options?: { feeRate?: number }) => Promise<unknown>;
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<Chain>;
  switchChain?: (chain: "FRACTAL_BITCOIN_MAINNET") => Promise<Chain>;
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

export function UniSatFbSendPanel({ provider, address, chain, onWalletRefresh, onSwitchToFractal, walletBusy }: { provider?: Provider; address: string; chain: Chain | null; onWalletRefresh: () => void; onSwitchToFractal: () => void; walletBusy: boolean }) {
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
  const runningTxidRef = useRef("");
  const sats = parseFbAmountToSats(amount);
  const connected = Boolean(address && chain?.enum === NETWORK);

  const refreshFees = async () => {
    try { const estimate = await getRecommendedFeeEstimate(NETWORK); setFeeEstimate(estimate); setFeeError(""); }
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
    void trackMempoolTransaction(activeReceipt.txid, NETWORK, update => {
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

  const send = async () => {
    setError("");
    if (outcomeUnclear) { setError("Un envoi précédent a une issue incertaine. Vérifie UniSat et Mempool avant toute nouvelle demande."); return; }
    let walletPromptOpened = false;
    if (!connected || !provider?.sendBitcoin || !provider.getChain) { setError("Connecte UniSat sur Fractal Bitcoin mainnet avant de transférer des FB."); return; }
    if (!sats) { setError("Entre un montant FB supérieur à zéro avec au maximum 8 décimales."); return; }
    const to = recipient.trim();
    if (!to || to.length > 100) { setError("Entre une adresse de réception Fractal valide."); return; }
    if (!confirmed) { setError("Vérifie le réseau, l’adresse et le montant, puis coche la confirmation."); return; }
    setSending(true);
    try {
      const [accounts, currentChain] = await Promise.all([provider.getAccounts?.(), provider.getChain()]);
      if (currentChain.enum !== NETWORK || (accounts && !accounts.includes(address))) throw new Error("Le compte ou réseau UniSat a changé. Aucun envoi n’a été demandé; actualise le wallet et recommence.");
      await validateMempoolAddress(NETWORK, to);
      const estimate = await getRecommendedFeeEstimate(NETWORK);
      if (!Number.isFinite(estimate.feeRate) || estimate.feeRate < 1 || estimate.feeRate > 10_000) throw new Error("Le taux de frais live est invalide; aucun envoi n’a été demandé.");
      setFeeEstimate(estimate);
      setFeeError("");
      const feeRate = Math.ceil(estimate.feeRate);
      walletPromptOpened = true;
      const result = await provider.sendBitcoin(to, sats, { feeRate });
      const txid = normalizeUniSatTxid(result);
      if (!txid) {
        setOutcomeUnclear(true);
        try { sessionStorage.setItem(`${storageKey(address)}:unclear`, "1"); } catch { /* in-memory safety lock remains */ }
        throw new Error("UniSat n’a pas renvoyé de TXID valide; l’issue est incertaine. Vérifie l’activité UniSat et Mempool avant toute nouvelle tentative.");
      }
      const config = { api: "https://mempool.fractalbitcoin.io", explorer: "https://mempool.fractalbitcoin.io/tx/", label: "Fractal Bitcoin" };
      const initialMempool: MempoolReceipt = { txid, network: config.label, status: "checking", message: "Recherche de la transaction dans Mempool…", blockHeight: null, explorerUrl: `${config.explorer}${encodeURIComponent(txid)}`, checkedAt: new Date().toISOString() };
      const next: NativeFbReceipt = { txid, network: config.label, sender: address, recipient: to, amountSats: sats, feeRate, feeSource: describeFeeSources(estimate.strategy, estimate.sources), createdAt: new Date().toISOString(), mempool: initialMempool };
      updateReceipt(next);
      setConfirmed(false);
      setRecipient("");
      setAmount("");
      onWalletRefresh();
      startTracking(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
      const cancelled = code === 4001 || /user (rejected|denied)|cancelled by user|request rejected/i.test(message);
      if (walletPromptOpened && !cancelled) {
        setOutcomeUnclear(true);
        try { sessionStorage.setItem(`${storageKey(address)}:unclear`, "1"); } catch { /* in-memory safety lock remains */ }
      }
      setError(message || "L’envoi UniSat a échoué ou a été refusé.");
    } finally { setSending(false); }
  };

  return <section className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:p-4" aria-labelledby="fb-send-title">
    <div className="flex items-start gap-2"><Send size={15} className="mt-0.5 shrink-0 text-[#f2bd63]" /><div><p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#d99a54]">Dashboard UniSat · Fractal Bitcoin</p><h3 id="fb-send-title" className="mt-1 font-display text-lg text-[#f3efe5]">Envoyer des FB</h3><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">Disponible sur desktop et mobile. UniSat affiche la transaction finale et exige ton approbation. Un FB vaut 100 000 000 sats.</p></div></div>
    {!connected ? <div className="mt-3 border border-[#3b434d] p-3 font-mono text-[10px] text-[#e0b45f]" role="status"><p>Le transfert de FB nécessite le réseau Fractal Bitcoin mainnet. {provider?.switchChain ? "Tu peux demander le changement de réseau ci-dessous." : "Sélectionne ce réseau dans UniSat, puis réessaie."}</p>{provider?.switchChain && <button type="button" onClick={() => void onSwitchToFractal()} disabled={walletBusy || sending} className="mt-2 min-h-10 border border-[#d99a54] px-3 py-2 uppercase tracking-[0.08em] text-[#f2bd63] disabled:opacity-40">Basculer UniSat vers Fractal Bitcoin</button>}</div> : <>
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">Adresse destinataire<input value={recipient} onChange={event => { setRecipient(event.target.value); setConfirmed(false); }} autoComplete="off" spellCheck={false} inputMode="text" maxLength={100} className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 py-2 font-mono text-xs normal-case text-[#f3efe5] outline-none focus:border-[#d99a54]" placeholder="Adresse Fractal Bitcoin" /></label><label className="font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ea7b3]">Montant à envoyer (FB)<input value={amount} onChange={event => { setAmount(event.target.value); setConfirmed(false); }} autoComplete="off" inputMode="decimal" type="text" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 py-2 font-mono text-xs normal-case text-[#f3efe5] outline-none focus:border-[#d99a54]" placeholder="0.00000000" /></label></div>
      <div className="mt-3 flex items-center justify-between gap-3 border border-[#3b434d] bg-[#0b0d10] px-3 py-2 font-mono text-[10px]"><span className="text-[#9ea7b3]">Frais réseau · cible ~30 min</span><strong className="text-[#f2bd63]">{feeEstimate ? `${Math.ceil(feeEstimate.feeRate)} sat/vB` : "Indisponibles"}</strong><button type="button" onClick={() => void refreshFees()} aria-label="Actualiser les frais live" className="p-2 text-[#d99a54]"><RefreshCw size={13} /></button></div>
      {feeError && <p className="mt-2 font-mono text-[10px] text-[#e0b45f]">Estimation live indisponible : {feeError}. L’envoi restera désactivé tant qu’un taux frais valide n’est pas récupéré.</p>}
      {sats && feeEstimate && <div className="mt-3 border border-[#d99a54]/40 bg-[#151a1f] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]" aria-label="Aperçu avant autorisation"><p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><ShieldCheck size={13} /> Aperçu avant UniSat</p><p className="mt-1 break-all">À : {recipient.trim() || "Adresse à saisir"}</p><p>Montant exact : {sats.toLocaleString("fr-FR")} sats ({amount} FB)</p><p>Réseau : Fractal Bitcoin mainnet · frais : {Math.ceil(feeEstimate.feeRate)} sat/vB ({describeFeeSources(feeEstimate.strategy, feeEstimate.sources)})</p><p>Les frais totaux sont calculés et affichés par UniSat avant signature.</p></div>}
      <label className="mt-3 flex cursor-pointer items-start gap-2 font-mono text-[10px] leading-5 text-[#d9d3c6]"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-[#d99a54]" /><span>Je vérifie l’adresse et le montant ci-dessus. Je comprends qu’un transfert confirmé on-chain ne peut pas être annulé.</span></label>
      {outcomeUnclear && <div className="mt-3 border border-[#a45e54]/70 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e08b7d]" role="alert"><p className="uppercase tracking-[0.1em]">Issue du précédent envoi inconnue</p><p>Ne renvoie pas les fonds. Vérifie l’activité UniSat et Fractal Mempool pour une transaction éventuelle.</p><label className="mt-2 flex cursor-pointer items-start gap-2 text-[#d9d3c6]"><input type="checkbox" checked={outcomeChecked} onChange={event => setOutcomeChecked(event.target.checked)} className="mt-1 accent-[#d99a54]" /><span>J’ai vérifié UniSat et Mempool; aucun envoi précédent n’est en attente ou confirmé.</span></label><button type="button" disabled={!outcomeChecked} onClick={() => { try { sessionStorage.removeItem(`${storageKey(address)}:unclear`); } catch { /* clear the in-memory lock after explicit verification */ } setOutcomeUnclear(false); setOutcomeChecked(false); }} className="mt-2 border border-[#a45e54] px-3 py-2 uppercase tracking-[0.08em] text-[#f3efe5] disabled:opacity-40">Déverrouiller après vérification</button></div>}
      <button type="button" onClick={() => void send()} disabled={sending || walletBusy || outcomeUnclear || !confirmed || !sats || !recipient.trim() || !feeEstimate || Boolean(feeError)} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40">{sending ? <><Loader2 size={14} className="animate-spin" /> Vérification avant UniSat…</> : <><Send size={14} /> Continuer dans UniSat</>}</button>
      {error && <p className="mt-3 border border-[#a45e54]/60 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e08b7d]" role="alert">{error}</p>}
    </>}
    {receipt && <div className="mt-4 border border-[#d99a54]/70 bg-[#0b0d10] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]" aria-live="polite"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">Reçu d’envoi FB · {receipt.mempool.status}</p><p>Statut : {receipt.mempool.message}</p><p>Réseau : {receipt.network}</p><p className="break-all">Depuis : {receipt.sender}</p><p className="break-all">Vers : {receipt.recipient}</p><p>Montant : {receipt.amountSats.toLocaleString("fr-FR")} sats ({(receipt.amountSats / 100_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 8 })} FB)</p><p>Frais estimés : {receipt.feeRate} sat/vB · {receipt.feeSource}</p><p className="break-all">TXID : {receipt.txid}</p>{receipt.mempool.blockHeight !== null && <p>Bloc : {receipt.mempool.blockHeight}</p>}<p>Dernière vérification : {new Date(receipt.mempool.checkedAt).toLocaleString("fr-FR")}</p><div className="mt-2 flex flex-wrap gap-3"><a href={receipt.mempool.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#d99a54] underline">Voir dans Mempool <ExternalLink size={12} /></a>{receipt.mempool.status !== "confirmed" && <button type="button" onClick={() => startTracking(receipt)} className="text-[#f2bd63] underline">Reprendre le suivi</button>}</div></div>}
  </section>;
}
