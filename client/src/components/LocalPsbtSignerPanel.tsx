import { useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { broadcastLocalPsbt, finalizeLocalPsbt, reviewLocalPsbt, signLocalPsbt, type LocalPsbtReview } from "@/lib/local-psbt-signer";
import type { OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";

export function LocalPsbtSignerPanel({ wallet, network }: { wallet: OrdiWalletRecord; network: OrdiNetwork }) {
  const [psbt, setPsbt] = useState("");
  const [review, setReview] = useState<LocalPsbtReview | null>(null);
  const [signed, setSigned] = useState("");
  const [tx, setTx] = useState<{ rawTxHex: string; txid: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const inspect = () => {
    setError("");
    setMessage("");
    setSigned("");
    setTx(null);
    setConfirmed(false);
    try {
      setReview(reviewLocalPsbt(psbt.trim(), wallet));
    } catch (cause) {
      setReview(null);
      setError(cause instanceof Error ? cause.message : "Invalid PSBT.");
    }
  };

  const sign = () => {
    if (!review || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      setSigned(signLocalPsbt(psbt.trim(), wallet, review));
      setMessage("PSBT signed locally. The transaction has not been broadcast.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Local signing failed.");
    } finally {
      setBusy(false);
    }
  };

  const finalize = () => {
    if (!review || !signed) return;
    setError("");
    try {
      setTx(finalizeLocalPsbt(signed, wallet, review));
      setMessage("Signature verified locally. Check the transaction ID before broadcast.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid signature.");
    }
  };

  const broadcast = async () => {
    if (!review || !tx) return;
    setBusy(true);
    setError("");
    try {
      await broadcastLocalPsbt(network, tx.rawTxHex, tx.txid);
      setMessage(`Transaction broadcast on ${network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal"}: ${tx.txid}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Broadcast status is uncertain. Check Mempool before retrying.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:mt-5 sm:p-4" aria-labelledby="local-psbt-title">
    <div className="flex items-center gap-2 text-[#f2bd63]"><ShieldCheck size={16} /><h3 id="local-psbt-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Local PSBT signer</h3></div>
    <p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">The signer uses only the unlocked vault’s Native SegWit key. It rejects external inputs, modified PSBTs, and dust outputs. No PSBT is sent to a server.</p>
    <label className="sr-only" htmlFor="local-psbt-input">PSBT to sign</label>
    <textarea id="local-psbt-input" value={psbt} onChange={event => setPsbt(event.target.value)} placeholder="Paste the PSBT prepared by the site…" className="mt-3 min-h-28 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" />
    <button type="button" onClick={inspect} disabled={!psbt.trim() || busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40 sm:w-auto">Review PSBT</button>
    {review && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
      <p className="flex items-center gap-2 uppercase text-[#9fe0bd]"><CheckCircle2 size={13} /> Review before signing</p>
      <p className="mt-2">Inputs: {review.inputCount} · outputs: {review.outputCount}</p>
      <p>Total inputs: {review.inputSats.toLocaleString("en-US")} sats · outputs: {review.outputSats.toLocaleString("en-US")} sats</p>
      <p>Exact fee: {review.feeSats.toLocaleString("en-US")} sats{review.feeRateSatVb ? ` · ${review.feeRateSatVb.toFixed(2)} sat/vB` : ""}</p>
      <div className="mt-2 space-y-1">{review.outputs.map((output, index) => <p key={`${output.address}:${index}`} className="break-all">Output {index + 1}: {output.valueSats.toLocaleString("en-US")} sats → {output.address}</p>)}</div>
      <label className="mt-3 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /> <span>I confirm these inputs, outputs, fees, and the {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal mainnet"} network. A local signature will be created.</span></label>
      <button type="button" onClick={sign} disabled={!confirmed || busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center bg-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40 sm:w-auto">{busy ? "Signing…" : "Sign locally"}</button>
    </div>}
    {signed && !tx && <div className="mt-3 border border-[#d99a54]/40 p-3"><p className="font-mono text-[10px] text-[#f2bd63]">PSBT signed in memory; not broadcast.</p><button type="button" onClick={finalize} className="mt-2 inline-flex min-h-11 w-full items-center justify-center border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] sm:w-auto">Verify signature and prepare broadcast</button></div>}
    {tx && <div className="mt-3 border border-[#d99a54]/60 p-3 font-mono text-[10px] leading-5"><p className="break-all text-[#f2bd63]">Expected TXID: {tx.txid}</p><p className="mt-1 text-[#9ea7b3]">Broadcasting is an irreversible on-chain action. Verify the TXID and network one last time.</p><button type="button" onClick={() => void broadcast()} disabled={busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center bg-[#d99a54] px-3 py-2 uppercase text-[#0b0d10] disabled:opacity-40 sm:w-auto">{busy ? "Broadcasting…" : "Broadcast via Mempool"}</button></div>}
    {error && <p className="mt-3 break-words border border-[#a45e54]/50 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
    {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
  </section>;
}
