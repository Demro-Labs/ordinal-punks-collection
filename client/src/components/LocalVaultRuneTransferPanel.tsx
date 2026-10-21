import { useEffect, useMemo, useState } from "react";
import { Loader2, Send, ShieldCheck } from "lucide-react";
import { LocalVaultOwnershipProof } from "@/components/LocalVaultOwnershipProof";
import { PreSignatureSecurityPreview } from "@/components/PreSignatureSecurityPreview";
import { fetchAllRuneBalancePages, formatRuneAmount, type RuneBalance } from "@/lib/runes";
import { prepareLocalRuneTransfer, signLocalRuneTransfer, broadcastLocalRuneTransfer, type LocalRuneTransferPlan } from "@/lib/local-rune-transfer";
import type { AddressType, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";

export function LocalVaultRuneTransferPanel({ wallet, network, addressType, site, onDone }: { wallet: OrdiWalletRecord; network: OrdiNetwork; addressType: AddressType; site: "punks" | "pokedex"; onDone?: () => void }) {
  const account = wallet.addresses[addressType];
  const [runes, setRunes] = useState<RuneBalance[]>([]);
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<LocalRuneTransferPlan | null>(null);
  const [signed, setSigned] = useState<{ rawTxHex: string; txid: string } | null>(null);
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const [confirmedReview, setConfirmedReview] = useState(false);
  const [confirmedBroadcast, setConfirmedBroadcast] = useState(false);
  const [broadcastAttempted, setBroadcastAttempted] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const selectedRune = useMemo(() => runes.find(item => item.runeid === selected) ?? null, [runes, selected]);
  const contextKey = selectedRune && amount.trim() && recipient.trim()
    ? JSON.stringify(["local-rune-transfer", site, network, account.address, addressType, selectedRune.runeid, amount.trim(), recipient.trim()])
    : "";

  useEffect(() => {
    let active = true;
    setRunes([]); setSelected(""); setAmount(""); setPlan(null); setSigned(null); setOwnershipProofKey(null);
    setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); setError(""); setMessage("");
    setLoading(true);
    void fetchAllRuneBalancePages(account.address, network).then(page => {
      if (!active) return;
      setRunes(page.detail);
      setSelected(page.detail[0]?.runeid ?? "");
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Rune balance list unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account.address, network]);

  const reset = () => { setPlan(null); setSigned(null); setConfirmedReview(false); setConfirmedBroadcast(false); setBroadcastAttempted(false); setMessage(""); };
  const prepare = async () => {
    if (!selectedRune || !contextKey || ownershipProofKey !== contextKey) { setError("Complete the BIP-322 proof for this exact Rune transfer first."); return; }
    setBusy(true); setError(""); setMessage(""); reset();
    try {
      setPlan(await prepareLocalRuneTransfer({ network, wallet, addressType, runeid: selectedRune.runeid, amount, recipient }));
      setMessage("Rune transaction prepared and checked locally. No signature or broadcast yet.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Rune preflight failed."); }
    finally { setBusy(false); }
  };
  const sign = async () => {
    if (!plan || !confirmedReview || ownershipProofKey !== contextKey) return;
    setBusy(true); setError("");
    try { setSigned(await signLocalRuneTransfer(plan, wallet)); setMessage("Runestone PSBT signed and verified locally; not broadcast."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Local Rune signing failed."); }
    finally { setBusy(false); }
  };
  const broadcast = async () => {
    if (!plan || !signed || !confirmedBroadcast || broadcastAttempted) return;
    setBroadcastAttempted(true); setBusy(true); setError("");
    try { const txid = await broadcastLocalRuneTransfer(plan, wallet, signed); setMessage(`Rune transaction broadcast: ${txid}`); onDone?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Broadcast outcome uncertain; check the TXID before retrying."); }
    finally { setBusy(false); }
  };

  return <article className="min-w-0 border border-[#2c323a] bg-[#0b0f13] p-3">
    <div className="flex items-center gap-2 text-[#d7a9ff]"><ShieldCheck size={14}/><h3 className="font-mono text-[10px] uppercase">Parcours A · Runes · Local Vault PSBT</h3></div>
    <p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Runestone built and signed locally by Ordi Wallet. UniSat is not used as a wallet signer. The read-only indexer is used to verify Rune-bearing UTXOs; the vault refuses mixed Rune/Ordinal inputs and incomplete index data.</p>
    {loading && <p className="mt-2 font-mono text-[10px] text-[#718092]">Loading Rune balances…</p>}
    <label className="mt-3 block font-mono text-[9px] uppercase text-[#9ea7b3]">Rune</label>
    <select value={selected} onChange={e => { setSelected(e.target.value); reset(); setOwnershipProofKey(null); }} disabled={loading || busy || !runes.length} className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#10151a] p-2 font-mono text-sm text-[#f3efe5]">
      {runes.map(rune => <option key={rune.runeid} value={rune.runeid}>{rune.spacedRune} · {formatRuneAmount(rune.amount, rune.divisibility)} · {rune.runeid}</option>)}
    </select>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <input aria-label="Rune amount" value={amount} onChange={e => { setAmount(e.target.value); reset(); setOwnershipProofKey(null); }} placeholder="Amount to send" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#10151a] p-2 font-mono text-sm text-[#f3efe5]"/>
      <input aria-label="Rune recipient address" value={recipient} onChange={e => { setRecipient(e.target.value); reset(); setOwnershipProofKey(null); }} placeholder="Recipient address" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#10151a] p-2 font-mono text-sm text-[#f3efe5]"/>
    </div>
    {contextKey && <LocalVaultOwnershipProof key={contextKey} site={site} network={network} wallet={wallet} addressType={addressType} contextKey={contextKey} onVerified={setOwnershipProofKey}/>}
    <button type="button" onClick={() => void prepare()} disabled={busy || loading || !contextKey} className="mt-2 inline-flex min-h-11 items-center gap-2 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">{busy ? <Loader2 size={12} className="animate-spin"/> : <Send size={12}/>} Review Rune transfer locally</button>
    {plan && <div className="mt-3 border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
      <p>Network: {network} · Rune: {plan.runeName} ({plan.runeid})</p>
      <PreSignatureSecurityPreview network={network === "BITCOIN_MAINNET" ? "Bitcoin mainnet · BTC" : "Fractal Bitcoin mainnet · FB"} transactionType="Rune transfer · Local Vault" source={account.address} destination={plan.recipient} amount={`${formatRuneAmount(plan.amountBaseUnits, plan.divisibility)} ${plan.runeName}`} inputs={[`${plan.runeInputs.length} Rune input(s)`, `${plan.feeInputs.length} fee UTXO(s)`]} outputs={[`Rune destination: ${formatRuneAmount(plan.amountBaseUnits, plan.divisibility)} → ${plan.recipient}`, `Rune change: ${formatRuneAmount(plan.runeChangeBaseUnits, plan.divisibility)}`, "Runestone protocol output is included in the signed transaction"]} fees={`${plan.feeSats.toLocaleString()} sats · ${plan.feeRateSatVb} sat/vB`} warnings={["Vérifiez chaque entrée Rune et les UTXO de frais; les actifs ne doivent pas être mélangés.", "Un index incomplet ou une entrée indisponible doit bloquer la signature."]} /><p>Amount: {formatRuneAmount(plan.amountBaseUnits, plan.divisibility)} · change: {formatRuneAmount(plan.runeChangeBaseUnits, plan.divisibility)}</p>
      <p className="break-all">Recipient: {plan.recipient}</p><p>Inputs: {plan.runeInputs.length} Rune + {plan.feeInputs.length} fee UTXO · fee: {plan.feeSats.toLocaleString()} sats ({plan.feeRateSatVb} sat/vB)</p>
      <label className="mt-2 flex min-h-11 items-start gap-2"><input type="checkbox" checked={confirmedReview} onChange={e => setConfirmedReview(e.target.checked)} className="mt-1 h-4 w-4"/><span>I confirm the Rune amount, recipient, source account, outputs and network fees.</span></label>
      <button type="button" onClick={() => void sign()} disabled={!confirmedReview || busy || ownershipProofKey !== contextKey || Boolean(signed)} className="mt-2 min-h-11 bg-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">Sign Runestone locally</button>
    </div>}
    {signed && <div className="mt-3 border border-[#d99a54]/40 p-3 font-mono text-[10px]"><p className="break-all text-[#f2bd63]">TXID: {signed.txid}</p><label className="mt-2 flex min-h-11 items-start gap-2"><input type="checkbox" checked={confirmedBroadcast} onChange={e => setConfirmedBroadcast(e.target.checked)} className="mt-1 h-4 w-4"/><span>Confirm irreversible broadcast to {network}.</span></label><button type="button" onClick={() => void broadcast()} disabled={!confirmedBroadcast || busy || broadcastAttempted} className="mt-2 min-h-11 bg-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{broadcastAttempted ? "Broadcast attempted — verify TXID" : "Broadcast via Mempool"}</button></div>}
    {error && <p role="alert" className="mt-2 break-words border border-[#a45e54]/50 p-2 font-mono text-[10px] text-[#e6a69b]">{error}</p>}
    {message && <p role="status" className="mt-2 break-words border border-[#70c7a0]/30 p-2 font-mono text-[10px] text-[#9fe0bd]">{message}</p>}
  </article>;
}
