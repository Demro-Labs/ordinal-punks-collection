import { ChevronLeft, ChevronRight, ExternalLink, Grid2X2, List, Loader2, Rows3 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { LiveMarket, LiveMarketListing } from "@/lib/market";

const FB_LOGO = `${import.meta.env.BASE_URL}assets/brand/social/fractal-bitcoin.png`;
const fb = (value: number | null) => value == null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} FB`;
const usd = (value: number | null, fbPrice: number | null, fbUsd: number | null | undefined) => {
  const resolved = value ?? (fbPrice != null && fbUsd != null ? fbPrice * fbUsd : null);
  return resolved == null ? "—" : `$${resolved.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};
const satsToFb = (value: number | null) => value == null ? null : value / 100_000_000;
type ViewMode = "grid" | "compact" | "list";
type SortMode = "default" | "low" | "high";

type Props = {
  market: LiveMarket | null;
  allListings?: LiveMarketListing[];
  allListingsLoaded: boolean;
  allListingsLoading: boolean;
  allListingsError: string;
  loading: boolean;
  error: string;
  page: number;
  onPage: (page: number) => void;
  imageForListing?: (item: LiveMarketListing) => string | null;
  onRetry?: () => void;
};

function PageControls({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  return <div className="flex items-center justify-center gap-3" aria-label="Listed gallery pagination">
    <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} className="border border-[#3b434d] p-2 text-[#9ea7b3] disabled:opacity-30" aria-label="Previous listed page"><ChevronLeft size={15} /></button>
    <span className="inline-flex h-9 min-w-9 items-center justify-center border border-[#d99a54] bg-[#d99a54] px-2 font-mono text-xs text-[#0b0d10]" aria-current="page">{page + 1}</span>
    <span className="font-mono text-[10px] uppercase text-[#718092]">of {pageCount}</span>
    <button type="button" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)} className="border border-[#3b434d] p-2 text-[#9ea7b3] disabled:opacity-30" aria-label="Next listed page"><ChevronRight size={15} /></button>
  </div>;
}

export function MarketPanel({ market, allListings = [], allListingsLoaded, allListingsLoading, allListingsError, loading, error, page, onPage, imageForListing, onRetry }: Props) {
  const [view, setView] = useState<ViewMode>("grid");
  const [sort, setSort] = useState<SortMode>("default");
  const sectionRef = useRef<HTMLElement>(null);
  const changeMarketPage = (nextPage: number) => {
    onPage(nextPage);
    window.requestAnimationFrame(() => {
      const section = sectionRef.current;
      if (!section) return;
      const top = window.scrollY + section.getBoundingClientRect().top - 16;
      window.scrollTo({ top, behavior: "smooth" });
    });
  };
  const stats = market?.stats;
  const source = allListingsLoaded ? allListings : (market?.listings ?? []);
  const pageCount = Math.max(1, Math.ceil((market?.totalListings || allListings.length) / 20));
  const sortedListings = useMemo(() => [...source].sort((a, b) => {
    if (sort === "default") return 0;
    const av = a.priceFb ?? satsToFb(a.priceSats);
    const bv = b.priceFb ?? satsToFb(b.priceSats);
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return sort === "low" ? av - bv : bv - av;
  }), [source, sort]);
  const listings = allListingsLoaded ? sortedListings.slice(page * 20, page * 20 + 20) : sortedListings.slice(0, 20);
  const cardClass = view === "list" ? "grid min-w-0 grid-cols-1 gap-3" : view === "compact" ? "grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" : "grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4";
  return <section ref={sectionRef} className="scroll-mt-4 w-full min-w-0 border-b border-[#2c323a] bg-[#10151a] px-5 py-5 sm:px-8 lg:px-12" aria-label="Live collection market">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d99a54]">Live market / FB</p><h2 className="mt-2 font-display text-2xl font-semibold text-[#f3efe5]">Listed gallery</h2></div><span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#718092]">Powered by UniSat · {market ? new Date(market.refreshedAt).toLocaleTimeString() : "refreshing"}</span></div>
    <div className="mt-5 grid grid-cols-2 gap-px border border-[#2c323a] bg-[#2c323a] sm:grid-cols-4">{[["Total volume", fb(stats?.volumeTotalFb ?? null), usd(stats?.volumeTotalUsd ?? null, stats?.volumeTotalFb ?? null, market?.fbUsd)], ["24h volume", fb(stats?.volume24hFb ?? null), usd(stats?.volume24hUsd ?? null, stats?.volume24hFb ?? null, market?.fbUsd)], ["Floor price", fb(stats?.floorFb ?? null), usd(stats?.floorUsd ?? null, stats?.floorFb ?? null, market?.fbUsd)], ["Market cap", fb(stats?.marketCapFb ?? null), usd(stats?.marketCapUsd ?? null, stats?.marketCapFb ?? null, market?.fbUsd)]].map(([label, main, secondary]) => <div key={label} className="bg-[#14191f] p-3 sm:p-4"><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#718092]">{label}</p><p className="mt-2 flex items-center gap-1 font-mono text-sm text-[#f2bd63]"><img src={FB_LOGO} alt="FB" className="h-4 w-4 rounded-full object-cover" />{main}</p><p className="mt-1 font-mono text-[10px] text-[#9ea7b3]">{secondary}</p></div>)}</div>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#9ea7b3]">Listed tokens · {stats?.listed ?? market?.totalListings ?? 0} live tokens</p><div className="flex flex-wrap items-center gap-2"><label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#718092]">Price <select value={sort} disabled={!allListingsLoaded || allListingsLoading || Boolean(allListingsError)} onChange={(event) => { setSort(event.target.value as SortMode); changeMarketPage(0); }} className="ml-1 border border-[#3b434d] bg-[#12161b] px-2 py-2 text-[#d9d3c6] outline-none focus:border-[#3b434d] focus:outline-none focus:ring-0"><option value="default">Default</option><option value="low">Low to high</option><option value="high">High to low</option></select></label><div className="flex border border-[#3b434d]" aria-label="Gallery display mode"><button type="button" onClick={() => setView("grid")} aria-label="Grid view" aria-pressed={view === "grid"} className={`p-2 ${view === "grid" ? "bg-[#d99a54] text-[#0b0d10]" : "text-[#9ea7b3]"}`}><Grid2X2 size={14} /></button><button type="button" onClick={() => setView("compact")} aria-label="Compact view" aria-pressed={view === "compact"} className={`p-2 ${view === "compact" ? "bg-[#d99a54] text-[#0b0d10]" : "text-[#9ea7b3]"}`}><Rows3 size={14} /></button><button type="button" onClick={() => setView("list")} aria-label="List view" aria-pressed={view === "list"} className={`p-2 ${view === "list" ? "bg-[#d99a54] text-[#0b0d10]" : "text-[#9ea7b3]"}`}><List size={14} /></button></div></div></div>
    <div className="mt-4"><PageControls page={page} pageCount={pageCount} onPage={changeMarketPage} /></div>{allListingsLoading && <p className="mt-3 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-[#718092]">Syncing all live UniSat pages for complete price sorting…</p>}{allListingsError && <p className="mt-3 text-center font-mono text-[9px] text-[#a45e54]">Global price sorting is unavailable until live listings finish syncing.</p>}
    {loading && !market ? <div className="mt-4 flex items-center justify-center gap-2 font-mono text-[10px] text-[#9ea7b3]"><Loader2 size={14} className="animate-spin text-[#d99a54]" /> Loading live listings…</div> : error ? <div className="mt-4 flex flex-wrap items-center justify-center gap-3 font-mono text-[10px] text-[#a45e54]"><span>{error}</span>{onRetry && <button type="button" onClick={onRetry} className="border border-[#a45e54]/60 px-3 py-2 uppercase tracking-[0.1em] text-[#d9d3c6] hover:border-[#d99a54]">Retry</button>}</div> : market && market.totalListings === 0 ? <p className="mt-4 border border-dashed border-[#3b434d] p-8 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-[#718092]">No live listings found for this collection.</p> : <div className={`mt-3 w-full min-w-0 ${cardClass}`}>{listings.map((item) => { const image = imageForListing?.(item); return <a key={item.inscriptionId} href={`https://fractal.unisat.io/inscription/${item.inscriptionId}`} target="_blank" rel="noreferrer" className={`w-full min-w-0 max-w-full border border-[#2c323a] bg-[#14191f] p-3 transition-colors hover:border-[#d99a54]/70 ${view === "list" ? "flex items-center gap-4" : ""}`}><div className={`${view === "list" ? "h-20 w-20 shrink-0" : "mb-2 aspect-square"} overflow-hidden bg-[#171b21]`}>{image ? <img src={image} alt={`${item.collectionItemName || "Listed token"} artwork`} className="h-full w-full object-cover" loading="lazy" /> : <div className="flex h-full items-center justify-center font-mono text-[9px] uppercase text-[#718092]">Artwork unavailable</div>}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-sans text-xs text-[#f3efe5]">{item.collectionItemName || item.inscriptionId.slice(0, 10)}</span><ExternalLink size={12} className="shrink-0 text-[#d99a54]" /></div><p className="mt-2 font-mono text-xs text-[#f2bd63]">{fb(item.priceFb ?? satsToFb(item.priceSats))}</p><p className="mt-1 font-mono text-[10px] text-[#9ea7b3]">{usd(item.priceUsd, item.priceFb ?? satsToFb(item.priceSats), market?.fbUsd)} · {item.marketType || "fixedPrice"}</p><p className="mt-1 truncate font-mono text-[9px] text-[#718092]">{item.inscriptionId}</p></div></a>; })}</div>}
    <div className="mt-5"><PageControls page={page} pageCount={pageCount} onPage={changeMarketPage} /></div>
  </section>;
}
