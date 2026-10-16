import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { fetchProtocolBalances, type ProtocolBalances, type ProtocolNetwork } from "@/lib/protocol-balances";

export function ProtocolAssetsPanel({ address, network }: { address: string; network: ProtocolNetwork }) {
  const [data, setData] = useState<ProtocolBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = () => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetchProtocolBalances(address, network, controller.signal).then(setData).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Données protocole indisponibles.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  };
  useEffect(() => load(), [address, network]);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  return <section className="border-t border-[#2c323a] pt-4" aria-labelledby="protocol-assets-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Protocol indexers</p><h2 id="protocol-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">BRC-20 &amp; Alkanes</h2><p className="mt-1 font-mono text-[10px] text-[#7f8b99]">Soldes indexés en lecture seule · aucune signature automatique</p></div>
      <div className="flex gap-2"><button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser</button><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] hover:bg-[#d99a54]/10">Vérifier UniSat <ExternalLink size={12} /></a></div>
    </div>
    {error && <p className="mt-3 border border-[#a45e54] p-3 font-mono text-[10px] text-[#e08b7d]">{error}</p>}
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      <div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">Classic BRC-20</p><span className="font-mono text-[10px] text-[#718092]">{data?.brc20.length ?? 0}</span></div>{data?.brc20.length ? <div className="mt-3 space-y-2">{data.brc20.map(item => <div key={item.ticker} className="flex items-center justify-between border-b border-[#2c323a] pb-2 font-mono text-[10px]"><span className="text-[#d9d3c6]">{item.ticker}</span><span className="text-[#70c7a0]">{item.overallBalance}<span className="ml-2 text-[#718092]">({item.transferableBalance} transf.)</span></span></div>)}</div> : <p className="mt-3 font-mono text-[10px] text-[#718092]">Aucun solde indexé.</p>}</div>
      <div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">Alkanes / collections</p><span className="font-mono text-[10px] text-[#718092]">{data?.alkanes.length ?? 0}</span></div>{data?.alkanes.length ? <div className="mt-3 space-y-2">{data.alkanes.map(item => <div key={`${item.alkaneid}-${item.type}`} className="flex items-center justify-between border-b border-[#2c323a] pb-2 font-mono text-[10px]"><span className="text-[#d9d3c6]">{item.symbol || item.name || item.alkaneid}<span className="ml-2 text-[#718092]">{item.type}</span></span><span className="text-[#70c7a0]">{item.amount}</span></div>)}</div> : <p className="mt-3 font-mono text-[10px] text-[#718092]">Aucun Alkane indexé.</p>}</div>
    </div>
    {data && <p className="mt-2 font-mono text-[9px] text-[#718092]">Synchronisé {new Date(data.refreshedAt).toLocaleTimeString()} · les transferts nécessitent une transaction native UniSat et une approbation explicite.</p>}
  </section>;
}
