import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Brc20TransferFlow } from "@/components/Brc20TransferFlow";
import {
  fetchAlkaneCollectionPage,
  fetchProtocolBalances,
  type AlkaneCollection,
  type ProtocolBalances,
  type ProtocolNetwork,
} from "@/lib/protocol-balances";

type SiteName = "punks" | "pokedex";

function formatUnits(amount: string, divisibility: number | null) {
  const places = Math.max(0, Math.min(38, divisibility ?? 0));
  if (!places) return amount;
  const padded = amount.padStart(places + 1, "0");
  const whole = padded.slice(0, -places);
  const fraction = padded.slice(-places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function Empty({ loading, children }: { loading: boolean; children: string }) {
  return <p className="mt-2 font-mono text-[10px] text-[#718092]">{loading ? "Loading live data…" : children}</p>;
}

export function ProtocolAssetsPanel({ address, network, site = "pokedex" }: { address: string; network: ProtocolNetwork; site?: SiteName }) {
  const [data, setData] = useState<ProtocolBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTicker, setSelectedTicker] = useState("");
  const [alkaneCollections, setAlkaneCollections] = useState<AlkaneCollection[]>([]);
  const [alkaneCollectionTotal, setAlkaneCollectionTotal] = useState(0);
  const [alkaneCollectionError, setAlkaneCollectionError] = useState("");
  const [loadingAlkaneCollections, setLoadingAlkaneCollections] = useState(false);
  const collectionRequest = useRef<AbortController | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    void fetchProtocolBalances(address, network, signal)
      .then(result => { if (!signal?.aborted) setData(result); })
      .catch(cause => { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Live data is unavailable."); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [address, network]);

  const loadAlkaneCollections = useCallback(async (start: number, append: boolean) => {
    if (network !== "BITCOIN_MAINNET") return;
    collectionRequest.current?.abort();
    const controller = new AbortController();
    collectionRequest.current = controller;
    setLoadingAlkaneCollections(true);
    setAlkaneCollectionError("");
    if (!append) {
      setAlkaneCollections([]);
      setAlkaneCollectionTotal(0);
    }
    try {
      const page = await fetchAlkaneCollectionPage(address, network, start, controller.signal);
      if (!controller.signal.aborted) {
        setAlkaneCollections(current => append && current.length === start ? [...current, ...page.detail] : page.detail);
        setAlkaneCollectionTotal(page.total);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setAlkaneCollectionError(cause instanceof Error ? cause.message : "The Bitcoin Alkane collection indexer is unavailable.");
      }
    } finally {
      if (!controller.signal.aborted) setLoadingAlkaneCollections(false);
    }
  }, [address, network]);

  useEffect(() => {
    setSelectedTicker("");
    setData(null);
    setAlkaneCollections([]);
    setAlkaneCollectionTotal(0);
    setAlkaneCollectionError("");
    const controller = new AbortController();
    load(controller.signal);
    if (network === "BITCOIN_MAINNET") void loadAlkaneCollections(0, false);
    const timer = window.setInterval(() => load(controller.signal), 60_000);
    return () => {
      controller.abort();
      collectionRequest.current?.abort();
      window.clearInterval(timer);
    };
  }, [address, network, load, loadAlkaneCollections]);

  const selected = data?.brc20.find(item => item.ticker === selectedTicker);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  const errors = Object.entries(data?.errors ?? {});
  const cards = [
    { title: "Classic BRC-20", count: data?.brc20.length ?? 0, color: "text-[#f2bd63]", body: data?.brc20.length ? <div className="mt-2 space-y-2">{data.brc20.map(item => <div key={item.ticker} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[10px]"><button type="button" onClick={() => setSelectedTicker(item.ticker)} className="min-h-10 text-left text-[#d9d3c6] underline decoration-[#d99a54] underline-offset-4">{item.ticker} · transfer</button><span className="text-[#70c7a0]">{item.overallBalance}<span className="ml-1 text-[#718092]">({item.availableBalance} available)</span></span></div>)}</div> : <Empty loading={loading}>None</Empty> },
    { title: "BRC20-Prog", count: data?.brc20Prog.length ?? 0, color: "text-[#9cc6ff]", body: data?.brc20Prog.length ? <div className="mt-2 space-y-2">{data.brc20Prog.map(item => <div key={item.ticker} className="flex justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[10px]"><span className="text-[#d9d3c6]">{item.ticker}</span><span className="text-[#70c7a0]">{item.overallBalance}</span></div>)}</div> : <Empty loading={loading}>None</Empty> },
    { title: "Runes", count: data?.runes.length ?? 0, color: "text-[#d7a9ff]", body: data?.runes.length ? <div className="mt-2 space-y-2">{data.runes.map(item => <div key={item.runeid} className="border-b border-[#2c323a] pb-2 font-mono text-[10px]"><div className="flex justify-between gap-2"><span className="text-[#d9d3c6]">{item.spacedRune} {item.symbol}</span><span className="text-[#70c7a0]">{formatUnits(item.amount, item.divisibility)}</span></div><span className="text-[#718092]">{item.runeid}</span></div>)}</div> : <Empty loading={loading}>None</Empty> },
    { title: "Alkanes", count: data?.alkanes.length ?? 0, color: "text-[#e0b45f]", body: data?.alkanes.length ? <div className="mt-2 space-y-2">{data.alkanes.map(item => <div key={`${item.alkaneid}:${item.type}`} className="border-b border-[#2c323a] pb-2 font-mono text-[10px]"><div className="flex justify-between gap-2"><span className="truncate text-[#d9d3c6]">{item.name || item.symbol || item.alkaneid}</span><span className="text-[#70c7a0]">{formatUnits(item.amount, item.divisibility)}</span></div><span className="text-[#718092]">{item.alkaneid} · {item.type}</span></div>)}</div> : <Empty loading={loading}>None</Empty> },
  ];

  return <section className="border-t border-[#2c323a] pt-4" aria-labelledby="protocol-assets-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"><div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-[#d99a54]">Protocol indexers · {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin"}</p><h2 id="protocol-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">Live asset balances</h2><p className="mt-1 font-mono text-[10px] text-[#7f8b99]">BRC-20 · BRC20-Prog · Runes · Alkanes{network === "BITCOIN_MAINNET" ? " · Alkanes collections" : ""}</p></div><div className="grid grid-cols-2 gap-2 sm:flex"><button type="button" onClick={() => { load(); if (network === "BITCOIN_MAINNET") void loadAlkaneCollections(0, false); }} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh</button><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center justify-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">UniSat <ExternalLink size={12} /></a></div></div>
    {error && <p className="mt-3 break-words border border-[#a45e54] p-3 font-mono text-[10px] text-[#e08b7d]" role="alert">{error}</p>}
    {errors.length > 0 && <p className="mt-3 border border-[#e0b45f]/40 p-3 font-mono text-[10px] leading-5 text-[#e0b45f]" role="status">Some protocol sources are temporarily unavailable; affected lists are not shown as zero balances. {errors.map(([name]) => name).join(" · ")}</p>}
    <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">{cards.map(card => <article key={card.title} className="min-w-0 border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between gap-2"><h3 className={`font-mono text-[10px] uppercase ${card.color}`}>{card.title}</h3><span className="font-mono text-[9px] text-[#718092]">{card.count}</span></div>{card.body}</article>)}</div>
    {network === "BITCOIN_MAINNET" && <article className="mt-3 border border-[#3b434d] bg-[#10151a] p-3" aria-labelledby="alkane-collections-title">
      <div className="flex items-center justify-between gap-2"><h3 id="alkane-collections-title" className="font-mono text-[10px] uppercase text-[#e0b45f]">Alkanes collections · Bitcoin</h3><span className="font-mono text-[9px] text-[#718092]">{alkaneCollections.length}/{alkaneCollectionTotal}</span></div>
      {alkaneCollectionError && <p className="mt-2 break-words font-mono text-[10px] text-[#e08b7d]" role="alert">Collection data is unavailable; it is not being shown as a zero balance. {alkaneCollectionError}</p>}
      {!alkaneCollectionError && alkaneCollections.length === 0 && <Empty loading={loadingAlkaneCollections}>No collections indexed for this address.</Empty>}
      {alkaneCollections.length > 0 && <div className="mt-2 space-y-2">{alkaneCollections.map(item => <div key={item.alkaneid} className="flex flex-col gap-1 border-b border-[#2c323a] pb-2 font-mono text-[10px] sm:flex-row sm:items-center sm:justify-between"><span className="min-w-0 break-words text-[#d9d3c6]">{item.name}<span className="ml-2 text-[#718092]">{item.alkaneid}</span></span><span className="shrink-0 text-[#70c7a0]">{item.minted ?? "—"}/{item.totalSupply || "—"} minted</span></div>)}</div>}
      {!alkaneCollectionError && alkaneCollections.length < alkaneCollectionTotal && <button type="button" onClick={() => void loadAlkaneCollections(alkaneCollections.length, true)} disabled={loadingAlkaneCollections} className="mt-3 min-h-10 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40">{loadingAlkaneCollections ? "Loading…" : "Load more collections"}</button>}
    </article>}
    {selected && <Brc20TransferFlow key={selected.ticker} address={address} network={network} ticker={selected.ticker} amount={selected.availableBalance} site={site} onDone={load} kind="classic" />}
    <div className="mt-3 border border-[#3b434d]/80 p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]"><strong className="text-[#e0b45f]">Alkanes transfers:</strong> use UniSat Wallet: Assets → choose the Alkane → Transfer on the active network. The current Local Vault lists indexed assets and Bitcoin collections but does not build Alkanes transfer transactions; no Alkanes transfer is simulated here. <a href="https://docs.unisat.io/products/unisat-wallet/how-to-deposit-withdraw-assets" target="_blank" rel="noreferrer" className="ml-1 text-[#f2bd63] underline">Official UniSat guide</a></div>
    {data && <p className="mt-2 font-mono text-[9px] text-[#718092]">Synced · {new Date(data.refreshedAt).toLocaleTimeString("en-US")}</p>}
  </section>;
}
