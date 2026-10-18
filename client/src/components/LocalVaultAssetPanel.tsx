import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw, Send } from "lucide-react";
import { UniSatRunesSendPanel } from "@/components/UniSatRunesSendPanel";
import { fetchAddressOrdinals, type AddressOrdinal, type OrdinalNetwork } from "@/lib/ordinals";

type SiteName = "punks" | "pokedex";

function requestEventName(site: SiteName) {
  return site === "punks" ? "ordinal-punks:request-transfer" : "pokedex:request-transfer";
}

export function LocalVaultAssetPanel({
  address,
  network,
  site,
}: {
  address: string;
  network: OrdinalNetwork;
  site: SiteName;
}) {
  const [items, setItems] = useState<AddressOrdinal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchAddressOrdinals(address, network);
      setItems(result.detail);
      if (selected && !result.detail.some(item => item.inscriptionId === selected)) setSelected("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Live Ordinals data is unavailable.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setSelected("");
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [address, network]);

  const selectedItem = useMemo(() => items.find(item => item.inscriptionId === selected) ?? null, [items, selected]);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";

  function transfer(item: AddressOrdinal) {
    setSelected(item.inscriptionId);
    window.dispatchEvent(new CustomEvent(requestEventName(site), { detail: { inscriptionId: item.inscriptionId } }));
  }

  return <section className="mt-4 border border-[#70c7a0]/35 bg-[#101a16] p-3 sm:p-4" aria-labelledby="local-vault-assets-title">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-[#9fe0bd]">Local Vault asset bridge</p><h2 id="local-vault-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">Live Ordinals &amp; Runes</h2><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">{network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin"} · address-scoped · refresh every 60s</p></div>
      <div className="flex gap-2"><button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#9fe0bd] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh</button><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6]">UniSat <ExternalLink size={12} /></a></div>
    </div>
    {error && <p className="mt-3 break-words border border-[#a45e54]/50 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
    <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr]">
      <article className="min-w-0 border border-[#2c323a] bg-[#0b0f13] p-3"><div className="flex items-center justify-between"><h3 className="font-mono text-[10px] uppercase text-[#f2bd63]">Ordinals / inscriptions</h3><span className="font-mono text-[9px] text-[#718092]">{items.length}</span></div>{!loading && !error && items.length === 0 && <p className="mt-2 font-mono text-[10px] text-[#718092]">No indexed inscriptions for this vault address.</p>}{items.length > 0 && <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">{items.map(item => <div key={item.inscriptionId} className={`border p-2 ${selected === item.inscriptionId ? "border-[#f2bd63]" : "border-[#2c323a]"}`}><p className="break-all font-mono text-[9px] text-[#d9d3c6]">{item.inscriptionNumber != null ? `#${item.inscriptionNumber} · ` : ""}{item.inscriptionId}</p><p className="mt-1 break-all font-mono text-[9px] text-[#718092]">{item.location ?? "Location unavailable"}</p><button type="button" onClick={() => transfer(item)} className="mt-2 inline-flex min-h-9 items-center gap-1 border border-[#d99a54] px-2 font-mono text-[9px] uppercase text-[#f2bd63]"><Send size={11} /> Transfer via verified UniSat flow</button></div>)}</div>}</article>
      <article className="min-w-0 border border-[#2c323a] bg-[#0b0f13] p-3"><h3 className="font-mono text-[10px] uppercase text-[#d7a9ff]">Runes transfer · BTC / FB</h3><p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Le solde live et l’approbation utilisent le flux UniSat existant. Le transfert est bloqué si le compte UniSat actif ne correspond pas exactement à l’adresse du Local Vault.</p><UniSatRunesSendPanel site={site} address={address} chain={{ enum: network }} onWalletRefresh={() => void load()} /></article>
    </div>
    {selectedItem && <p className="mt-3 font-mono text-[9px] text-[#9fe0bd]">Inscription sélectionnée : {selectedItem.inscriptionId}. Ouvrez la section UniSat de la page pour finaliser la revue et l’approbation.</p>}
  </section>;
}
