/** Inscription Ledger: page de catalogue éditorial, asymétrique, tactile et toujours reliée à la source UniSat. */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, ExternalLink, Filter, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { COLLECTION_DATA_URL, INSCRIPTION_BASE_URL, SHEET_URLS } from "@/lib/collection";

const PER_PAGE = 20;
const TOTAL_ITEMS = 10000;
const ASSET_BASE = import.meta.env.BASE_URL;
const HERO_URL = `${ASSET_BASE}assets/brand/ordinal-ledger-hero.webp`;
const PAPER_URL = `${ASSET_BASE}assets/brand/ordinal-ledger-paper-texture.webp`;
const MARK_URL = `${ASSET_BASE}assets/brand/ordinal-ledger-mark.webp`;
const STAMP_URL = `${ASSET_BASE}assets/brand/ordinal-ledger-stamp.webp`;

type Trait = { trait_type: string; value: string };
type PunkRecord = {
  id: string;
  name: string;
  tokenId: string;
  fileName: string;
  attributes: Trait[];
  sheet: number;
  col: number;
  row: number;
};

type FilterKey = "Sex" | "Background";

function getTrait(record: PunkRecord, label: string) {
  return record.attributes.find((attribute) => attribute.trait_type === label)?.value ?? "—";
}

function shortId(id: string) {
  return `${id.slice(0, 10)}…${id.slice(-8)}`;
}

function inscriptionUrl(id: string) {
  return `${INSCRIPTION_BASE_URL}${id}`;
}

function uniqueValues(records: PunkRecord[], key: FilterKey) {
  return Array.from(new Set(records.map((record) => getTrait(record, key)).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function SpriteImage({ record }: { record: PunkRecord }) {
  const horizontal = record.col === 0 ? 0 : (record.col / 9) * 100;
  const vertical = record.row === 0 ? 0 : (record.row / 9) * 100;
  return (
    <div
      className="card-image relative aspect-square overflow-hidden bg-[#ede7dc]"
      aria-label={`${record.name}, image de la collection`}
      role="img"
      style={{
        backgroundImage: `url(${SHEET_URLS[record.sheet]})`,
        backgroundPosition: `${horizontal}% ${vertical}%`,
        backgroundSize: "1000% 1000%",
      }}
    >
      <span className="absolute left-3 top-3 bg-[#f1ede3]/90 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#26241f]">
        #{record.tokenId}
      </span>
      <span className="absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center border border-[#c8663d]/70 bg-[#f1ede3]/90 text-[#c8663d] opacity-0 transition-all duration-200 group-hover:opacity-100">
        <ArrowUpRight size={14} strokeWidth={1.7} />
      </span>
    </div>
  );
}

function Pagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (next: number) => void }) {
  const pages = Array.from(new Set([1, page - 1, page, page + 1, pageCount])).filter((value) => value >= 1 && value <= pageCount).sort((a, b) => a - b);
  return (
    <nav className="flex items-center justify-between gap-4 border-t border-[#d8d0c2] pt-5" aria-label="Pagination du catalogue">
      <Button variant="ghost" className="h-10 rounded-none px-0 text-[#6d685e] hover:bg-transparent hover:text-[#26241f] disabled:opacity-35" disabled={page === 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft size={16} />
        Previous
      </Button>
      <div className="flex items-center gap-1">
        {pages.map((pageNumber, index) => {
          const previous = pages[index - 1];
          const gap = previous && pageNumber - previous > 1;
          return (
            <span key={pageNumber} className="flex items-center gap-1">
              {gap && <span className="px-1 font-mono text-xs text-[#969084]">…</span>}
              <button
                type="button"
                onClick={() => onChange(pageNumber)}
                aria-current={pageNumber === page ? "page" : undefined}
                className={`h-9 min-w-9 border px-2 font-mono text-xs transition-colors ${pageNumber === page ? "border-[#26241f] bg-[#26241f] text-[#f1ede3]" : "border-transparent text-[#6d685e] hover:border-[#bdb3a3] hover:text-[#26241f]"}`}
              >
                {String(pageNumber).padStart(2, "0")}
              </button>
            </span>
          );
        })}
      </div>
      <Button variant="ghost" className="h-10 rounded-none px-0 text-[#6d685e] hover:bg-transparent hover:text-[#26241f] disabled:opacity-35" disabled={page === pageCount} onClick={() => onChange(page + 1)}>
        Next
        <ChevronRight size={16} />
      </Button>
    </nav>
  );
}

function DetailPanel({ record, onClose }: { record: PunkRecord; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#26241f]/55 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="max-h-[min(760px,calc(100vh-2rem))] w-full max-w-5xl overflow-auto border border-[#cfc5b6] bg-[#f5f0e7] shadow-[0_24px_80px_rgba(38,36,31,0.28)]" role="dialog" aria-modal="true" aria-labelledby="detail-title">
        <div className="flex items-center justify-between border-b border-[#d8d0c2] px-5 py-4 sm:px-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#8a8275]">Collection record / {record.fileName}</p>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center text-[#6d685e] transition-colors hover:bg-[#e6dfd3] hover:text-[#26241f]" aria-label="Fermer la fiche">
            <X size={18} />
          </button>
        </div>
        <div className="grid gap-8 p-5 sm:p-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div className="relative overflow-hidden border border-[#d8d0c2] bg-[#ede7dc]">
            <SpriteImage record={record} />
            <div className="absolute inset-0 pointer-events-none border-[12px] border-[#f5f0e7]/20" />
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#c8663d]">Ordinal Punk #{record.tokenId}</span>
            <h2 id="detail-title" className="mt-3 font-display text-3xl font-semibold leading-tight text-[#26241f] sm:text-4xl">{record.name}</h2>
            <p className="mt-4 border-l-2 border-[#c8663d] pl-4 font-sans text-sm leading-6 text-[#6d685e]">{getTrait(record, "Description")}</p>
            <div className="mt-7 border-y border-[#d8d0c2] py-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#969084]">Inscription ID</p>
              <a className="mt-2 block break-all font-mono text-xs leading-5 text-[#403d36] underline decoration-[#c8663d]/40 underline-offset-4 transition-colors hover:text-[#c8663d]" href={inscriptionUrl(record.id)} target="_blank" rel="noreferrer">{record.id}</a>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
              {record.attributes.filter((attribute) => !["Description", "File Name"].includes(attribute.trait_type)).map((attribute) => (
                <div key={`${attribute.trait_type}-${attribute.value}`}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#969084]">{attribute.trait_type}</p>
                  <p className="mt-1 font-sans text-sm text-[#26241f]">{attribute.value}</p>
                </div>
              ))}
            </div>
            <a className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 bg-[#c8663d] px-5 font-mono text-xs uppercase tracking-[0.14em] text-[#fffaf2] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-[#aa4f2f] active:scale-[0.97]" href={inscriptionUrl(record.id)} target="_blank" rel="noreferrer">
              Ouvrir la source UniSat
              <ExternalLink size={15} />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center border-y border-[#d8d0c2] bg-[#ede7dc]/50">
      <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.16em] text-[#6d685e]">
        <Loader2 size={16} className="animate-spin text-[#c8663d]" />
        Ouverture du registre…
      </div>
    </div>
  );
}

export default function Home() {
  const [records, setRecords] = useState<PunkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sex, setSex] = useState("all");
  const [background, setBackground] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PunkRecord | null>(null);
  const galleryRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(COLLECTION_DATA_URL, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Impossible de charger le registre.");
        return response.json();
      })
      .then((data: PunkRecord[]) => setRecords(data))
      .catch((fetchError: Error) => {
        if (fetchError.name !== "AbortError") setError(fetchError.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const sexValues = useMemo(() => uniqueValues(records, "Sex"), [records]);
  const backgroundValues = useMemo(() => uniqueValues(records, "Background"), [records]);

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery = !normalized || [record.name, record.id, record.tokenId, ...record.attributes.map((item) => item.value)].join(" ").toLowerCase().includes(normalized);
      const matchesSex = sex === "all" || getTrait(record, "Sex") === sex;
      const matchesBackground = background === "all" || getTrait(record, "Background") === background;
      return matchesQuery && matchesSex && matchesBackground;
    });
  }, [background, query, records, sex]);

  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / PER_PAGE));
  const visibleRecords = filteredRecords.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const firstVisible = filteredRecords.length === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const lastVisible = Math.min(page * PER_PAGE, filteredRecords.length);

  useEffect(() => {
    setPage(1);
  }, [background, query, sex]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const changePage = (nextPage: number) => {
    setPage(nextPage);
    galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-[#f1ede3] text-[#26241f]">
      <header className="border-b border-[#d8d0c2] bg-[#f1ede3]/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 sm:px-8 lg:px-12">
          <a href="#top" className="group flex items-center gap-3" aria-label="Ordinal Punks Collection, retour en haut">
            <img src={MARK_URL} alt="" className="h-10 w-10 object-contain transition-transform duration-200 group-hover:rotate-3" />
            <span className="hidden items-baseline gap-2 font-display tracking-[-0.04em] sm:flex"><span className="text-lg font-semibold">Ordinal Punks</span><span className="text-[#c8663d]">/</span><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6d685e]">Ledger</span></span>
          </a>
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[#6d685e] sm:gap-8">
            <span className="hidden sm:inline">Fractal Bitcoin</span>
            <a className="inline-flex items-center gap-1.5 text-[#26241f] underline decoration-[#c8663d] underline-offset-4 transition-colors hover:text-[#c8663d]" href="https://fractal.unisat.io/market/collection?collectionId=opunk" target="_blank" rel="noreferrer">
              Collection on UniSat <ArrowUpRight size={13} />
            </a>
          </div>
        </div>
      </header>

      <div id="top" className="mx-auto grid max-w-[1440px] lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden border-r border-[#d8d0c2] lg:block">
          <div className="sticky top-0 flex min-h-[calc(100vh-73px)] flex-col justify-between p-8">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#969084]">Archive index</p>
              <div className="mt-8 space-y-7">
                <div>
                  <p className="font-mono text-3xl leading-none text-[#26241f]">10k</p>
                  <p className="mt-2 font-sans text-xs text-[#6d685e]">inscriptions cataloguées</p>
                </div>
                <div className="h-px w-10 bg-[#c8663d]" />
                <div>
                  <p className="font-mono text-3xl leading-none text-[#26241f]">500</p>
                  <p className="mt-2 font-sans text-xs text-[#6d685e]">planches de 20 pièces</p>
                </div>
              </div>
              <div className="mt-12 border-t border-[#d8d0c2] pt-6">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#969084]">Network</p>
                <p className="mt-2 font-sans text-sm text-[#403d36]">Fractal Bitcoin</p>
                <p className="mt-1 font-mono text-[10px] text-[#969084]">Collection ID / opunk</p>
              </div>
            </div>
            <div>
              <img src={STAMP_URL} alt="" className="mb-5 h-16 w-16 opacity-80" />
              <p className="font-mono text-[10px] leading-5 text-[#969084]">Every image is indexed with its original inscription ID and source link.</p>
            </div>
          </div>
        </aside>

        <main className="min-w-0">
          <section className="relative isolate overflow-hidden border-b border-[#d8d0c2] px-5 py-10 sm:px-8 sm:py-14 lg:px-12 lg:py-20" style={{ backgroundImage: `url(${HERO_URL})`, backgroundPosition: "center right", backgroundSize: "cover" }}>
            <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(241,237,227,0.98)_0%,rgba(241,237,227,0.93)_42%,rgba(241,237,227,0.25)_100%)]" />
            <div className="max-w-3xl">
              <p className="mb-6 font-mono text-[10px] uppercase tracking-[0.24em] text-[#c8663d]">Field catalogue / 2026 edition</p>
              <h1 className="max-w-2xl font-display text-5xl font-semibold leading-[0.95] tracking-[-0.06em] text-[#26241f] sm:text-7xl lg:text-[6.4rem]">Ten thousand<br /><span className="text-[#c8663d]">inscriptions.</span></h1>
              <p className="mt-7 max-w-lg font-sans text-base leading-7 text-[#514d45] sm:text-lg">Un index vivant des Ordinal Punks inscrits sur Fractal Bitcoin. Explorez chaque pièce, lisez ses traits et revenez à sa source UniSat.</p>
              <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[#6d685e]">
                <span className="flex items-center gap-2"><span className="h-2 w-2 bg-[#c8663d]" /> 10,000 unique records</span>
                <span className="flex items-center gap-2"><span className="h-2 w-2 bg-[#26241f]" /> Fractal mainnet</span>
              </div>
            </div>
          </section>

          <section className="border-b border-[#d8d0c2] bg-[#eee8de] px-5 py-5 sm:px-8 lg:px-12" aria-label="Filtres du catalogue">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
                <label className="relative block min-w-0 flex-1 md:max-w-md">
                  <span className="sr-only">Rechercher un ordinal</span>
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#969084]" />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by ID, name or trait" className="h-11 rounded-none border-[#cfc5b6] bg-[#f5f0e7] pl-10 font-mono text-xs text-[#26241f] placeholder:text-[#969084] focus-visible:ring-[#c8663d]" />
                </label>
                <label className="flex h-11 items-center gap-2 border border-[#cfc5b6] bg-[#f5f0e7] px-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#969084]">Sex</span>
                  <select value={sex} onChange={(event) => setSex(event.target.value)} className="bg-transparent pr-5 font-sans text-sm text-[#403d36] outline-none">
                    <option value="all">All</option>
                    {sexValues.map((value) => <option value={value} key={value}>{value}</option>)}
                  </select>
                </label>
                <label className="flex h-11 items-center gap-2 border border-[#cfc5b6] bg-[#f5f0e7] px-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#969084]">Background</span>
                  <select value={background} onChange={(event) => setBackground(event.target.value)} className="max-w-[120px] bg-transparent pr-5 font-sans text-sm text-[#403d36] outline-none">
                    <option value="all">All</option>
                    {backgroundValues.map((value) => <option value={value} key={value}>{value}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a8275]"><Filter size={14} /> {filteredRecords.length.toLocaleString("en-US")} results</div>
            </div>
          </section>

          <section ref={galleryRef} className="ledger-sheet scroll-mt-8 px-5 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
            <div className="relative mb-7 flex flex-col gap-2 overflow-hidden border-b border-[#d8d0c2] pb-5 sm:flex-row sm:items-end sm:justify-between">
              <div className="relative z-10">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#c8663d]">Plate {String(page).padStart(3, "0")}</p>
                <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.04em] text-[#26241f] sm:text-3xl">Collection index</h2>
              </div>
              <span aria-hidden="true" className="pointer-events-none absolute -right-2 -top-8 font-mono text-[7rem] font-semibold leading-none tracking-[-0.12em] text-[#d8d0c2]/80 sm:-top-10 sm:text-[9rem]">{String(page).padStart(3, "0")}</span>
              {!loading && !error && <p className="font-mono text-xs text-[#8a8275]">Showing {firstVisible.toLocaleString("en-US")}–{lastVisible.toLocaleString("en-US")} / {filteredRecords.length.toLocaleString("en-US")}</p>}
            </div>

            {loading ? <LoadingState /> : error ? (
              <div className="border border-[#c8663d]/40 bg-[#c8663d]/5 p-8 text-center font-sans text-sm text-[#aa4f2f]">{error} Réessayez après avoir rechargé la page.</div>
            ) : visibleRecords.length === 0 ? (
              <div className="border border-[#d8d0c2] bg-[#eee8de] p-12 text-center"><p className="font-display text-2xl text-[#26241f]">No records found</p><p className="mt-2 font-sans text-sm text-[#6d685e]">Modifiez la recherche ou les filtres pour rouvrir une planche.</p></div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4 xl:grid-cols-5">
                  {visibleRecords.map((record) => (
                    <article key={record.id} className="group min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-500">
                      <button type="button" className="block w-full text-left" onClick={() => setSelected(record)} aria-label={`Ouvrir la fiche de ${record.name}`}>
                        <SpriteImage record={record} />
                      </button>
                      <div className="pt-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#c8663d]">Accession / {record.fileName}</p>
                            <h3 className="mt-1 truncate font-display text-sm font-semibold text-[#26241f]">{record.name}</h3>
                            <a className="mt-1 block truncate font-mono text-[10px] text-[#969084] underline decoration-[#c8663d]/35 underline-offset-3 transition-colors hover:text-[#c8663d]" href={inscriptionUrl(record.id)} target="_blank" rel="noreferrer"><span className="text-[#b2a99c]">ID </span>{shortId(record.id)}</a>
                          </div>
                          <Badge variant="outline" className="shrink-0 rounded-none border-[#cfc5b6] px-1.5 py-0.5 font-mono text-[9px] font-normal text-[#8a8275]">{record.attributes.length} traits</Badge>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-[#d8d0c2] pt-2.5">
                          {["Sex", "Hair", "Eyes", "Background"].map((label) => <span key={label} className="truncate font-sans text-[11px] text-[#6d685e]"><span className="font-mono text-[9px] uppercase text-[#969084]">{label}: </span>{getTrait(record, label)}</span>)}
                        </div>
                        <a href={inscriptionUrl(record.id)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="mt-3 inline-flex items-center gap-1.5 bg-[#c8663d] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[#fffaf2] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-[#aa4f2f] active:scale-[0.97]">View inscription <ExternalLink size={11} /></a>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="mt-12"><Pagination page={page} pageCount={pageCount} onChange={changePage} /></div>
              </>
            )}
          </section>

          <footer className="relative overflow-hidden border-t border-[#d8d0c2] px-5 py-10 sm:px-8 lg:px-12" style={{ backgroundImage: `url(${PAPER_URL})`, backgroundSize: "640px" }}>
            <div className="absolute inset-0 bg-[#f1ede3]/75" />
            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div><p className="flex items-baseline gap-2 font-display tracking-[-0.04em]"><span className="text-lg font-semibold">Ordinal Punks</span><span className="text-[#c8663d]">/</span><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6d685e]">Ledger</span></p><p className="mt-2 max-w-md font-sans text-xs leading-5 text-[#6d685e]">An independent visual index built from the supplied inscription metadata. Verify every record at the source.</p></div>
              <a className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#26241f] underline decoration-[#c8663d] underline-offset-4" href="https://fractal.unisat.io/market/collection?collectionId=opunk" target="_blank" rel="noreferrer">Open collection on UniSat <ArrowUpRight size={13} /></a>
            </div>
          </footer>
        </main>
      </div>
      {selected && <DetailPanel record={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
