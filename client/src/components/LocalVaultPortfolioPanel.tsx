import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { ADDRESS_SPECS, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";
import { fetchAddressOrdinals } from "@/lib/ordinals";
import { fetchAlkaneCollectionPage, fetchProtocolBalances, type ProtocolBalances } from "@/lib/protocol-balances";
import { formatRuneAmount } from "@/lib/runes";

type AddressMap = OrdiWalletRecord["addresses"];
type MempoolTx = {
  txid: string;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
  vin?: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
  vout?: Array<{ scriptpubkey_address?: string; value?: number }>;
};
type PortfolioRow = {
  type: AddressType;
  address: string;
  protocols: ProtocolBalances | null;
  inscriptions: number | null;
  alkaneCollections: { total: number; names: string[] } | null;
  activity: MempoolTx[];
  errors: string[];
};

const endpoint = (network: OrdiNetwork) => network === "BITCOIN_MAINNET" ? "https://mempool.space" : "https://mempool.fractalbitcoin.io";
const short = (value: string) => `${value.slice(0, 12)}…${value.slice(-10)}`;
const assetName = (network: OrdiNetwork) => network === "BITCOIN_MAINNET" ? "BTC" : "FB";

async function fetchActivity(address: string, network: OrdiNetwork, signal: AbortSignal): Promise<MempoolTx[]> {
  const response = await fetch(`${endpoint(network)}/api/address/${encodeURIComponent(address)}/txs`, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Activity endpoint HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!Array.isArray(result)) throw new Error("Invalid recent activity response.");
  return result.filter((item): item is MempoolTx => Boolean(item && typeof item === "object" && typeof (item as MempoolTx).txid === "string" && /^[a-f0-9]{64}$/i.test((item as MempoolTx).txid))).slice(0, 4);
}

function formatProtocolBalances(data: ProtocolBalances | null, field: "brc20" | "brc20Prog") {
  if (!data) return "Index unavailable";
  if (field === "brc20Prog" && data.errors["BRC20-Prog"]) return "Index unavailable";
  const rows = data[field];
  return rows.length ? rows.map(item => `${item.ticker} ${item.overallBalance} (${item.availableBalance} available)`).join(" · ") : "None indexed";
}

function formatRunes(data: ProtocolBalances | null) {
  if (!data) return "Index unavailable";
  return data.runes.length ? data.runes.map(item => `${item.spacedRune} ${formatRuneAmount(item.amount, item.divisibility)}`).join(" · ") : data.errors.Runes ? "Index unavailable" : "None indexed";
}

function formatAlkanes(data: ProtocolBalances | null) {
  if (!data) return "Index unavailable";
  return data.alkanes.length ? data.alkanes.map(item => `${item.name || item.symbol || item.alkaneid} ${formatRuneAmount(item.amount, item.divisibility ?? 0)}`).join(" · ") : data.errors.Alkanes ? "Index unavailable" : "None indexed";
}

export function LocalVaultPortfolioPanel({ addresses, network }: { addresses: AddressMap; network: OrdiNetwork }) {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await Promise.all(ADDRESS_SPECS.map(async spec => {
        const address = addresses[spec.type].address;
        const [protocolResult, ordinalResult, activityResult, collectionResult] = await Promise.allSettled([
          fetchProtocolBalances(address, network, controller.signal),
          fetchAddressOrdinals(address, network, controller.signal),
          fetchActivity(address, network, controller.signal),
          network === "BITCOIN_MAINNET" ? fetchAlkaneCollectionPage(address, network, 0, controller.signal) : Promise.resolve(null),
        ]);
        const errors: string[] = [];
        const protocols = protocolResult.status === "fulfilled" ? protocolResult.value : null;
        const inscriptions = ordinalResult.status === "fulfilled" ? ordinalResult.value.total : null;
        const activity = activityResult.status === "fulfilled" ? activityResult.value : [];
        const alkaneCollections = collectionResult.status === "fulfilled" && collectionResult.value
          ? { total: collectionResult.value.total, names: collectionResult.value.detail.map(item => item.name).slice(0, 4) }
          : null;
        if (protocolResult.status === "rejected" && !controller.signal.aborted) errors.push("Protocol balances unavailable");
        if (ordinalResult.status === "rejected" && !controller.signal.aborted) errors.push("Ordinal index unavailable");
        if (activityResult.status === "rejected" && !controller.signal.aborted) errors.push("Recent activity unavailable");
        if (collectionResult.status === "rejected" && !controller.signal.aborted && network === "BITCOIN_MAINNET") errors.push("Alkane collection index unavailable");
        return { type: spec.type, address, protocols, inscriptions, alkaneCollections, activity, errors } satisfies PortfolioRow;
      }));
      if (!controller.signal.aborted) {
        setRows(next);
        setUpdatedAt(new Date().toISOString());
        if (next.every(row => row.errors.length > 0)) setError("Live sources are unavailable. Missing data is not reported as a zero balance.");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to refresh the portfolio.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [addresses, network]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.clearInterval(timer);
      activeRequest.current?.abort();
    };
  }, [refresh]);

  return <section className="mt-4 border border-[#70c7a0]/40 bg-[#0e1513] p-3 sm:p-4" aria-labelledby="local-vault-portfolio-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#70c7a0]">Ordi Wallet · four local accounts</p><h3 id="local-vault-portfolio-title" className="mt-1 font-display text-lg text-[#f3efe5]">Live protocol portfolio</h3><p className="mt-1 font-mono text-[9px] leading-4 text-[#718092]">{network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"} · read-only indexer and Mempool data · refreshed every 60 seconds</p></div>
      <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-11 shrink-0 items-center gap-2 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6] hover:border-[#70c7a0] disabled:opacity-50" aria-label="Refresh all Ordi Wallet account data"><RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Refresh all</button>
    </div>
    <p className="mt-2 font-mono text-[9px] leading-4 text-[#9ea7b3]">Local signing is enabled only for the separately reviewed BTC/FB and single-Ordinal paths. BRC-20, BRC20-Prog, Runes and Alkanes are indexed here but are not signed by this portfolio panel.</p>
    {error && <p className="mt-3 border border-[#e0b45f]/40 p-2 font-mono text-[9px] text-[#e0b45f]" role="status">{error}</p>}
    <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {ADDRESS_SPECS.map(spec => {
        const row = rows.find(item => item.type === spec.type);
        const address = addresses[spec.type].address;
        const explorer = endpoint(network);
        const protocols = row?.protocols ?? null;
        return <article key={spec.type} className="min-w-0 border border-[#2c323a] bg-[#10151a] p-3">
          <div className="flex items-center justify-between gap-2"><h4 className="font-mono text-[9px] uppercase tracking-[.1em] text-[#f2bd63]">{spec.label}</h4><span className="font-mono text-[8px] text-[#718092]">{row ? "LIVE" : "…"}</span></div>
          <a href={`${explorer}/address/${encodeURIComponent(address)}`} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-[8px] leading-4 text-[#718092] hover:text-[#f2bd63]">{short(address)} <ExternalLink size={9} className="inline" /></a>
          <div className="mt-3 space-y-2 font-mono text-[9px] leading-4">
            <p className="text-[#d9d3c6]">Ordinals / inscriptions: <span className="text-[#70c7a0]">{row?.inscriptions ?? "—"}</span></p>
            <p className="break-words text-[#d9d3c6]">BRC-20: <span className="text-[#9ea7b3]">{formatProtocolBalances(protocols, "brc20")}</span></p>
            <p className="break-words text-[#d9d3c6]">BRC20-Prog: <span className="text-[#9ea7b3]">{formatProtocolBalances(protocols, "brc20Prog")}</span></p>
            <p className="break-words text-[#d9d3c6]">Runes: <span className="text-[#9ea7b3]">{formatRunes(protocols)}</span></p>
            <p className="break-words text-[#d9d3c6]">Alkanes: <span className="text-[#9ea7b3]">{formatAlkanes(protocols)}</span></p>
            {network === "BITCOIN_MAINNET" && <p className="break-words text-[#d9d3c6]">Alkane collections: <span className="text-[#9ea7b3]">{row?.alkaneCollections ? `${row.alkaneCollections.total}${row.alkaneCollections.names.length ? ` · ${row.alkaneCollections.names.join(", ")}` : ""}` : "—"}</span></p>}
          </div>
          {protocols && Object.keys(protocols.errors).length > 0 && <p className="mt-2 break-words font-mono text-[8px] leading-4 text-[#e0b45f]">Unavailable: {Object.keys(protocols.errors).join(" · ")}</p>}
          {row?.errors.map(item => <p key={item} className="mt-1 break-words font-mono text-[8px] leading-4 text-[#e0b45f]">{item}</p>)}
          <div className="mt-3 border-t border-[#2c323a] pt-2">
            <p className="font-mono text-[8px] uppercase tracking-[.1em] text-[#718092]">Recent chain activity</p>
            {!row && <p className="mt-2 font-mono text-[9px] text-[#718092]">Loading…</p>}
            {row && row.activity.length === 0 && <p className="mt-2 font-mono text-[9px] text-[#718092]">{row.errors.includes("Recent activity unavailable") ? "Activity unavailable" : "No recent activity"}</p>}
            {row?.activity.map(tx => {
              const incoming = (tx.vout ?? []).reduce((sum, output) => output.scriptpubkey_address === address ? sum + (output.value ?? 0) : sum, 0);
              const outgoing = (tx.vin ?? []).reduce((sum, input) => input.prevout?.scriptpubkey_address === address ? sum + (input.prevout.value ?? 0) : sum, 0);
              const net = incoming - outgoing;
              const amount = `${net > 0 ? "+" : net < 0 ? "−" : ""}${(Math.abs(net) / 100_000_000).toFixed(8)} ${assetName(network)}`;
              return <div key={tx.txid} className="mt-2 flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[#d9d3c6]">{outgoing > 0 ? "Sent" : incoming > 0 ? "Received" : "Activity"} · {amount}</p><a href={`${explorer}/tx/${encodeURIComponent(tx.txid)}`} target="_blank" rel="noreferrer" className="break-all text-[#718092] hover:text-[#f2bd63]">{short(tx.txid)}</a></div><span className={`shrink-0 ${tx.status?.confirmed ? "text-[#70c7a0]" : "text-[#e0b45f]"}`}>{tx.status?.confirmed ? "Confirmed" : "Pending"}</span></div>;
            })}
          </div>
        </article>;
      })}
    </div>
    {updatedAt && <p className="mt-2 font-mono text-[8px] text-[#718092]">Last refreshed {new Date(updatedAt).toLocaleTimeString()}</p>}
  </section>;
}
