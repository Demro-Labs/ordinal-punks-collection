/** Inscription Ledger: an editorial catalogue, always linked back to the UniSat source. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Filter,
  Heart,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { RarityBadge, LiveDataBlock } from "@/components/CollectionSignals";
const MarketPanel = lazy(() => import("@/components/MarketPanel").then(module => ({ default: module.MarketPanel })));
import { createRarityIndex } from "@/lib/rarity";
import { fetchLiveInscription, type LiveInscription } from "@/lib/live";
import {
  fetchAllLiveMarketListings,
  fetchLiveMarket,
  listingTokenId,
  type LiveMarket,
  type LiveMarketListing,
} from "@/lib/market";
import { COLLECTION_DATA_URL, INSCRIPTION_BASE_URL } from "@/lib/collection";

const PER_PAGE = 20;
const TOTAL_ITEMS = 10000;
const ASSET_BASE = import.meta.env.BASE_URL;
const HERO_URL = `${ASSET_BASE}assets/brand/ordinal-punks-hero.webp`;
const PAPER_URL = `${ASSET_BASE}assets/brand/ordinal-ledger-paper-texture.webp`;
const FRACTAL_ORDINALS_URL = `${ASSET_BASE}assets/brand/fractal-ordinals.jpeg`;
const MARK_URL = FRACTAL_ORDINALS_URL;
const STAMP_URL = FRACTAL_ORDINALS_URL;
const SOCIAL_ASSET_BASE = `${ASSET_BASE}assets/brand/social/`;
const PUNKS_IMAGE_BASE = `${ASSET_BASE}assets/ordinal-punks/images/`;

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
type FilterKey = "Sex" | "Skin Tone";

function getTrait(record: PunkRecord, label: string) {
  return (
    record.attributes.find(attribute => attribute.trait_type === label)
      ?.value ?? "—"
  );
}
function shortId(id: string) {
  return `${id.slice(0, 10)}…${id.slice(-8)}`;
}
function inscriptionUrl(id: string) {
  return `${INSCRIPTION_BASE_URL}${id}`;
}
function uniqueValues(records: PunkRecord[], key: FilterKey) {
  return Array.from(
    new Set(records.map(record => getTrait(record, key)).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
}
function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function SpriteImage({ record }: { record: PunkRecord }) {
  return (
    <div
      className="card-image relative aspect-square overflow-hidden bg-[#171b21]"
      aria-label={`${record.name}, image de la collection`}
      role="img"
    >
      <img
        src={`${PUNKS_IMAGE_BASE}${record.fileName}`}
        alt={`${record.name}, high-resolution artwork`}
        className="h-full w-full object-cover"
        loading="lazy"
      />
      <span className="absolute left-3 top-3 bg-[#0b0d10]/90 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#f3efe5]">
        #{record.tokenId}
      </span>
      <span className="absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center border border-[#d99a54]/70 bg-[#0b0d10]/90 text-[#d99a54] opacity-0 transition-all duration-200 group-hover:opacity-100">
        <ArrowUpRight size={14} strokeWidth={1.7} />
      </span>
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (next: number) => void;
}) {
  const pages = Array.from(new Set([1, page - 1, page, page + 1, pageCount]))
    .filter(value => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b);
  return (
    <nav
      className="flex min-w-0 items-center justify-between gap-1 border-t border-[#2c323a] pt-5 sm:gap-4"
      aria-label="Catalogue pagination"
    >
      <Button
        variant="ghost"
        className="h-10 rounded-none px-0 text-[#9ea7b3] hover:bg-transparent hover:text-[#f3efe5] disabled:opacity-35"
        aria-label="Previous page"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
      >
        <ChevronLeft size={16} />
        <span className="max-[359px]:sr-only">Previous</span>
      </Button>
      <div className="flex items-center gap-1">
        {pages.map((pageNumber, index) => {
          const previous = pages[index - 1];
          const gap = previous && pageNumber - previous > 1;
          return (
            <span key={pageNumber} className="flex items-center gap-1">
              {gap && (
                <span className="px-1 font-mono text-xs text-[#718092]">…</span>
              )}
              <button
                type="button"
                onClick={() => onChange(pageNumber)}
                aria-current={pageNumber === page ? "page" : undefined}
                className={`h-9 min-w-9 border px-2 font-mono text-xs transition-colors ${pageNumber === page ? "border-[#f3efe5] bg-[#f3efe5] text-[#0b0d10]" : "border-transparent text-[#9ea7b3] hover:border-[#bdb3a3] hover:text-[#f3efe5]"}`}
              >
                {String(pageNumber).padStart(2, "0")}
              </button>
            </span>
          );
        })}
      </div>
      <Button
        variant="ghost"
        className="h-10 rounded-none px-0 text-[#9ea7b3] hover:bg-transparent hover:text-[#f3efe5] disabled:opacity-35"
        aria-label="Next page"
        disabled={page === pageCount}
        onClick={() => onChange(page + 1)}
      >
        <span className="max-[359px]:sr-only">Next</span>{" "}
        <ChevronRight size={16} />
      </Button>
    </nav>
  );
}

function DetailPanel({
  record,
  onClose,
  rarity,
  live,
  liveLoading,
}: {
  record: PunkRecord;
  onClose: () => void;
  rarity: ReturnType<typeof createRarityIndex>;
  live: LiveInscription | null;
  liveLoading: boolean;
}) {
  const token = rarity.token(record);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#f3efe5]/55 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <section
        className="max-h-[min(760px,calc(100vh-2rem))] w-full max-w-5xl overflow-auto border border-[#3b434d] bg-[#12161b] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <div className="flex items-center justify-between border-b border-[#2c323a] px-5 py-4 sm:px-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#7f8b99]">
            Collection record / {record.fileName}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center text-[#9ea7b3] transition-colors hover:bg-[#202831] hover:text-[#f3efe5]"
            aria-label="Close record"
          >
            <X size={18} />
          </button>
        </div>
        <div className="grid gap-8 p-5 sm:p-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div className="relative overflow-hidden border border-[#2c323a] bg-[#171b21]">
            <SpriteImage record={record} />
            <div className="absolute inset-0 pointer-events-none border-[12px] border-[#12161b]/20" />
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-xs uppercase tracking-[0.2em] text-[#d99a54]">
              Ordinal Punk #{record.tokenId}
            </span>
            <h2
              id="detail-title"
              className="mt-3 font-display text-3xl font-semibold leading-tight text-[#f3efe5] sm:text-4xl"
            >
              {record.name}
            </h2>
            <div className="mt-4">
              <RarityBadge
                tier={token.tier}
                detail={`rank ${token.rank}/${token.total}`}
              />
            </div>
            <p className="mt-4 border-l-2 border-[#d99a54] pl-4 font-sans text-sm leading-6 text-[#9ea7b3]">
              {getTrait(record, "Description")}
            </p>
            <div className="mt-7 border-y border-[#2c323a] py-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#718092]">
                Inscription ID
              </p>
              <a
                className="mt-2 block break-all font-mono text-xs leading-5 text-[#d9d3c6] underline decoration-[#d99a54]/40 underline-offset-4 transition-colors hover:text-[#d99a54]"
                href={inscriptionUrl(record.id)}
                target="_blank"
                rel="noreferrer"
              >
                {record.id}
              </a>
            </div>
            <LiveDataBlock live={live} loading={liveLoading} />
            <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
              {record.attributes
                .filter(
                  attribute =>
                    !["Description", "File Name"].includes(attribute.trait_type)
                )
                .map(attribute => {
                  const rarityValue = rarity.trait(record, attribute);
                  return (
                    <div key={`${attribute.trait_type}-${attribute.value}`}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#718092]">
                        {attribute.trait_type}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="font-sans text-sm text-[#f3efe5]">
                          {attribute.value}
                        </span>
                        <RarityBadge
                          tier={rarityValue.tier}
                          detail={`${rarityValue.percentage.toFixed(1)}%`}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
            <a
              className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 bg-[#d99a54] px-5 font-mono text-xs uppercase tracking-[0.14em] text-[#0b0d10] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-[#c77e3b] active:scale-[0.97]"
              href={inscriptionUrl(record.id)}
              target="_blank"
              rel="noreferrer"
            >
              Open UniSat source <ExternalLink size={15} />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center border-y border-[#2c323a] bg-[#171b21]/50">
      <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-[0.16em] text-[#9ea7b3]">
        <Loader2 size={16} className="animate-spin text-[#d99a54]" /> Opening
        the ledger…
      </div>
    </div>
  );
}

function readUrlParam(key: string, fallback = "") {
  return new URLSearchParams(window.location.search).get(key) ?? fallback;
}

function readUrlPage() {
  const value = Number.parseInt(readUrlParam("page", "1"), 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export default function Home() {
  const [records, setRecords] = useState<PunkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState(() => readUrlParam("q"));
  const [sex, setSex] = useState(() => readUrlParam("sex", "all"));
  const [skinTone, setSkinTone] = useState(() => readUrlParam("skin", "all"));
  const [page, setPage] = useState(readUrlPage);
  const [selected, setSelected] = useState<PunkRecord | null>(null);
  const [liveData, setLiveData] = useState<Record<string, LiveInscription>>({});
  const [liveLoading, setLiveLoading] = useState(false);
  const [market, setMarket] = useState<LiveMarket | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState("");
  const [marketPage, setMarketPage] = useState(0);
  const [rarityFilter, setRarityFilter] = useState(() => readUrlParam("rarity", "all"));
  const [listingFilter, setListingFilter] = useState(() => readUrlParam("listing", "all"));
  const [listedTokenIds, setListedTokenIds] = useState<Set<string>>(new Set());
  const [allListings, setAllListings] = useState<LiveMarketListing[]>([]);
  const [allListingsLoaded, setAllListingsLoaded] = useState(false);
  const [allListingsLoading, setAllListingsLoading] = useState(false);
  const [allListingsError, setAllListingsError] = useState("");
  const galleryRef = useRef<HTMLElement>(null);
  const marketRef = useRef<HTMLDivElement>(null);
  const [marketReady, setMarketReady] = useState(false);
  const [snapshotDate, setSnapshotDate] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("catalog-favorites") || "[]"));
    } catch {
      return new Set();
    }
  });
  const toggleFavorite = (id: string) => setFavorites(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  useEffect(() => {
    const controller = new AbortController();
    fetch(COLLECTION_DATA_URL, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("Unable to load the ledger.");
        setSnapshotDate(response.headers.get("last-modified") || "");
        return response.json();
      })
      .then((data: PunkRecord[]) => setRecords(data))
      .catch((fetchError: Error) => {
        if (fetchError.name !== "AbortError") setError(fetchError.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);
  useEffect(() => {
    try { localStorage.setItem("catalog-favorites", JSON.stringify(Array.from(favorites))); } catch { /* storage may be unavailable */ }
  }, [favorites]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setMarketReady(true); observer.disconnect(); }
    }, { rootMargin: "480px" });
    if (marketRef.current) observer.observe(marketRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (sex !== "all") params.set("sex", sex);
    if (skinTone !== "all") params.set("skin", skinTone);
    if (rarityFilter !== "all") params.set("rarity", rarityFilter);
    if (listingFilter !== "all") params.set("listing", listingFilter);
    if (page > 1) params.set("page", String(page));
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }, [query, page, sex, skinTone, rarityFilter, listingFilter]);
  const rarity = useMemo(
    () =>
      createRarityIndex(records, [
        "tokenID",
        "Description",
        "File Name",
        "Trait Count",
      ]),
    [records]
  );
  useEffect(() => {
    const controller = new AbortController();
    setMarketLoading(true);
    fetchLiveMarket("opunk", marketPage * 20, 20, controller.signal)
      .then(setMarket)
      .catch((e: Error) => {
        if (e.name !== "AbortError")
          setMarketError("Live market data is temporarily unavailable.");
      })
      .finally(() => setMarketLoading(false));
    return () => controller.abort();
  }, [marketPage]);
  useEffect(() => {
    if (!market) return;
    const controller = new AbortController();
    const total = market.totalListings;
    setAllListings([]);
    setListedTokenIds(new Set());
    setAllListingsError("");
    setAllListingsLoading(total > 0);
    setAllListingsLoaded(total === 0);
    if (total === 0) return () => controller.abort();
    fetchAllLiveMarketListings("opunk", total, controller.signal)
      .then(items => {
        setAllListings(items);
        setListedTokenIds(
          new Set(
            items
              .map(item => listingTokenId(item.collectionItemName))
              .filter((id): id is string => Boolean(id))
          )
        );
        setAllListingsLoaded(true);
      })
      .catch((fetchError: Error) => {
        if (!controller.signal.aborted)
          setAllListingsError("Unable to sync all live UniSat listings.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setAllListingsLoading(false);
      });
    return () => controller.abort();
  }, [market?.totalListings]);
  useEffect(() => {
    if (!selected || liveData[selected.id]) return;
    const controller = new AbortController();
    setLiveLoading(true);
    fetchLiveInscription(selected.id, controller.signal)
      .then(data =>
        setLiveData(current => ({ ...current, [selected.id]: data }))
      )
      .catch(() => undefined)
      .finally(() => setLiveLoading(false));
    return () => controller.abort();
  }, [selected, liveData]);
  const sexValues = useMemo(() => uniqueValues(records, "Sex"), [records]);
  const skinToneValues = useMemo(
    () => uniqueValues(records, "Skin Tone"),
    [records]
  );
  const filteredRecords = useMemo(() => {
    const queryTokens = normalizeSearchText(query).split(" ").filter(Boolean);
    return records.filter(record => {
      const searchable = normalizeSearchText(
        [
          record.name,
          record.id,
          record.tokenId,
          ...record.attributes.flatMap(item => [item.trait_type, item.value]),
        ].join(" ")
      );
      const matchesQuery =
        queryTokens.length === 0 ||
        queryTokens.every(token => searchable.includes(token));
      return (
        matchesQuery &&
        (sex === "all" || getTrait(record, "Sex") === sex) &&
        (skinTone === "all" || getTrait(record, "Skin Tone") === skinTone) &&
        (rarityFilter === "all" ||
          rarity.token(record).tier === rarityFilter) &&
        (listingFilter === "all" ||
          (listingFilter === "listed"
            ? listedTokenIds.has(record.tokenId)
            : !listedTokenIds.has(record.tokenId)))
      );
    });
  }, [
    query,
    records,
    sex,
    skinTone,
    rarity,
    rarityFilter,
    listingFilter,
    listedTokenIds,
  ]);
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / PER_PAGE));
  const visibleRecords = filteredRecords.slice(
    (page - 1) * PER_PAGE,
    page * PER_PAGE
  );
  const firstVisible =
    filteredRecords.length === 0 ? 0 : (page - 1) * PER_PAGE + 1;
  const lastVisible = Math.min(page * PER_PAGE, filteredRecords.length);
  useEffect(
    () => setPage(1),
    [query, sex, skinTone, rarityFilter, listingFilter]
  );
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  const changePage = (nextPage: number) => {
    setPage(nextPage);
    galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const listingImage = (item: LiveMarketListing) => {
    const tokenId = item.collectionItemName?.match(/#(\d+)/)?.[1];
    const record = records.find(value => value.tokenId === tokenId);
    return record ? `${PUNKS_IMAGE_BASE}${record.fileName}` : null;
  };
  return (
    <div className="min-h-screen bg-[#0b0d10] text-[#f3efe5]">
      <header className="border-b border-[#2c323a] bg-[#0b0d10]/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 sm:px-8 lg:px-12">
          <a
            href="#top"
            className="group flex items-center gap-3"
            aria-label="Ordinal Punks Collection, back to top"
          >
            <img
              src={MARK_URL}
              alt="Fractal Ordinals logo"
              className="h-10 w-10 object-contain transition-transform duration-200 group-hover:rotate-3"
            />
            <span className="hidden items-baseline gap-2 font-display tracking-[-0.04em] sm:flex">
              <span className="text-lg font-semibold">Ordinal Punks</span>
              <span className="text-[#d99a54]">/</span>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9ea7b3]">
                Ledger
              </span>
            </span>
          </a>
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[#9ea7b3] sm:gap-8">
            <span className="hidden sm:inline">Fractal Bitcoin</span>
            <a
              className="inline-flex items-center gap-1.5 text-[#f3efe5] underline decoration-[#d99a54] underline-offset-4 transition-colors hover:text-[#d99a54]"
              href="https://fractal.unisat.io/market/collection?collectionId=opunk"
              target="_blank"
              rel="noreferrer"
            >
              Collection on UniSat <ArrowUpRight size={13} />
            </a>
          </div>
        </div>
      </header>
      <div
        id="top"
        className="mx-auto grid max-w-[1440px] lg:grid-cols-[220px_minmax(0,1fr)]"
      >
        <aside className="hidden border-r border-[#2c323a] lg:block">
          <div className="sticky top-0 flex min-h-[calc(100vh-73px)] flex-col justify-between p-8">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#718092]">
                Archive index
              </p>
              <div className="mt-8 space-y-7">
                <div>
                  <p className="font-mono text-3xl leading-none text-[#f3efe5]">
                    {TOTAL_ITEMS.toLocaleString()}
                  </p>
                  <p className="mt-2 font-sans text-xs text-[#9ea7b3]">
                    Ordinal Punks
                  </p>
                </div>
                <div className="h-px w-10 bg-[#d99a54]" />
                <div>
                  <p className="font-mono text-3xl leading-none text-[#f3efe5]">
                    {Math.ceil(TOTAL_ITEMS / PER_PAGE)}
                  </p>
                  <p className="mt-2 font-sans text-xs text-[#9ea7b3]">
                    plates of 20 pieces
                  </p>
                </div>
              </div>
              <div className="mt-12 border-t border-[#2c323a] pt-6">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#718092]">
                  Network
                </p>
                <p className="mt-2 font-sans text-sm text-[#d9d3c6]">
                  Fractal Bitcoin
                </p>
                <p className="mt-1 font-mono text-[10px] text-[#718092]">
                  Collection ID / opunk
                </p>
              </div>
            </div>
            <div>
              <img
                src={STAMP_URL}
                alt="Fractal Ordinals logo"
                className="mb-5 h-16 w-16 object-contain opacity-90"
              />
              <p className="font-mono text-[10px] leading-5 text-[#718092]">
                Every image is indexed with its original inscription ID and
                source link.
              </p>
            </div>
          </div>
        </aside>
        <main className="min-w-0">
          <section
            className="relative isolate overflow-hidden border-b border-[#2c323a] px-5 py-10 sm:px-8 sm:py-14 lg:px-12 lg:py-20"
            style={{
              backgroundImage: `url(${HERO_URL})`,
              backgroundPosition: "center right",
              backgroundSize: "cover",
            }}
          >
            <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(11,13,16,0.99)_0%,rgba(11,13,16,0.94)_42%,rgba(11,13,16,0.48)_100%)]" />
            <div className="max-w-3xl">
              <p className="mb-6 font-mono text-[10px] uppercase tracking-[0.24em] text-[#d99a54]">
                Field catalogue / 2026 edition
              </p>
              <h1 className="max-w-2xl font-display text-5xl font-semibold leading-[0.95] tracking-[-0.06em] text-[#f3efe5] sm:text-7xl lg:text-[6.4rem]">
                Ten thousand
                <br />
                <span className="text-[#d99a54]">inscriptions.</span>
              </h1>
              <p className="mt-7 max-w-lg font-sans text-base leading-7 text-[#b9c0c8] sm:text-lg">
                A living index of Ordinal Punks inscribed on Fractal Bitcoin.
                Explore each piece, read its traits, and return to its UniSat
                source.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[#9ea7b3]">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 bg-[#d99a54]" /> 10,000 unique
                  records
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 bg-[#f3efe5]" /> Fractal mainnet
                </span>
              </div>
            </div>
          </section>
          <div ref={marketRef} className="min-h-24">
            {marketReady ? (
              <Suspense fallback={<div className="flex min-h-24 items-center justify-center border-b border-[#2c323a] font-mono text-[10px] uppercase tracking-[0.14em] text-[#718092]">Preparing live market…</div>}>
                <MarketPanel
                  allListings={allListings}
                  allListingsLoaded={allListingsLoaded}
                  allListingsLoading={allListingsLoading}
                  allListingsError={allListingsError}
                  market={market}
                  loading={marketLoading}
                  error={marketError}
                  page={marketPage}
                  onPage={setMarketPage}
                  imageForListing={listingImage}
                />
              </Suspense>
            ) : (
              <div className="flex min-h-24 items-center justify-center border-b border-[#2c323a] font-mono text-[10px] uppercase tracking-[0.14em] text-[#718092]">Live market loads when you reach it</div>
            )}
          </div>
          <section
            className="border-y border-[#2c323a] bg-[#11161b] px-5 py-5 shadow-[inset_0_1px_0_rgba(243,239,229,0.04)] sm:px-8 lg:px-12"
            aria-label="Catalogue filters"
          >
            <div className="border border-[#3b434d] bg-[#12161b] p-3 shadow-[0_18px_40px_rgba(0,0,0,0.18)] sm:p-4">
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[minmax(0,1fr)_220px_220px_220px_220px]">
                <label className="relative block h-12 w-full min-w-0 flex-1 border border-[#3b434d] bg-[#12161b] transition-colors focus-within:ring-0 focus-within:border-[#3b434d] 2xl:max-w-none">
                  <span className="sr-only">Search for an ordinal</span>
                  <Search
                    size={16}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#718092]"
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Search by ID, name or trait"
                    aria-label="Search Ordinal Punks"
                    className="h-full rounded-none border-0 bg-transparent pl-10 pr-10 font-mono text-xs text-[#f3efe5] placeholder:text-[#718092] focus-visible:ring-0"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-[#718092] hover:text-[#f3efe5]"
                      aria-label="Clear search"
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
                <div className="contents">
                  <label className="flex h-12 min-w-0 w-full items-center gap-2 border border-[#3b434d] bg-[#12161b] px-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#718092]">
                      Sex
                    </span>
                    <select
                      value={sex}
                      onChange={event => setSex(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent pr-5 font-sans text-sm text-[#d9d3c6] outline-none focus:border-[#3b434d] focus:outline-none focus:ring-0"
                    >
                      <option value="all">All</option>
                      {sexValues.map(value => (
                        <option value={value} key={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex h-12 min-w-0 w-full items-center gap-2 border border-[#3b434d] bg-[#12161b] px-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#718092]">
                      Skin Tone
                    </span>
                    <select
                      value={skinTone}
                      onChange={event => setSkinTone(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent pr-5 font-sans text-sm text-[#d9d3c6] outline-none focus:border-[#3b434d] focus:outline-none focus:ring-0"
                    >
                      <option value="all">All</option>
                      {skinToneValues.map(value => (
                        <option value={value} key={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex h-12 min-w-0 w-full items-center gap-2 border border-[#3b434d] bg-[#12161b] px-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#718092]">
                      Rarity rank
                    </span>
                    <select
                      value={rarityFilter}
                      onChange={event => setRarityFilter(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent pr-5 font-sans text-sm text-[#d9d3c6] outline-none focus:border-[#3b434d] focus:outline-none focus:ring-0"
                    >
                      <option value="all">All</option>
                      <option value="Legendary">Legendary</option>
                      <option value="Epic">Epic</option>
                      <option value="Rare">Rare</option>
                      <option value="Uncommon">Uncommon</option>
                      <option value="Common">Common</option>
                    </select>
                  </label>
                  <label className="flex h-12 min-w-0 w-full items-center gap-2 border border-[#3b434d] bg-[#12161b] px-3">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#718092]">
                      Listing status
                    </span>
                    <select
                      value={listingFilter}
                      onChange={event => setListingFilter(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent pr-5 font-sans text-sm text-[#d9d3c6] outline-none focus:border-[#3b434d] focus:outline-none focus:ring-0"
                    >
                      <option value="all">All</option>
                      <option value="listed">Listed</option>
                      <option value="unlisted">Unlisted</option>
                    </select>
                  </label>
                </div>
              </div>
              <p className="flex items-center gap-2 border-t border-[#2c323a] pt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[#718092]">
                <Filter size={14} />{" "}
                {filteredRecords.length.toLocaleString("en-US")} results ·{" "}
                {allListingsLoading
                  ? "Syncing live UniSat listings…"
                  : allListingsError
                    ? "Live listing sync unavailable"
                    : `${listedTokenIds.size.toLocaleString()} live listed tokens`}
              </p>
              <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-[#5f6b78]">Snapshot data · {snapshotDate ? new Date(snapshotDate).toLocaleDateString() : "local asset"}</p>
            </div>
          </section>
          <section
            ref={galleryRef}
            className="ledger-sheet relative border-x border-[#2c323a]/70 bg-[#0d1115] px-5 py-8 shadow-[inset_0_1px_0_rgba(243,239,229,0.04)] sm:px-8 lg:px-12"
          >
            <div className="mb-8 grid gap-3 border-b border-[#2c323a] pb-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div>
                <p className="border-l-2 border-[#d99a54] pl-3 font-mono text-[10px] uppercase tracking-[0.2em] text-[#d99a54]">
                  Plate {String(page).padStart(3, "0")}
                </p>
                <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.04em] text-[#f3efe5] sm:text-3xl">
                  Collection index
                </h2>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 sm:justify-end">
                <span
                  aria-hidden="true"
                  className="pointer-events-none shrink-0 font-mono text-7xl font-semibold leading-none tracking-[-0.12em] text-[#3b434d]/80 sm:text-[8rem]"
                >
                  {String(page).padStart(3, "0")}
                </span>
                {!loading && !error && (
                  <p className="font-mono text-xs text-[#7f8b99]">
                    Showing {firstVisible.toLocaleString("en-US")}–
                    {lastVisible.toLocaleString("en-US")} /{" "}
                    {filteredRecords.length.toLocaleString("en-US")}
                  </p>
                )}
              </div>
            </div>
            <div className="mb-6 border-y border-[#2c323a] bg-[#11161b] px-3 py-3">
              <Pagination
                page={page}
                pageCount={pageCount}
                onChange={changePage}
              />
            </div>
            {loading ? (
              <LoadingState />
            ) : error ? (
              <div className="border border-[#d99a54]/40 bg-[#d99a54]/5 p-8 text-center font-sans text-sm text-[#c77e3b]">
                {error} Try again after reloading the page.
              </div>
            ) : visibleRecords.length === 0 ? (
              <div className="border border-[#2c323a] bg-[#14191f] p-12 text-center">
                <p className="font-display text-2xl text-[#f3efe5]">
                  No records found
                </p>
                <p className="mt-2 font-sans text-sm text-[#9ea7b3]">
                  Adjust your search or filters to reopen a plate.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 xl:grid-cols-5">
                  {visibleRecords.map(record => {
                    const token = rarity.token(record);
                    return (
                      <article
                        key={record.id}
                        className="group relative min-w-0 border border-[#3b434d] border-t-2 border-t-[#d99a54]/60 bg-[#12161b] p-3 shadow-[0_10px_24px_rgba(0,0,0,0.16)] transition-all hover:-translate-y-0.5 hover:border-[#d99a54]/70 animate-in fade-in slide-in-from-bottom-2 duration-500"
                      >
                        <button
                          type="button"
                          onClick={() => toggleFavorite(record.id)}
                          aria-pressed={favorites.has(record.id)}
                          aria-label={favorites.has(record.id) ? "Remove from favorites" : "Add to favorites"}
                          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center border border-[#3b434d] bg-[#0b0d10]/85 text-[#d99a54] backdrop-blur-sm transition-colors hover:border-[#d99a54]"
                        >
                          <Heart size={15} fill={favorites.has(record.id) ? "currentColor" : "none"} />
                        </button>
                        <button
                          type="button"
                          className="block w-full text-left"
                          onClick={() => setSelected(record)}
                          aria-label={`Open the record for ${record.name}`}
                        >
                          <SpriteImage record={record} />
                        </button>
                        <div className="pt-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#d99a54]">
                                Accession / {record.fileName}
                              </p>
                              <h3 className="mt-1 truncate font-display text-sm font-semibold text-[#f3efe5]">
                                {record.name}
                              </h3>
                              <a
                                className="mt-1 block truncate font-mono text-[10px] text-[#718092] underline decoration-[#d99a54]/35 underline-offset-3 transition-colors hover:text-[#d99a54]"
                                href={inscriptionUrl(record.id)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <span className="text-[#687584]">ID </span>
                                {shortId(record.id)}
                              </a>
                            </div>
                            <Badge
                              variant="outline"
                              className="shrink-0 rounded-none border-[#3b434d] px-1.5 py-0.5 font-mono text-[9px] font-normal text-[#7f8b99]"
                            >
                              {record.attributes.length} traits
                            </Badge>
                          </div>
                          <div className="mt-2">
                            <RarityBadge
                              tier={token.tier}
                              detail={`rank ${token.rank}`}
                            />
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-[#2c323a] pt-2.5">
                            {["Sex", "Hair", "Eyes", "Skin Tone"].map(label => (
                              <span
                                key={label}
                                className="truncate font-sans text-[11px] text-[#9ea7b3]"
                              >
                                <span className="font-mono text-[9px] uppercase text-[#718092]">
                                  {label}:{" "}
                                </span>
                                {getTrait(record, label)}
                              </span>
                            ))}
                          </div>
                          <a
                            href={inscriptionUrl(record.id)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={event => event.stopPropagation()}
                            className="mt-3 inline-flex items-center gap-1.5 bg-[#d99a54] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[#0b0d10] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-[#c77e3b] active:scale-[0.97]"
                          >
                            View inscription <ExternalLink size={11} />
                          </a>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="mt-12">
                  <Pagination
                    page={page}
                    pageCount={pageCount}
                    onChange={changePage}
                  />
                </div>
              </>
            )}
          </section>
          <footer
            className="relative overflow-hidden border-t border-[#2c323a] px-5 py-10 sm:px-8 lg:px-12"
            style={{
              backgroundImage: `url(${PAPER_URL})`,
              backgroundSize: "640px",
            }}
          >
            <div className="absolute inset-0 bg-[#0b0d10]/80" />
            <div className="relative space-y-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-md">
                  <p className="flex items-baseline gap-2 font-display tracking-[-0.04em]">
                    <span className="text-lg font-semibold">Ordinal Punks</span>
                    <span className="text-[#d99a54]">/</span>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9ea7b3]">
                      Ledger
                    </span>
                  </p>
                  <p className="mt-2 font-sans text-xs leading-5 text-[#9ea7b3]">
                    An independent visual index built from the supplied
                    inscription metadata. Verify every record at the source.
                  </p>
                </div>
                <div
                  className="flex flex-wrap items-center gap-3"
                  aria-label="Social links"
                >
                  {[
                    {
                      label: "X / Fractal Ordinals",
                      href: "https://x.com/fractal_ordinal",
                      src: `${SOCIAL_ASSET_BASE}x.svg`,
                    },
                    {
                      label: "Facebook / Demro Labs",
                      href: "https://www.facebook.com/demrolabs",
                      src: `${SOCIAL_ASSET_BASE}facebook.svg`,
                    },
                    {
                      label: "Epsilon / @fo@epsilon.social",
                      href: "https://epsilon.social/@fo",
                      src: `${SOCIAL_ASSET_BASE}epsilon.png`,
                    },
                    {
                      label: "Link.me / Demro",
                      href: "https://link.me/demro",
                      src: `${SOCIAL_ASSET_BASE}link-me.png`,
                    },
                  ].map(social => (
                    <a
                      key={social.label}
                      href={social.href}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={social.label}
                      title={social.label}
                      className="flex h-11 w-11 items-center justify-center border border-[#3b434d] bg-[#12161b]/80 transition-colors hover:border-[#d99a54] hover:bg-[#0b0d10]"
                    >
                      <img
                        src={social.src}
                        alt=""
                        className="h-6 w-6 object-contain"
                      />
                    </a>
                  ))}
                </div>
              </div>
              <section
                className="border-b border-[#2c323a] py-6"
                aria-labelledby="security-badges-title"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p
                      id="security-badges-title"
                      className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7f8b99]"
                    >
                      Security protocols
                    </p>
                    <p className="mt-1 font-sans text-xs text-[#9ea7b3]">
                      Protections verified on this site
                    </p>
                  </div>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-6 w-6 text-[#70c7a0]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z" />
                    <path d="m8.5 12 2.2 2.2 4.8-5" />
                  </svg>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: "Cloudflare Turnstile", detail: "Server-verified human check" },
                    { label: "HTTPS / TLS", detail: "Encrypted connection" },
                    { label: "CSP", detail: "Content Security Policy" },
                    { label: "HSTS", detail: "Strict Transport Security" },
                  ].map(protocol => (
                    <div
                      key={protocol.label}
                      className="flex min-h-14 items-center gap-3 border border-[#2c323a] bg-[#12161b]/70 px-3"
                      title={protocol.detail}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-5 w-5 shrink-0 text-[#70c7a0]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      >
                        <path d="M7 10V7a5 5 0 0 1 10 0v3" />
                        <rect x="5" y="10" width="14" height="11" rx="2" />
                        <path d="m10 15 1.4 1.4L14.5 13" />
                      </svg>
                      <span>
                        <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-[#d9d3c6]">
                          {protocol.label}
                        </span>
                        <span className="mt-0.5 block font-sans text-[10px] text-[#7f8b99]">
                          {protocol.detail}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
              <div className="border-y border-[#2c323a] py-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7f8b99]">
                    Powered by
                  </p>
                  <a
                    className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f3efe5] underline decoration-[#d99a54] underline-offset-4"
                    href="https://fractal.unisat.io/market/collection?collectionId=opunk"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open collection on UniSat <ArrowUpRight size={13} />
                  </a>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    {
                      label: "Fractal Ordinals",
                      href: "https://x.com/fractal_ordinal",
                      src: FRACTAL_ORDINALS_URL,
                    },
                    {
                      label: "UniSat",
                      href: "https://unisat.io",
                      src: `${SOCIAL_ASSET_BASE}unisat.png`,
                    },
                    {
                      label: "Fractal Bitcoin",
                      href: "https://fractalbitcoin.io",
                      src: `${SOCIAL_ASSET_BASE}fractal-bitcoin.png`,
                    },
                    {
                      label: "GitHub",
                      href: "https://github.com/Demro-Labs/ordinal-punks-collection",
                      src: `${SOCIAL_ASSET_BASE}github.svg`,
                    },
                  ].map(partner => (
                    <a
                      key={partner.label}
                      href={partner.href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-16 items-center gap-3 border border-[#2c323a] bg-[#12161b]/70 px-3 transition-colors hover:border-[#d99a54] hover:bg-[#0b0d10]"
                    >
                      <img
                        src={partner.src}
                        alt={`${partner.label} logo`}
                        className="h-10 w-10 rounded-full object-cover"
                      />
                      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#d9d3c6]">
                        {partner.label}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2 font-mono text-[10px] leading-5 text-[#718092] sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Copyright © 2026 Ordinal Punks Ledger. All rights reserved.
                </p>
                <p>Built for Fractal Bitcoin / Collection ID: opunk</p>
              </div>
            </div>
          </footer>
        </main>
      </div>
      {selected && (
        <DetailPanel
          record={selected}
          onClose={() => setSelected(null)}
          rarity={rarity}
          live={liveData[selected.id] ?? null}
          liveLoading={liveLoading}
        />
      )}
    </div>
  );
}
