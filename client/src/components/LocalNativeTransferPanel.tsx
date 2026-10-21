import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Send, ShieldCheck } from "lucide-react";
import { LocalVaultOwnershipProof } from "@/components/LocalVaultOwnershipProof";
import { PreSignatureSecurityPreview } from "@/components/PreSignatureSecurityPreview";
import { LocalVaultSafeBalanceDiscovery } from "@/components/LocalVaultSafeBalanceDiscovery";
import { broadcastLocalPsbt, finalizeLocalPsbt, signLocalPsbt, reviewLocalPsbt, type LocalPsbtReview } from "@/lib/local-psbt-signer";
import { prepareLocalNativeTransfer, type LocalNativeTransferPlan } from "@/lib/local-native-transfer";
import { describeFeeSources, getRecommendedFeeEstimate, getMempoolConfig, trackMempoolTransaction, type FeeEstimate, type MempoolReceipt } from "@/lib/mempool";
import { ADDRESS_SPECS, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";

function assetLabel(network: OrdiNetwork) { return network === "BITCOIN_MAINNET" ? "BTC" : "FB"; }
function formatAsset(sats: number, asset: string) { return `${(sats / 100_000_000).toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 })} ${asset}`; }

export function LocalNativeTransferPanel({ wallet, network, addressType, onAddressTypeChange, site = "pokedex", onDone }: { wallet: OrdiWalletRecord; network: OrdiNetwork; addressType: AddressType; onAddressTypeChange: (addressType: AddressType) => void; site?: "punks" | "pokedex"; onDone?: () => void }) {
  const asset = assetLabel(network);
  const account = wallet.addresses[addressType];
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [plan, setPlan] = useState<LocalNativeTransferPlan | null>(null);
  const [review, setReview] = useState<LocalPsbtReview | null>(null);
  const [signed, setSigned] = useState("");
  const [tx, setTx] = useState<{ rawTxHex: string; txid: string } | null>(null);
  const [receipt, setReceipt] = useState<MempoolReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedBroadcast, setConfirmedBroadcast] = useState(false);
  const [broadcastAttempted, setBroadcastAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const ownershipContextKey = recipient.trim() && amount.trim()
    ? JSON.stringify(["native-transfer", network, account.address, addressType, recipient.trim(), amount.trim()])
    : "";

  useEffect(() => {
    setPlan(null); setReview(null); setSigned(""); setTx(null); setReceipt(null); setConfirmed(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); setError(""); setMessage("");
    void getRecommendedFeeEstimate(network).then(setFeeEstimate).catch(() => setFeeEstimate(null));
  }, [network, addressType]);

  const reset = () => { setPlan(null); setReview(null); setSigned(""); setTx(null); setReceipt(null); setConfirmed(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); setError(""); setMessage(""); };

  const prepare = async () => {
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) { setError("Complete the local BIP-322 ownership proof for this source account, recipient, amount, and network before preparing the transfer."); return; }
    setBusy(true); setError(""); setMessage(""); reset();
    try {
      const next = await prepareLocalNativeTransfer(network, wallet, addressType, recipient, amount);
      const nextReview = await reviewLocalPsbt(next.psbtHex, wallet, network);
      if (nextReview.addressType !== addressType || nextReview.sourceAddress !== account.address) throw new Error("Le PSBT généré ne correspond pas au compte source choisi.");
      setPlan(next); setReview(nextReview); setMessage("Transaction préparée et vérifiée contre les UTXO confirmés sans actifs. Aucun transfert n’a encore été signé.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de préparer le transfert."); }
    finally { setBusy(false); }
  };

  const sign = async () => {
    if (!plan || !review || !confirmed) return;
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) {
      setError("La preuve BIP-322 a expiré ou ne correspond plus à cette transaction. Refaites la preuve puis préparez à nouveau la revue.");
      return;
    }
    setBusy(true); setError("");
    try { setSigned(await signLocalPsbt(plan.psbtHex, wallet, review)); setMessage("Signature créée localement. La transaction n’est pas encore diffusée."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "La signature locale a échoué."); }
    finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!plan || !review || !signed) return;
    setBusy(true); setError("");
    setConfirmedBroadcast(false);
    try { setTx(await finalizeLocalPsbt(signed, wallet, review)); setMessage("Signature vérifiée localement. Vérifiez le TXID avant toute diffusion."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "La signature finale est invalide."); }
    finally { setBusy(false); }
  };

  const broadcast = async () => {
    if (!plan || !review || !tx || !confirmedBroadcast || broadcastAttempted) return;
    setBroadcastAttempted(true);
    setBusy(true); setError("");
    try {
      await broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review);
      const config = getMempoolConfig(network);
      if (!config) throw new Error("Aucun explorateur n’est configuré pour ce réseau.");
      const initial: MempoolReceipt = { txid: tx.txid, network: config.label, status: "checking", message: "Recherche de la transaction dans Mempool…", blockHeight: null, explorerUrl: `${config.explorer}${tx.txid}`, checkedAt: new Date().toISOString() };
      setReceipt(initial); setConfirmedBroadcast(false); setMessage(`Transaction ${asset} diffusée. Suivi live en cours.`); onDone?.();
      void trackMempoolTransaction(tx.txid, network, setReceipt).catch(cause => setError(cause instanceof Error ? cause.message : "Le suivi Mempool est indisponible."));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le résultat de diffusion est incertain. Vérifiez Mempool avant de réessayer."); }
    finally { setBusy(false); }
  };

  const prepareNextTransfer = () => {
    if (busy || !receipt || receipt.status !== "confirmed") return;
    setRecipient("");
    setAmount("");
    setPlan(null);
    setReview(null);
    setSigned("");
    setTx(null);
    setConfirmed(false);
    setConfirmedBroadcast(false);
    setBroadcastAttempted(false);
    setOwnershipProofKey(null);
    setError("");
    setMessage("Transfert confirmé. Le formulaire est réinitialisé pour préparer le suivant; le reçu précédent reste visible.");
  };

  return <section className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:mt-5 sm:p-4" aria-labelledby="local-native-transfer-title">
    <div className="flex items-center gap-2 text-[#f2bd63]"><Send size={15} /><h3 id="local-native-transfer-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Send {asset} · Local Vault</h3></div>
    <p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Paiement natif {asset} depuis Legacy, Nested SegWit, Native SegWit ou Taproot : les UTXO confirmés sans Ordinal, Rune ou Alkane sont vérifiés en direct, puis la transaction est signée dans le coffre local. Les clés privées ne quittent jamais cet appareil.</p>
    <LocalVaultOwnershipProof key={ownershipContextKey || "native-proof-empty"} site={site} network={network} wallet={wallet} addressType={addressType} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />
    <label className="mt-3 block font-mono text-[9px] uppercase tracking-[.12em] text-[#9ea7b3]" htmlFor="local-native-source-type">Type d’adresse source</label>
    <select id="local-native-source-type" aria-label="Type d’adresse source" value={addressType} onChange={event => { reset(); onAddressTypeChange(event.target.value as AddressType); }} className="mt-1 min-h-11 min-w-0 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-sm text-[#f3efe5]">
      {ADDRESS_SPECS.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
    </select>
    <p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#718092]">Source : {account.label} · {account.address}</p>
    <LocalVaultSafeBalanceDiscovery wallet={wallet} network={network} selectedAddressType={addressType} onSelectAddressType={nextType => { reset(); onAddressTypeChange(nextType); }} />
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
      <input aria-label={`Adresse ${asset} destinataire`} value={recipient} onChange={event => { setRecipient(event.target.value); reset(); }} placeholder="Adresse destinataire" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" />
      <input aria-label={`Montant ${asset}`} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); reset(); }} placeholder={`Montant ${asset}`} className="min-h-11 border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" />
      <button type="button" onClick={() => void prepare()} disabled={busy || !recipient.trim() || !amount.trim() || !ownershipContextKey || ownershipProofKey !== ownershipContextKey} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">{busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Review {asset}</button>
    </div>
    {feeEstimate && <p className="mt-2 font-mono text-[9px] text-[#718092]">Frais live : {Math.ceil(feeEstimate.feeRate)} sat/vB · {describeFeeSources(feeEstimate.strategy, feeEstimate.sources)}</p>}
    {review && plan && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
      <p className="flex items-center gap-2 uppercase text-[#9fe0bd]"><CheckCircle2 size={13} /> Revue obligatoire</p>
      <PreSignatureSecurityPreview network={network === "BITCOIN_MAINNET" ? "Bitcoin mainnet · BTC" : "Fractal Bitcoin mainnet · FB"} transactionType={`Transfert natif ${asset}`} source={plan.sourceAddress} destination={plan.recipient} amount={formatAsset(plan.amountSats, asset)} inputs={[`${review.inputCount} entrée(s) vérifiée(s)`, `Valeur totale des entrées : ${formatAsset(review.inputSats, asset)}`]} outputs={[`Destinataire : ${formatAsset(plan.amountSats, asset)} → ${plan.recipient}`, ...(plan.changeSats > 0 ? [`Change : ${formatAsset(plan.changeSats, asset)} → ${plan.sourceAddress}`] : [])]} fees={`${formatAsset(review.feeSats, asset)} · ${feeEstimate ? `${Math.ceil(feeEstimate.feeRate)} sat/vB` : "taux indisponible"}`} warnings={["Vérifiez les UTXO exacts et l’absence d’actifs Ordinals/Runes avant signature.", "Si le scan est incomplet ou si une entrée est périmée, ne signez pas."]} />
      <p className="mt-1 text-[#9ea7b3]">Reconstruire crée un nouveau PSBT depuis les UTXO sûrs actuellement confirmés et remplace cette revue. Aucune signature ni diffusion automatique.</p>
      <p className="mt-2 break-all">Depuis : {ADDRESS_SPECS.find(item => item.type === plan.addressType)?.label} · {plan.sourceAddress}</p>
      <p className="break-all">Envoyer : {formatAsset(plan.amountSats, asset)} → {plan.recipient}</p>
      <p>Entrées : {review.inputCount} · Total : {formatAsset(review.inputSats, asset)} · Frais : {formatAsset(review.feeSats, asset)}</p>
      {plan.changeSats > 0 && <p>Change vers le coffre : {formatAsset(plan.changeSats, asset)}</p>}
      <label className="mt-3 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /> <span>Je confirme le réseau {asset === "BTC" ? "Bitcoin" : "Fractal Bitcoin"}, le compte source, l’adresse, le montant et les frais. Créer la signature locale.</span></label>
      <button type="button" onClick={() => void sign()} disabled={!confirmed || busy || !ownershipContextKey || ownershipProofKey !== ownershipContextKey} className="inline-flex min-h-11 items-center justify-center bg-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Signing…" : `Sign ${asset} locally`}</button>
      <button type="button" onClick={() => void prepare()} disabled={busy || !ownershipContextKey || ownershipProofKey !== ownershipContextKey} className="ml-2 inline-flex min-h-11 items-center justify-center border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">{busy ? "Rebuilding…" : "Reconstruire un PSBT neuf"}</button>
    </div>}
    {signed && !tx && <div className="mt-3 border border-[#d99a54]/40 p-3"><p className="font-mono text-[10px] text-[#f2bd63]">Signature en mémoire uniquement; pas encore diffusée.</p><button type="button" onClick={() => void finalize()} disabled={busy} className="mt-2 inline-flex min-h-11 border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63]">Verify signature</button></div>}
    {tx && <div className="mt-3 border border-[#d99a54]/60 p-3 font-mono text-[10px] leading-5"><p className="break-all text-[#f2bd63]">TXID : {tx.txid}</p><p className="mt-1 text-[#9ea7b3]">La diffusion est irréversible. Vérifiez une dernière fois le TXID et le réseau.</p><label className="mt-2 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmedBroadcast} onChange={event => setConfirmedBroadcast(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span>Je confirme ce TXID exact et autorise sa diffusion sur {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet"}.</span></label><button type="button" onClick={() => void broadcast()} disabled={busy || !confirmedBroadcast || broadcastAttempted} className="mt-2 inline-flex min-h-11 bg-[#d99a54] px-4 uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Broadcasting…" : broadcastAttempted ? "Broadcast attempted — verify TXID" : `Broadcast ${asset}`}</button></div>}
    {receipt && <p className="mt-3 break-all border border-[#70c7a0]/40 p-3 font-mono text-[10px] text-[#9fe0bd]" role="status">{receipt.message} · <a className="underline" href={receipt.explorerUrl} target="_blank" rel="noreferrer">Voir dans Mempool</a></p>}
    {receipt?.status === "confirmed" && <button type="button" onClick={prepareNextTransfer} disabled={busy} className="mt-2 inline-flex min-h-11 items-center justify-center border border-[#70c7a0]/50 px-4 font-mono text-[9px] uppercase text-[#9fe0bd] disabled:opacity-40">Préparer un autre transfert</button>}
    {error && <p className="mt-3 break-words border border-[#a45e54]/50 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
    {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
  </section>;
}
