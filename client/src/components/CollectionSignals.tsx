import { ExternalLink, Loader2 } from "lucide-react";
import { RARITY_META, type RarityTier } from "@/lib/rarity";
import type { LiveInscription } from "@/lib/live";

export function RarityBadge({ tier, detail }: { tier: RarityTier; detail?: string }) {
  const meta = RARITY_META[tier];
  return <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] ${meta.border} ${meta.bg} ${meta.text}`} title={`${meta.label} rarity`}><span aria-hidden="true" className="text-[11px] leading-none">{meta.icon}</span>{meta.label}{detail ? ` · ${detail}` : ""}</span>;
}

function address(value: string | null) {
  if (!value) return "Not available";
  return value;
}

export function LiveDataBlock({ live, loading }: { live: LiveInscription | null; loading: boolean }) {
  return <section className="mt-6 border-y border-[#2c323a] py-4" aria-live="polite">
    <div className="flex items-center justify-between gap-3"><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#718092]">Live UniSat data</p>{loading && <Loader2 size={14} className="animate-spin text-[#d99a54]" />}</div>
    {loading && !live ? <p className="mt-3 font-mono text-[10px] text-[#9ea7b3]">Refreshing owner, creator and listing…</p> : live ? <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <div><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#718092]">Owner</p><p className="mt-1 break-all font-mono text-[10px] text-[#d9d3c6]">{address(live.owner)}</p></div>
      <div><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#718092]">Creator</p><p className="mt-1 break-all font-mono text-[10px] text-[#d9d3c6]">{address(live.creator)}</p></div>
      <div className="sm:col-span-2"><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#718092]">UniSat listing</p><div className="mt-1 flex flex-wrap items-center gap-2"><span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px] uppercase ${live.listing.listed ? "border-[#70c7a0]/60 bg-[#70c7a0]/10 text-[#70c7a0]" : "border-[#4a5562] bg-[#4a5562]/15 text-[#9ea7b3]"}`}><span aria-hidden="true">{live.listing.listed ? "●" : "○"}</span>{live.listing.listed ? "Listed" : "Not listed"}</span>{live.listing.listed && live.listing.price !== null && <span className="font-mono text-[10px] text-[#f2bd63]">{live.listing.price.toLocaleString()} sats</span>}<a className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d99a54] underline underline-offset-3" href={`https://fractal.unisat.io/inscription/${live.inscriptionId}`} target="_blank" rel="noreferrer">Open UniSat <ExternalLink size={11} /></a></div></div>
      <p className="sm:col-span-2 font-mono text-[9px] text-[#718092]">Refreshed {new Date(live.refreshedAt).toLocaleTimeString()}</p>
    </div> : <p className="mt-3 font-mono text-[10px] text-[#a45e54]">Live UniSat data is temporarily unavailable.</p>}
  </section>;
}
