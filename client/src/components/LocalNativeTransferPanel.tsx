import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Send, ShieldCheck } from "lucide-react";
import { LocalVaultOwnershipProof } from "@/components/LocalVaultOwnershipProof";
import { broadcastLocalPsbt, finalizeLocalPsbt, signLocalPsbt, reviewLocalPsbt, type LocalPsbtReview } from "@/lib/local-psbt-signer";
import { prepareLocalNativeTransfer, type LocalNativeTransferPlan } from "@/lib/local-native-transfer";
import { describeFeeSources, getRecommendedFeeEstimate, getMempoolConfig, trackMempoolTransaction, type FeeEstimate, type MempoolReceipt } from "@/lib/mempool";
import { ADDRESS_SPECS, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";

function assetLabel(network: OrdiNetwork) { return network === "BITCOIN_MAINNET" ? "BTC" : "FB"; }
function formatAsset(sats: number, asset: string) { return `${(sats / 100_000_000).toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 })} ${asset}`; }

export function LocalNativeTransferPanel({ wallet, network, site = "pokedex", onDone }: { wallet: OrdiWalletRecord; network: OrdiNetwork; site?: "punks" | "pokedex"; onDone?: () => void }) {
  const asset = assetLabel(network);
  const [addressType, setAddressType] = useState<AddressType>("native-segwit");
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const ownershipContextKey = recipient.trim() && amount.trim()
    ? JSON.stringify(["native-transfer", network, account.address, addressType, recipient.trim(), amount.trim()])
    : "";

  useEffect(() => {
    setPlan(null); setReview(null); setSigned(""); setTx(null); setReceipt(null); setConfirmed(false); setError(""); setMessage("");
    void getRecommendedFeeEstimate(network).then(setFeeEstimate).catch(() => setFeeEstimate(null));
  }, [network]);

  const reset = () => { setPlan(null); setReview(null); setSigned(""); setTx(null); setReceipt(null); setConfirmed(false); setMessage(""); };

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
    if (!plan || !review || !confirmed || ownershipProofKey !== ownershipContextKey) return;
    setBusy(true); setError("");
    try { setSigned(await signLocalPsbt(plan.psbtHex, wallet, review)); setMessage("Signature créée localement. La transaction n’est pas encore diffusée."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "La signature locale a échoué."); }
    finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!plan || !review || !signed) return;
    setBusy(true); setError("");
    try { setTx(await finalizeLocalPsbt(signed, wallet, review)); setMessage("Signature vérifiée localement. Vérifiez le TXID avant toute diffusion."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "La signature finale est invalide."); }
    finally { setBusy(false); }
  };

  const broadcast = async () => {
    if (!plan || !review || !tx) return;
    setBusy(true); setError("");
    try {
      await broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review);
      const config = getMempoolConfig(network);
      if (!config) throw new Error("Aucun explorateur n’est configuré pour ce réseau.");
      const initial: MempoolReceipt = { txid: tx.txid, network: config.label, status: "checking", message: "Recherche de la transaction dans Mempool…", blockHeight: null, explorerUrl: `${config.explorer}${tx.txid}`, checkedAt: new Date().toISOString() };
      setReceipt(initial); setMessage(`Transaction ${asset} diffusée. Suivi live en cours.`); onDone?.();
      void trackMempoolTransaction(tx.txid, network, setReceipt).catch(cause => setError(cause instanceof Error ? cause.message : "Le suivi Mempool est indisponible."));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le résultat de diffusion est incertain. Vérifiez Mempool avant de réessayer."); }
    finally { setBusy(false); }
  };

  return <section className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:mt-5 sm:p-4" aria-labelledby="local-native-transfer-title">
    <div className="flex items-center gap-2 text-[#f2bd63]"><Send size={15} /><h3 id="local-native-transfer-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Send {asset} · Local Vault</h3></div>
    <p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Paiement natif {asset} depuis Legacy, Nested SegWit, Native SegWit ou Taproot : les UTXO confirmés sans Ordinal, Rune ou Alkane sont vérifiés en direct, puis la transaction est signée dans le coffre local. Les clés privées ne quittent jamais cet appareil.</p>
    <LocalVaultOwnershipProof key={ownershipContextKey || "native-proof-empty"} site={site} network={network} wallet={wallet} addressType={addressType} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />
    <label className="mt-3 block font-mono text-[9px] uppercase tracking-[.12em] text-[#9ea7b3]" htmlFor="local-native-source-type">Type d’adresse source</label>
    <select id="local-native-source-type" aria-label="Type d’adresse source" value={addressType} onChange={event => { reset(); setAddressType(event.target.value as AddressType); }} className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-sm text-[#f3efe5]">
      {ADDRESS_SPECS.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
    </select>
    <p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#718092]">Source : {account.label} · {account.address}</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
      <input aria-label={`Adresse ${asset} destinataire`} value={recipient} onChange={event => { setRecipient(event.target.value); reset(); }} placeholder="Adresse destinataire" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" />
      <input aria-label={`Montant ${asset}`} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); reset(); }} placeholder={`Montant ${asset}`} className="min-h-11 border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" />
      <button type="button" onClick={() => void prepare()} disabled={busy || !recipient.trim() || !amount.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">{busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Review {asset}</button>
    </div>
    {feeEstimate && <p className="mt-2 font-mono text-[9px] text-[#718092]">Frais live : {Math.ceil(feeEstimate.feeRate)} sat/vB · {describeFeeSources(feeEstimate.strategy, feeEstimate.sources)}</p>}
    {review && plan && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
      <p className="flex items-center gap-2 uppercase text-[#9fe0bd]"><CheckCircle2 size={13} /> Revue obligatoire</p>
      <p className="mt-2 break-all">Depuis : {ADDRESS_SPECS.find(item => item.type === plan.addressType)?.label} · {plan.sourceAddress}</p>
      <p className="break-all">Envoyer : {formatAsset(plan.amountSats, asset)} → {plan.recipient}</p>
      <p>Entrées : {review.inputCount} · Total : {formatAsset(review.inputSats, asset)} · Frais : {formatAsset(review.feeSats, asset)}</p>
      {plan.changeSats > 0 && <p>Change vers le coffre : {formatAsset(plan.changeSats, asset)}</p>}
      <label className="mt-3 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /> <span>Je confirme le réseau {asset === "BTC" ? "Bitcoin" : "Fractal Bitcoin"}, le compte source, l’adresse, le montant et les frais. Créer la signature locale.</span></label>
      <button type="button" onClick={() => void sign()} disabled={!confirmed || busy} className="inline-flex min-h-11 items-center justify-center bg-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Signing…" : `Sign ${asset} locally`}</button>
    </div>}
    {signed && !tx && <div className="mt-3 border border-[#d99a54]/40 p-3"><p className="font-mono text-[10px] text-[#f2bd63]">Signature en mémoire uniquement; pas encore diffusée.</p><button type="button" onClick={() => void finalize()} disabled={busy} className="mt-2 inline-flex min-h-11 border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63]">Verify signature</button></div>}
    {tx && <div className="mt-3 border border-[#d99a54]/60 p-3 font-mono text-[10px] leading-5"><p className="break-all text-[#f2bd63]">TXID : {tx.txid}</p><p className="mt-1 text-[#9ea7b3]">La diffusion est irréversible. Vérifiez une dernière fois le TXID et le réseau.</p><button type="button" onClick={() => void broadcast()} disabled={busy} className="mt-2 inline-flex min-h-11 bg-[#d99a54] px-4 uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Broadcasting…" : `Broadcast ${asset}`}</button></div>}
    {receipt && <p className="mt-3 break-all border border-[#70c7a0]/40 p-3 font-mono text-[10px] text-[#9fe0bd]" role="status">{receipt.message} · <a className="underline" href={receipt.explorerUrl} target="_blank" rel="noreferrer">Voir dans Mempool</a></p>}
    {error && <p className="mt-3 break-words border border-[#a45e54]/50 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
    {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
  </section>;
}
