import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Brc20TransferFlow } from "@/components/Brc20TransferFlow";
import { fetchProtocolBalances, type ProtocolBalances, type ProtocolNetwork } from "@/lib/protocol-balances";

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
  return <p className="mt-2 font-mono text-[9px] text-[#718092]">{loading ? "Chargement live…" : children}</p>;
}

export function ProtocolAssetsPanel({ address, network, site = "pokedex" }: { address: string; network: ProtocolNetwork; site?: SiteName }) {
  const [data, setData] = useState<ProtocolBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTicker, setSelectedTicker] = useState("");

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    void fetchProtocolBalances(address, network, signal)
      .then(result => { if (!signal?.aborted) setData(result); })
      .catch(cause => { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Données live indisponibles."); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [address, network]);

  useEffect(() => {
    setSelectedTicker("");
    setData(null);
    const controller = new AbortController();
    load(controller.signal);
    const timer = window.setInterval(() => load(controller.signal), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [address, network, load]);

  const selected = data?.brc20.find(item => item.ticker === selectedTicker);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  const errors = Object.entries(data?.errors ?? {});
  const cards = [
    { title: "BRC-20 classique", count: data?.brc20.length ?? 0, color: "text-[#f2bd63]", body: data?.brc20.length ? <div className="mt-2 space-y-2">{data.brc20.map(item => <div key={item.ticker} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[9px]"><button type="button" onClick={() => setSelectedTicker(item.ticker)} className="min-h-9 text-left text-[#d9d3c6] underline decoration-[#d99a54] underline-offset-4">{item.ticker} · transférer</button><span className="text-[#70c7a0]">{item.overallBalance}<span className="ml-1 text-[#718092]">({item.availableBalance} dispo.)</span></span></div>)}</div> : <Empty loading={loading}>(vide)</Empty> },
    { title: "BRC20-Prog", count: data?.brc20Prog.length ?? 0, color: "text-[#9cc6ff]", body: data?.brc20Prog.length ? <div className="mt-2 space-y-2">{data.brc20Prog.map(item => <div key={item.ticker} className="flex justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[9px]"><span className="text-[#d9d3c6]">{item.ticker}</span><span className="text-[#70c7a0]">{item.overallBalance}</span></div>)}</div> : <Empty loading={loading}>(vide)</Empty> },
    { title: "Runes", count: data?.runes.length ?? 0, color: "text-[#d7a9ff]", body: data?.runes.length ? <div className="mt-2 space-y-2">{data.runes.map(item => <div key={item.runeid} className="border-b border-[#2c323a] pb-2 font-mono text-[9px]"><div className="flex justify-between gap-2"><span className="text-[#d9d3c6]">{item.spacedRune} {item.symbol}</span><span className="text-[#70c7a0]">{formatUnits(item.amount, item.divisibility)}</span></div><span className="text-[#718092]">{item.runeid}</span></div>)}</div> : <Empty loading={loading}>(vide)</Empty> },
    { title: "Alkanes", count: data?.alkanes.length ?? 0, color: "text-[#e0b45f]", body: data?.alkanes.length ? <div className="mt-2 space-y-2">{data.alkanes.map(item => <div key={`${item.alkaneid}:${item.type}`} className="border-b border-[#2c323a] pb-2 font-mono text-[9px]"><div className="flex justify-between gap-2"><span className="truncate text-[#d9d3c6]">{item.name || item.symbol || item.alkaneid}</span><span className="text-[#70c7a0]">{formatUnits(item.amount, item.divisibility)}</span></div><span className="text-[#718092]">{item.alkaneid} · {item.type}</span></div>)}</div> : <Empty loading={loading}>(vide)</Empty> },
  ];

  return <section className="border-t border-[#2c323a] pt-4" aria-labelledby="protocol-assets-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Protocol indexers · {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin"}</p><h2 id="protocol-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">Soldes d’actifs live</h2><p className="mt-1 font-mono text-[10px] text-[#7f8b99]">BRC-20 · BRC20-Prog · Runes · Alkanes</p></div><div className="flex gap-2"><button type="button" onClick={() => load()} disabled={loading} className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser</button><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">UniSat <ExternalLink size={12} /></a></div></div>
    {error && <p className="mt-3 border border-[#a45e54] p-3 font-mono text-[10px] text-[#e08b7d]" role="alert">{error}</p>}
    {errors.length > 0 && <p className="mt-3 border border-[#e0b45f]/40 p-3 font-mono text-[9px] leading-5 text-[#e0b45f]" role="status">Certaines sources protocole sont momentanément indisponibles; les listes concernées ne sont pas présentées comme des soldes nuls. {errors.map(([name]) => name).join(" · ")}</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">{cards.map(card => <article key={card.title} className="min-w-0 border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between gap-2"><h3 className={`font-mono text-[10px] uppercase ${card.color}`}>{card.title}</h3><span className="font-mono text-[9px] text-[#718092]">{card.count}</span></div>{card.body}</article>)}</div>
    {selected && <Brc20TransferFlow key={selected.ticker} address={address} network={network} ticker={selected.ticker} amount={selected.availableBalance} site={site} onDone={load} kind="classic" />}
    <div className="mt-3 border border-[#3b434d]/80 p-3 font-mono text-[9px] leading-5 text-[#9ea7b3]"><strong className="text-[#e0b45f]">Transfert Alkanes :</strong> utilisez le portefeuille UniSat : Assets → choisissez l’Alkane → Transfer, sur le réseau actif. La passerelle DApp ne documente pas de méthode <code>sendAlkanes</code>; aucun transfert Alkanes n’est simulé ici. <a href="https://docs.unisat.io/products/unisat-wallet/how-to-deposit-withdraw-assets" target="_blank" rel="noreferrer" className="ml-1 text-[#f2bd63] underline">Guide officiel UniSat</a></div>
    {data && <p className="mt-2 font-mono text-[9px] text-[#718092]">Données synchronisées · {new Date(data.refreshedAt).toLocaleTimeString()}</p>}
  </section>;
}
