import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Brc20TransferFlow } from "@/components/Brc20TransferFlow";
import { Brc20ProgModulePanel } from "@/components/Brc20ProgModulePanel";
import { fetchBrc20ProgModuleStatus, fetchProtocolBalances, type ProtocolBalances, type ProtocolNetwork } from "@/lib/protocol-balances";

type SiteName = "punks" | "pokedex";
export function ProtocolAssetsPanel({ address, network, site = "pokedex" }: { address: string; network: ProtocolNetwork; site?: SiteName }) {
  const [data, setData] = useState<ProtocolBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [classicTicker, setClassicTicker] = useState("");
  const [progTicker, setProgTicker] = useState("");
  const [moduleStatus, setModuleStatus] = useState<string>("");
  const load = () => {
    setLoading(true);
    setError("");
    void fetchProtocolBalances(address, network)
      .then(setData)
      .catch(cause => setError(cause instanceof Error ? cause.message : "Données protocole indisponibles."))
      .finally(() => setLoading(false));
    if (network === "BITCOIN_MAINNET") {
      void fetchBrc20ProgModuleStatus()
        .then(status => setModuleStatus(`RPC EVM configuré · hauteur ${Number.parseInt(status.blockNumber ?? "0", 16).toLocaleString()} · vérifier que le point d’accès indexe bien BRC2.0 Bitcoin.`))
        .catch(() => setModuleStatus("RPC BRC2.0 non configuré ou indisponible."));
    } else setModuleStatus("BRC2.0 est disponible uniquement sur Bitcoin mainnet.");
  };
  useEffect(() => { setClassicTicker(""); setProgTicker(""); load(); }, [address, network]);
  const selectedClassic = data?.brc20.find(item => item.ticker === classicTicker);
  const selectedProg = data?.brc20Prog.find(item => item.ticker === progTicker);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  const assetRows = (items: NonNullable<ProtocolBalances>["brc20"], onSelect: (ticker: string) => void, label: string) => items.length ? (
    <div className="mt-3 space-y-2">{items.map(item => <div key={item.ticker} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[10px]">
      <button type="button" onClick={() => onSelect(item.ticker)} className="min-h-9 text-left text-[#d9d3c6] underline decoration-[#d99a54] underline-offset-4">{item.ticker} · transférer</button>
      <span className="text-[#70c7a0]">{item.overallBalance}<span className="ml-2 text-[#718092]">({item.availableBalance} dispo.)</span></span>
    </div>)}</div>
  ) : <p className="mt-3 font-mono text-[10px] text-[#718092]">Aucun solde {label} indexé.</p>;
  return <section className="border-t border-[#2c323a] pt-4" aria-labelledby="protocol-assets-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Protocol indexers</p>
        <h2 id="protocol-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">BRC‑20 · BRC20‑Prog · BRC2.0</h2>
        <p className="mt-1 font-mono text-[10px] text-[#7f8b99]">Soldes distincts · preuve BIP‑322 avant les transferts et l’inscription BRC‑20 · confirmation finale UniSat</p></div>
      <div className="flex gap-2"><button type="button" onClick={load} disabled={loading} className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser</button>
        <a href={explorer} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">UniSat <ExternalLink size={12} /></a></div>
    </div>
    {error && <p className="mt-3 border border-[#a45e54] p-3 font-mono text-[10px] text-[#e08b7d]" role="alert">{error}</p>}
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      <div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">BRC‑20 classique</p><span className="font-mono text-[10px] text-[#718092]">{data?.brc20.length ?? 0}</span></div>
        {assetRows(data?.brc20 ?? [], setClassicTicker, "BRC‑20")}</div>
      <div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">BRC20‑Prog · tickers 6 caractères</p><span className="font-mono text-[10px] text-[#718092]">{network === "BITCOIN_MAINNET" ? data?.brc20Prog.length ?? 0 : "Bitcoin only"}</span></div>
        {network === "BITCOIN_MAINNET" ? assetRows(data?.brc20Prog ?? [], setProgTicker, "BRC20‑Prog") : <p className="mt-3 font-mono text-[10px] leading-5 text-[#718092]">L’indexeur UniSat BRC20‑Prog est Bitcoin-only. Aucun appel de solde n’est envoyé sur Fractal.</p>}
        {data?.brc20ProgError && <p className="mt-2 font-mono text-[9px] text-[#e08b7d]" role="status">Indexeur BRC20‑Prog indisponible : {data.brc20ProgError}</p>}
      </div>
      <div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">Alkanes / collections</p><span className="font-mono text-[10px] text-[#718092]">{data?.alkanes.length ?? 0}</span></div>
        {data?.alkanes.length ? <div className="mt-3 space-y-2">{data.alkanes.map(item => <div key={`${item.alkaneid}-${item.type}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[10px]"><span className="text-[#d9d3c6]">{item.symbol || item.name || item.alkaneid}<span className="ml-2 text-[#718092]">{item.type}</span></span><span className="text-[#70c7a0]">{item.amount}</span></div>)}</div> : <p className="mt-3 font-mono text-[10px] text-[#718092]">Aucun Alkane indexé.</p>}
        <a href="https://unisat.io/utxo" target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-9 items-center gap-1 font-mono text-[9px] uppercase text-[#f2bd63]">Gérer les transferts Alkanes dans UniSat <ExternalLink size={11} /></a>
      </div>
      <div className="md:col-span-2"><div className="mb-2 border border-[#3b434d] bg-[#10151a] px-3 py-2 font-mono text-[9px] text-[#9ea7b3]" role="status">{moduleStatus || "Vérification de l’indexeur BRC2.0…"}</div><Brc20ProgModulePanel address={address} network={network} site={site} /></div>
    </div>
    {selectedClassic && <Brc20TransferFlow key={`classic-${selectedClassic.ticker}`} address={address} network={network} ticker={selectedClassic.ticker} amount={selectedClassic.availableBalance} site={site} onDone={load} kind="classic" />}
    {selectedProg && <Brc20TransferFlow key={`prog-${selectedProg.ticker}`} address={address} network={network} ticker={selectedProg.ticker} amount={selectedProg.availableBalance} site={site} onDone={load} kind="prog" />}
    {data && <p className="mt-2 font-mono text-[9px] text-[#718092]">Synchronisé {new Date(data.refreshedAt).toLocaleTimeString()} · BRC20‑Prog indexé uniquement sur Bitcoin mainnet.</p>}
  </section>;
}
