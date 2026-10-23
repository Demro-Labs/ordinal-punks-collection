import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { LocalVaultOwnershipProof } from "@/components/LocalVaultOwnershipProof";
import { PreSignatureSecurityPreview } from "@/components/PreSignatureSecurityPreview";
import { LocalVaultBrc20TransferPanel } from "@/components/LocalVaultBrc20TransferPanel";
import { LocalVaultTransactionHub } from "@/components/LocalVaultTransactionHub";
import { LocalVaultRuneTransferPanel } from "@/components/LocalVaultRuneTransferPanel";
import { UniSatRunesSendPanel } from "@/components/UniSatRunesSendPanel";
import { fetchAddressOrdinals, type AddressOrdinal, type OrdinalNetwork } from "@/lib/ordinals";
import { broadcastLocalOrdinalTransfer, prepareLocalOrdinalTransfer, signLocalOrdinalTransfer, type LocalOrdinalPlan } from "@/lib/local-ordinal-transfer";
import type { AddressType, OrdiWalletRecord } from "@/lib/ordi-wallet";
type SiteName = "punks" | "pokedex";
function formatSats(value: number) { return `${value.toLocaleString("en-US")} sats`; }

export function LocalVaultAssetPanel({
  address,
  network,
  site,
  wallet,
  addressType,
}: {
  address: string;
  network: OrdinalNetwork;
  site: SiteName;
  wallet: OrdiWalletRecord;
  addressType: AddressType;
}) {
  const [items, setItems] = useState<AddressOrdinal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [recipient, setRecipient] = useState("");
  const [localPlan, setLocalPlan] = useState<LocalOrdinalPlan | null>(null);
  const [signed, setSigned] = useState<{ signedPsbtHex: string; rawTxHex: string; txid: string } | null>(null);
  const [confirmedReview, setConfirmedReview] = useState(false);
  const [confirmedBroadcast, setConfirmedBroadcast] = useState(false);
  const [broadcastAttempted, setBroadcastAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [message, setMessage] = useState("");
  const [brc20InscriptionId, setBrc20InscriptionId] = useState("");
  const [brc20CompletedId, setBrc20CompletedId] = useState("");
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const load = async (): Promise<AddressOrdinal[] | null> => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchAddressOrdinals(address, network);
      setItems(result.detail);
      if (selected && !result.detail.some(item => item.inscriptionId === selected)) setSelected("");
      return result.detail;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Live Ordinals data is unavailable.");
      return null;
    } finally { setLoading(false); }
  };
  useEffect(() => {
    setItems([]); setSelected(""); setRecipient(""); setLocalPlan(null); setSigned(null);
    void load();
    const timer = window.setInterval(() => void load(), 300_000);
    return () => window.clearInterval(timer);
  }, [address, network]);
  const selectedItem = useMemo(() => items.find(item => item.inscriptionId === selected) ?? null, [items, selected]);
  const ownershipContextKey = selectedItem && recipient.trim()
    ? JSON.stringify(["ordinal-transfer", site, network, address, addressType, selectedItem.inscriptionId, recipient.trim()])
    : "";
  function chooseInscription(item: AddressOrdinal) {
    setSelected(item.inscriptionId); setLocalPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); setTransferError(""); setMessage("");
  }
  async function reviewTransfer() {
    if (!selectedItem) return;
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) { setTransferError("Complete the local BIP-322 ownership proof for this inscription, recipient, and network before preparing the transfer."); return; }
    setBusy(true); setTransferError(""); setMessage(""); setLocalPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false);
    try {
      setLocalPlan(await prepareLocalOrdinalTransfer({ network, wallet, addressType, inscriptionId: selectedItem.inscriptionId, recipient }));
      setMessage("Plan vérifié. Aucune signature ni transaction n’a encore été créée.");
    } catch (cause) { setTransferError(cause instanceof Error ? cause.message : "Impossible de préparer le transfert local."); }
    finally { setBusy(false); }
  }
  async function signTransfer() {
    if (!localPlan || !confirmedReview) return;
    if (!ownershipContextKey || ownershipProofKey !== ownershipContextKey) {
      setTransferError("La preuve BIP-322 a expiré ou ne correspond plus à cette inscription. Refaites la preuve puis la revue avant de signer.");
      return;
    }
    setBusy(true); setTransferError(""); setMessage("");
    try { setSigned(await signLocalOrdinalTransfer(localPlan, wallet)); setMessage("Signature créée localement et vérifiée. Rien n’a encore été diffusé."); }
    catch (cause) { setTransferError(cause instanceof Error ? cause.message : "La signature locale a échoué."); }
    finally { setBusy(false); }
  }
  async function broadcastTransfer() {
    if (!localPlan || !signed || !confirmedBroadcast || broadcastAttempted) return;
    setBroadcastAttempted(true); setBusy(true); setTransferError(""); setMessage("");
    try {
      const txid = await broadcastLocalOrdinalTransfer(localPlan, wallet, signed);
      setMessage(`Ordinal diffusé sur ${network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"} : ${txid}`);
      if (selectedItem && selectedItem.inscriptionId === brc20InscriptionId) setBrc20CompletedId(brc20InscriptionId);
      void load();
    } catch (cause) { setTransferError(cause instanceof Error ? cause.message : "Résultat de diffusion incertain. Vérifiez le TXID dans Mempool avant toute autre action."); }
    finally { setBusy(false); }
  }
  return <section id="local-vault-assets" className="mt-4 border border-[#70c7a0]/35 bg-[#101a16] p-3 sm:p-4 scroll-mt-6" aria-labelledby="local-vault-assets-title">
    <LocalVaultTransactionHub network={network} />
      <div className="mt-4 grid gap-3 md:grid-cols-2" aria-label="Parcours de transfert Local Vault">
        <article className="border border-[#70c7a0]/40 bg-[#0b0f13] p-3">
          <p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#9fe0bd]">Parcours A · Actif existant</p>
          <h3 className="mt-1 font-display text-base text-[#f3efe5]">Sélectionner puis envoyer</h3>
          <p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">Pour BTC/FB, Ordinals, une inscription BRC-20 TRANSFER déjà créée et Runes : sélectionner l’actif, prouver la propriété si nécessaire, contrôler les entrées/sorties et frais, signer localement, puis confirmer séparément la diffusion.</p>
        </article>
        <article className="border border-[#d99a54]/40 bg-[#0b0f13] p-3">
          <p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#f2bd63]">Parcours B · Préparer puis envoyer</p>
          <h3 className="mt-1 font-display text-base text-[#f3efe5]">Deux étapes si le protocole l’exige</h3>
          <p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">Pour BRC-20 classique : préparer et payer la création de l’inscription TRANSFER, vérifier qu’elle est indexée, puis effectuer une seconde revue, signature locale et diffusion vers le destinataire. Pour BTC/FB et Runes, la préparation construit la transaction propre au protocole, sans inventer d’inscription TRANSFER.</p>
        </article>
      </div>
    <LocalVaultBrc20TransferPanel wallet={wallet} network={network} addressType={addressType} site={site} completedInscriptionId={brc20CompletedId} onCreated={(inscriptionId, target) => {
      void (async () => {
        // The order API can reveal the inscription before the address indexer lists it.
        // Retry indexing briefly so the next step can select and review the actual inscription.
        let indexed = false;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const currentItems = await load();
          if (currentItems?.some(item => item.inscriptionId === inscriptionId)) {
            indexed = true;
            break;
          }
          if (attempt < 3) await new Promise(resolve => window.setTimeout(resolve, 2000));
        }
        setSelected(inscriptionId);
        setBrc20InscriptionId(inscriptionId);
        setBrc20CompletedId("");
        setRecipient(target);
        setLocalPlan(null);
        setSigned(null);
        setConfirmedReview(false);
        setConfirmedBroadcast(false);
        setBroadcastAttempted(false);
        setTransferError("");
        setOwnershipProofKey(null);
        setMessage(indexed
          ? "Étape 1/2 terminée : l’inscription BRC-20 du montant demandé est indexée. Étape 2/2 : vérifiez puis signez séparément son envoi au destinataire."
          : "Inscription créée, mais l’indexeur d’adresse ne la montre pas encore. Le transfert n’est pas préparé. Actualisez les actifs locaux et réessayez quand l’inscription apparaît.");
      })();
    }} />
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-[#9fe0bd]">Local Vault asset bridge</p><h2 id="local-vault-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">Live Ordinals &amp; Runes</h2><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">{network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin"} · address-scoped · refresh every 60s</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void load()} disabled={loading || busy} className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#9fe0bd] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh local assets</button><a href={network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io"} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6]">Open UniSat <ExternalLink size={12} /></a></div>
    </div>
    {error && <div className="mt-3 break-words border border-[#a45e54]/50 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert"><p>{error}</p><p className="mt-2 text-[#d9d3c6]">Index live indisponible. La signature locale est bloquée jusqu’au rétablissement des données complètes.</p></div>}
    <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr]">
      <article className="min-w-0 border border-[#2c323a] bg-[#0b0f13] p-3"><div className="flex items-center justify-between"><h3 className="font-mono text-[10px] uppercase text-[#f2bd63]">Ordinals / inscriptions</h3><span className="font-mono text-[9px] text-[#718092]">{items.length}</span></div>{!loading && !error && items.length === 0 && <p className="mt-2 font-mono text-[10px] text-[#718092]">No indexed inscriptions for this vault address.</p>}{items.length > 0 && <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">{items.map(item => <div key={item.inscriptionId} className={`border p-2 ${selected === item.inscriptionId ? "border-[#f2bd63]" : "border-[#2c323a]"}`}><p className="break-all font-mono text-[9px] text-[#d9d3c6]">{item.inscriptionNumber != null ? `#${item.inscriptionNumber} · ` : ""}{item.inscriptionId}</p><p className="mt-1 break-all font-mono text-[9px] text-[#718092]">{item.location ?? "Location unavailable"}</p><button type="button" onClick={() => chooseInscription(item)} disabled={!item.location || busy} className="mt-2 inline-flex min-h-9 items-center gap-1 border border-[#d99a54] px-2 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40"><Send size={11} /> Select for local transfer</button></div>)}</div>}</article>
      <div className="space-y-3"><LocalVaultRuneTransferPanel wallet={wallet} network={network} addressType={addressType} site={site} onDone={() => void load()} /><details className="border border-[#3b434d] bg-[#10151a] p-3"><summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-[#f2bd63]">Restore UniSat wallet transfer tools</summary><p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Optional existing UniSat provider path for users who prefer UniSat signing. Confirm the UniSat-connected account and network match this address before approving any transaction. Local Vault signing remains separate.</p><UniSatRunesSendPanel site={site} address={address} chain={{ enum: network }} onWalletRefresh={() => void load()} /></details></div>
    </div>
    {selectedItem && <div className="mt-3 border border-[#d99a54]/40 bg-[#10151a] p-3 sm:p-4" aria-labelledby="local-ordinal-transfer-title">
      <div className="flex items-center gap-2 text-[#f2bd63]"><ShieldCheck size={15} /><h3 id="local-ordinal-transfer-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Parcours A · Ordinal / BRC-20 TRANSFER · Local Vault</h3></div>
      <p className="mt-2 break-all font-mono text-[9px] text-[#9ea7b3]">{selectedItem.inscriptionId} · {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet"}</p>
      <LocalVaultOwnershipProof key={ownershipContextKey || "ordinal-proof-empty"} site={site} network={network} wallet={wallet} addressType={addressType} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><input aria-label="Ordinal recipient address" value={recipient} onChange={event => { setRecipient(event.target.value); setLocalPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); }} placeholder="Recipient address" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" /><button type="button" onClick={() => void reviewTransfer()} disabled={busy || !recipient.trim() || !ownershipContextKey || ownershipProofKey !== ownershipContextKey} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">Review local transfer</button></div>
      {localPlan && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]"><p className="uppercase text-[#9fe0bd]">Transaction review — no signature yet</p>
      <PreSignatureSecurityPreview network={network === "BITCOIN_MAINNET" ? "Bitcoin mainnet · BTC" : "Fractal Bitcoin mainnet · FB"} transactionType="Ordinal transfer · Local Vault" source={localPlan.address} destination={localPlan.recipient} amount="Transfert de l’inscription sélectionnée" inputs={localPlan.plan.inputs.map((input, index) => `${index === 0 ? "Ordinal" : "Fee"}: ${input.txid}:${input.vout} · ${formatSats(input.valueSats)} · ${input.spendType}`)} outputs={localPlan.plan.outputs.map((output, index) => `${index === 0 ? "Recipient" : "Vault change"}: ${formatSats(output.valueSats)} → ${index === 0 ? localPlan.recipient : localPlan.address}`)} fees={`${formatSats(localPlan.plan.feeSats)} · ${localPlan.plan.feeRateSatVb.toFixed(2)} sat/vB`} warnings={["Vérifiez que l’inscription reste sur la sortie destinée au destinataire.", "Si les données d’indexation sont indisponibles ou incomplètes, ne signez pas."]} /><p className="mt-2 break-all">Inscription sat → {localPlan.recipient}</p><p className="mt-2 uppercase text-[#f2bd63]">Exact inputs ({localPlan.plan.inputs.length})</p><ul className="mt-1 space-y-1">{localPlan.plan.inputs.map((input, index) => <li key={`${input.txid}:${input.vout}`} className="break-all">{index === 0 ? "Ordinal" : "Fee"}: {input.txid}:{input.vout} · {formatSats(input.valueSats)} · {input.spendType}</li>)}</ul><p className="mt-2 uppercase text-[#f2bd63]">Exact outputs</p><p className="break-all">Recipient: {formatSats(localPlan.plan.outputs[0].valueSats)} → {localPlan.recipient}</p>{localPlan.plan.outputs[1] && <p className="break-all">Vault change: {formatSats(localPlan.plan.outputs[1].valueSats)} → {localPlan.address}</p>}<p className="mt-2">Total inputs: {formatSats(localPlan.plan.totalInputSats)} · exact fee: {formatSats(localPlan.plan.feeSats)} · approx. {localPlan.plan.feeRateSatVb.toFixed(2)} sat/vB</p><label className="mt-3 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmedReview} onChange={event => setConfirmedReview(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span>Je confirme le réseau, l’inscription, chaque entrée/sortie, le destinataire et les frais. Autoriser la signature locale du PSBT.</span></label><button type="button" onClick={() => void signTransfer()} disabled={!confirmedReview || busy || Boolean(signed) || !ownershipContextKey || ownershipProofKey !== ownershipContextKey} className="inline-flex min-h-11 items-center justify-center bg-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Signing locally…" : "Sign Ordinal locally"}</button></div>}
      {signed && localPlan && <div className="mt-3 border border-[#d99a54]/50 p-3 font-mono text-[10px] leading-5"><p className="break-all text-[#f2bd63]">TXID: {signed.txid}</p><p className="mt-1 text-[#9ea7b3]">Signature locale vérifiée. Confirmez explicitement la diffusion sur le réseau indiqué.</p><label className="mt-2 flex min-h-11 items-start gap-2 py-2 text-[#d9d3c6]"><input type="checkbox" checked={confirmedBroadcast} onChange={event => setConfirmedBroadcast(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span>Je confirme la diffusion irréversible de ce TXID sur {network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}.</span></label><button type="button" onClick={() => void broadcastTransfer()} disabled={!confirmedBroadcast || busy || broadcastAttempted} className="mt-2 inline-flex min-h-11 items-center justify-center bg-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Broadcasting…" : broadcastAttempted ? "Broadcast attempted — verify TXID" : "Broadcast via Mempool"}</button></div>}
      {transferError && <p className="mt-3 break-words border border-[#a45e54]/50 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{transferError}</p>}
      {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
    </div>}
  </section>;
}
