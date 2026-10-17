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
  const inspect = () => { setError(""); setMessage(""); setSigned(""); setTx(null); setConfirmed(false); try { setReview(reviewLocalPsbt(psbt.trim(), wallet)); } catch (cause) { setReview(null); setError(cause instanceof Error ? cause.message : "PSBT invalide."); } };
  const sign = () => { if (!review || !confirmed) return; setBusy(true); setError(""); try { setSigned(signLocalPsbt(psbt.trim(), wallet, review)); setMessage("PSBT signé localement. La transaction n’est pas encore diffusée."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Signature locale impossible."); } finally { setBusy(false); } };
  const finalize = () => { if (!review || !signed) return; setError(""); try { setTx(finalizeLocalPsbt(signed, wallet, review)); setMessage("Signature vérifiée localement. Vérifie encore le TXID avant diffusion."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Signature invalide."); } };
  const broadcast = async () => { if (!review || !tx) return; setBusy(true); setError(""); try { await broadcastLocalPsbt(network, tx.rawTxHex, tx.txid); setMessage(`Transaction diffusée sur ${network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal"} : ${tx.txid}`); } catch (cause) { setError(cause instanceof Error ? cause.message : "Diffusion incertaine. Vérifie Mempool avant de réessayer."); } finally { setBusy(false); } };
  return <section className="mt-5 border border-[#d99a54]/50 bg-[#10151a] p-4" aria-labelledby="local-psbt-title">
    <div className="flex items-center gap-2 text-[#f2bd63]"><ShieldCheck size={16} /><h3 id="local-psbt-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Signer PSBT local</h3></div>
    <p className="mt-2 font-mono text-[9px] leading-5 text-[#9ea7b3]">Le signer utilise uniquement la clé Native SegWit du coffre déverrouillé. Il refuse les entrées externes, les PSBT modifiés et les sorties dust. Aucun PSBT n’est envoyé à un serveur.</p>
    <textarea value={psbt} onChange={event => setPsbt(event.target.value)} placeholder="Colle ici le PSBT préparé par le site…" className="mt-3 min-h-24 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-[9px] text-[#f3efe5]" aria-label="PSBT à signer" />
    <button type="button" onClick={inspect} disabled={!psbt.trim() || busy} className="mt-2 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">Revoir le PSBT</button>
    {review && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[9px] leading-5 text-[#d9d3c6]"><p className="flex items-center gap-2 uppercase text-[#9fe0bd]"><CheckCircle2 size={13} /> Revue avant signature</p><p className="mt-2">Entrées : {review.inputCount} · sorties : {review.outputCount}</p><p>Total entrées : {review.inputSats.toLocaleString()} sats · sorties : {review.outputSats.toLocaleString()} sats</p><p>Frais exacts : {review.feeSats.toLocaleString()} sats{review.feeRateSatVb ? ` · ${review.feeRateSatVb.toFixed(2)} sat/vB` : ""}</p><div className="mt-2 space-y-1">{review.outputs.map((output, index) => <p key={`${output.address}:${index}`} className="break-all">Sortie {index + 1} : {output.valueSats.toLocaleString()} sats → {output.address}</p>)}</div><label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" /> <span>Je confirme ces entrées, sorties, frais et le réseau {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal mainnet"}. Une signature locale sera produite.</span></label><button type="button" onClick={sign} disabled={!confirmed || busy} className="mt-3 bg-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Signature…" : "Signer localement"}</button></div>}
    {signed && !tx && <div className="mt-3 border border-[#d99a54]/40 p-3"><p className="font-mono text-[9px] text-[#f2bd63]">PSBT signé en mémoire, non diffusé.</p><button type="button" onClick={finalize} className="mt-2 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">Vérifier la signature et préparer la diffusion</button></div>}
    {tx && <div className="mt-3 border border-[#d99a54]/60 p-3 font-mono text-[9px] leading-5"><p className="break-all text-[#f2bd63]">TXID attendu : {tx.txid}</p><p className="mt-1 text-[#9ea7b3]">La diffusion est une action on-chain irréversible. Vérifie une dernière fois le TXID et le réseau.</p><button type="button" onClick={() => void broadcast()} disabled={busy} className="mt-2 bg-[#d99a54] px-3 py-2 uppercase text-[#0b0d10] disabled:opacity-40">{busy ? "Diffusion…" : "Diffuser sur Mempool"}</button></div>}
    {error && <p className="mt-3 border border-[#a45e54]/50 p-3 font-mono text-[9px] text-[#e6a69b]" role="alert">{error}</p>}
    {message && <p className="mt-3 border border-[#70c7a0]/40 p-3 font-mono text-[9px] text-[#9fe0bd]" role="status">{message}</p>}
  </section>;
}
