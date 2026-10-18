import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Send, ShieldCheck } from "lucide-react";
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
  onTransferRequest,
}: {
  address: string;
  network: OrdinalNetwork;
  site: SiteName;
  wallet: OrdiWalletRecord;
  addressType: AddressType;
  onTransferRequest: () => void;
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
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchAddressOrdinals(address, network);
      setItems(result.detail);
      if (selected && !result.detail.some(item => item.inscriptionId === selected)) setSelected("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Live Ordinals data is unavailable.");
    } finally { setLoading(false); }
  };
  useEffect(() => {
    setItems([]); setSelected(""); setRecipient(""); setLocalPlan(null); setSigned(null);
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [address, network]);
  const selectedItem = useMemo(() => items.find(item => item.inscriptionId === selected) ?? null, [items, selected]);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  function chooseInscription(item: AddressOrdinal) {
    setSelected(item.inscriptionId); setLocalPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); setTransferError(""); setMessage("");
  }
  async function reviewTransfer() {
    if (!selectedItem) return;
    setBusy(true); setTransferError(""); setMessage(""); setLocalPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false);
    try {
      setLocalPlan(await prepareLocalOrdinalTransfer({ network, wallet, addressType, inscriptionId: selectedItem.inscriptionId, recipient }));
      setMessage("Plan vérifié. Aucune signature ni transaction n’a encore été créée.");
    } catch (cause) { setTransferError(cause instanceof Error ? cause.message : "Impossible de préparer le transfert local."); }
    finally { setBusy(false); }
  }
  async function signTransfer() {
    if (!localPlan || !confirmedReview) return;
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
      void load();
    } catch (cause) { setTransferError(cause instanceof Error ? cause.message : "Résultat de diffusion incertain. Vérifiez le TXID dans Mempool avant toute autre action."); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 border border-[#70c7a0]/35 bg-[#101a16] p-3 sm:p-4" aria-labelledby="local-vault-assets-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-[#9fe0bd]">Local Vault asset bridge</p><h2 id="local-vault-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">Live Ordinals &amp; Runes</h2><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">{network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin"} · address-scoped · refresh every 60s</p></div>
      <div className="flex gap-2"><button type="button" onClick={() => void load()} disabled={loading || busy} className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#9fe0bd] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh</button><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6]">UniSat <ExternalLink size={12} /></a></div>
    </div>
    {error && <div className="mt-3 break-words border border-[#a45e54]/50 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert"><p>{error}</p><p className="mt-2 text-[#d9d3c6]">Index live indisponible. La signature locale est bloquée jusqu’au rétablissement des données complètes.</p><button type="button" onClick={onTransferRequest} className="mt-2 min-h-10 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63]">Open UniSat tools</button></div>}
    <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr]">
      <article className="min-w-0 border border-[#2c323a] bg-[#0b0f13] p-3"><div className="flex items-center justify-between"><h3 className="font-mono text-[10px] uppercase text-[#f2bd63]">Ordinals / inscriptions</h3><span className="font-mono text-[9px] text-[#718092]">{items.length}</span></div>{!loading && !error && items.length === 0 && <p className="mt-2 font-mono text-[10px] text-[#718092]">No indexed inscriptions for this vault address.</p>}{items.length > 0 && <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">{items.map(item => <div key={item.inscriptionId} className={`border p-2 ${selected === item.inscriptionId ? "border-[#f2bd63]" : "border-[#2c323a]"}`}><p className="break-all font-mono text-[9px] text-[#d9d3c6]">{item.inscriptionNumber != null ? `#${item.inscriptionNumber} · ` : ""}{item.inscriptionId}</p><p className="mt-1 break-all font-mono text-[9px] text-[#718092]">{item.location ?? "Location unavailable"}</p><button type="button" onClick={() => chooseInscription(item)} disabled={!item.location || busy} className="mt-2 inline-flex min-h-9 items-center gap-1 border border-[#d99a54] px-2 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40"><Send size={11} /> Select for local transfer</button></div>)}</div>}</article>
      <article className="min-w-0 border border-[#2c323a] bg-[#0b0f13] p-3"><h3 className="font-mono text-[10px] uppercase text-[#d7a9ff]">Runes transfer · BTC / FB</h3><p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Soldes Runes en lecture live. Ordi Local Vault ne signe pas encore les transferts Runes : l’envoi passe par UniSat. Le compte et le réseau UniSat actifs doivent correspondre exactement à cette adresse du coffre.</p><button type="button" onClick={onTransferRequest} className="mt-2 min-h-10 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63]">Open UniSat tools</button><UniSatRunesSendPanel site={site} address={address} chain={{ enum: network }} onWalletRefresh={() => void load()} /></article>
    </div>
    {selectedItem && <div className="mt-3 border border-[#d99a54]/40 bg-[#10151a] p-3 sm:p-4" aria-labelledby="local-ordinal-transfer-title">
      <div className="flex items-center gap-2 text-[#f2bd63]"><ShieldCheck size={15} /><h3 id="local-ordinal-transfer-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Ordinal transfer · Local Vault</h3></div>
      <p className="mt-2 break-all font-mono text-[9px] text-[#9ea7b3]">{selectedItem.inscriptionId} · {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet"}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><input aria-label="Ordinal recipient address" value={recipient} onChange={event => { setRecipient(event.target.value); setLocalPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); }} placeholder="Recipient address" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" /><button type="button" onClick={() => void reviewTransfer()} disabled={busy || !recipient.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">Review local transfer</button></div>
      {localPlan && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]"><p className="uppercase text-[#9fe0bd]">Transaction review — no signature yet</p><p className="mt-2 break-all">Inscription sat → {localPlan.recipient}</p><p className="mt-2 uppercase text-[#f2bd63]">Exact inputs ({localPlan.plan.inputs.length})</p><ul className="mt-1 space-y-1">{localPlan.plan.inputs.map((input, index) => <li key={`${input.txid}:${input.vout}`} className="break-all">{index === 0 ? "Ordinal" : "Fee"}: {input.txid}:{input.vout} · {formatSats(input.valueSats)} · {input.spendType}</li>)}</ul><p className="mt-2 uppercase text-[#f2bd63]">Exact outputs</p><p className="break-all">Recipient: {formatSats(localPlan.plan.outputs[0].valueSats)} → {localPlan.recipient}</p>{localPlan.plan.outputs[1] && <p className="break-all">Vault change: {formatSats(localPlan.plan.outputs[1].valueSats)} → {localPlan.address}</p>}<p className="mt-2">Total inputs: {formatSats(localPlan.plan.totalInputSats)} · exact fee: {formatSats(localPlan.plan.feeSats)} · approx. {localPlan.plan.feeRateSatVb.toFixed(2)} sat/vB</p><label className="mt-3 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmedReview} onChange={event => setConfirmedReview(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span>Je confirme le réseau, l’inscription, chaque entrée/sortie, le destinataire et les frais. Autoriser la signature locale du PSBT.</span></label><button type="button" onClick={() => void signTransfer()} disabled={!confirmedReview || busy || Boolean(signed)} className="inline-flex min-h-11 items-center justify-center bg-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Signing locally…" : "Sign Ordinal locally"}</button></div>}
      {signed && localPlan && <div className="mt-3 border border-[#d99a54]/50 p-3 font-mono text-[10px] leading-5"><p className="break-all text-[#f2bd63]">TXID: {signed.txid}</p><p className="mt-1 text-[#9ea7b3]">Signature locale vérifiée. Confirmez explicitement la diffusion sur le réseau indiqué.</p><label className="mt-2 flex min-h-11 items-start gap-2 py-2 text-[#d9d3c6]"><input type="checkbox" checked={confirmedBroadcast} onChange={event => setConfirmedBroadcast(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span>Je confirme la diffusion irréversible de ce TXID sur {network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}.</span></label><button type="button" onClick={() => void broadcastTransfer()} disabled={!confirmedBroadcast || busy || broadcastAttempted} className="mt-2 inline-flex min-h-11 items-center justify-center bg-[#d99a54] px-4 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Broadcasting…" : broadcastAttempted ? "Broadcast attempted — verify TXID" : "Broadcast via Mempool"}</button></div>}
      {transferError && <p className="mt-3 break-words border border-[#a45e54]/50 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{transferError}</p>}
      {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
    </div>}
  </section>;
}
