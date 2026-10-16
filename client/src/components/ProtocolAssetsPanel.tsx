import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Brc20TransferFlow } from "@/components/Brc20TransferFlow";
import { fetchProtocolBalances, type ProtocolBalances, type ProtocolNetwork } from "@/lib/protocol-balances";

type SiteName = "punks" | "pokedex";

export function ProtocolAssetsPanel({
  address,
  network,
  site = "pokedex",
}: {
  address: string;
  network: ProtocolNetwork;
  site?: SiteName;
}) {
  const [data, setData] = useState<ProtocolBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTicker, setSelectedTicker] = useState("");

  const load = (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    void fetchProtocolBalances(address, network, signal)
      .then(setData)
      .catch(cause => {
        if (!signal?.aborted) {
          setError(cause instanceof Error ? cause.message : "Données BRC-20 indisponibles.");
        }
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    setSelectedTicker("");
    setData(null);
    setError("");
    load(controller.signal);
    return () => controller.abort();
  }, [address, network]);

  const selected = data?.brc20.find(item => item.ticker === selectedTicker);
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  const balances = data?.brc20 ?? [];

  return (
    <section className="border-t border-[#2c323a] pt-4" aria-labelledby="protocol-assets-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">
            Protocol indexers
          </p>
          <h2 id="protocol-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">
            BRC-20 classique
          </h2>
          <p className="mt-1 font-mono text-[10px] text-[#7f8b99]">
            Soldes live · inscription de transfert avec montant · envoi vers l’adresse destinataire
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => load()}
            disabled={loading}
            className="inline-flex min-h-10 items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser
          </button>
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]"
          >
            UniSat <ExternalLink size={12} />
          </a>
        </div>
      </div>

      {error && (
        <p className="mt-3 border border-[#a45e54] p-3 font-mono text-[10px] text-[#e08b7d]" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3 border border-[#3b434d] bg-[#10151a] p-3">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase text-[#f2bd63]">Soldes BRC-20 live</p>
          <span className="font-mono text-[10px] text-[#718092]">{balances.length}</span>
        </div>
        {balances.length ? (
          <div className="mt-3 space-y-2">
            {balances.map(item => (
              <div
                key={item.ticker}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2c323a] pb-2 font-mono text-[10px]"
              >
                <button
                  type="button"
                  onClick={() => setSelectedTicker(item.ticker)}
                  className="min-h-9 text-left text-[#d9d3c6] underline decoration-[#d99a54] underline-offset-4"
                >
                  {item.ticker} · transférer
                </button>
                <span className="text-[#70c7a0]">
                  {item.overallBalance}
                  <span className="ml-2 text-[#718092]">({item.availableBalance} disponible)</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 font-mono text-[10px] text-[#718092]">
            {loading ? "Chargement des soldes live…" : "Aucun solde BRC-20 indexé."}
          </p>
        )}
      </div>

      {selected && (
        <Brc20TransferFlow
          key={selected.ticker}
          address={address}
          network={network}
          ticker={selected.ticker}
          amount={selected.availableBalance}
          site={site}
          onDone={load}
          kind="classic"
        />
      )}
      {data && (
        <p className="mt-2 font-mono text-[9px] text-[#718092]">
          BRC-20 synchronisé · {new Date(data.refreshedAt).toLocaleTimeString()}
        </p>
      )}
    </section>
  );
}
