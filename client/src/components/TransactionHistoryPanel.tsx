import { useCallback, useEffect, useState } from "react";
import { Activity, ExternalLink, RefreshCw } from "lucide-react";
import { LIVE_DATA_API_BASE } from "@/lib/live";

type Network = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
type Transaction = {
  txid: string;
  nIn: number;
  nOut: number;
  inSatoshi: number;
  outSatoshi: number;
  size: number;
  height: number;
  idx: number;
  blkid: string;
  confirmations: number;
  timestamp: number;
};
type HistoryResponse = { network: Network; address: string; start: number; total: number; detail: Transaction[]; refreshedAt: string };

const API_BASE = LIVE_DATA_API_BASE;
const PAGE_SIZE = 10;
function formatSats(value: number) {
  return `${value.toLocaleString("fr-FR")} sats`;
}
function explorerUrl(network: Network, txid: string) {
  const base = network === "BITCOIN_MAINNET" ? "https://mempool.space" : "https://mempool.fractalbitcoin.io";
  return `${base}/tx/${encodeURIComponent(txid)}`;
}

export function TransactionHistoryPanel({ address, network }: { address: string; network: Network }) {
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (offset: number, signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ address, chain: network, cursor: String(offset), size: String(PAGE_SIZE) });
    try {
      const response = await fetch(`${API_BASE}/api/transactions/history?${query}`, {
        headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit", signal,
      });
      const payload = await response.json().catch(() => ({})) as Partial<HistoryResponse> & { error?: string };
      if (!response.ok || payload.network !== network || payload.address !== address || payload.start !== offset || !Array.isArray(payload.detail) || !Number.isSafeInteger(payload.total)) {
        throw new Error(payload.error || "L’historique live est indisponible pour ce réseau.");
      }
      if (!signal?.aborted) {
        setDetail(payload.detail);
        setTotal(Number(payload.total));
        setRefreshedAt(typeof payload.refreshedAt === "string" ? payload.refreshedAt : new Date().toISOString());
      }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Impossible de charger l’historique live.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [address, network]);

  useEffect(() => {
    setCursor(0);
  }, [address, network]);

  useEffect(() => {
    const controller = new AbortController();
    void load(cursor, controller.signal);
    return () => controller.abort();
  }, [load, cursor]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(cursor), 30_000);
    return () => window.clearInterval(timer);
  }, [load, cursor]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(cursor / PAGE_SIZE) + 1;
  const networkLabel = network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin";

  return (
    <section className="mt-4 border border-[#3b434d] bg-[#10151a] p-3 sm:p-4" aria-labelledby="transaction-history-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[#d99a54]"><Activity size={12} /> Historique live · {networkLabel}</p>
          <h3 id="transaction-history-title" className="mt-1 font-display text-lg text-[#f3efe5]">Transactions du wallet</h3>
          <p className="mt-1 font-mono text-[9px] text-[#718092]">{total.toLocaleString("fr-FR")} transaction(s) indexée(s) · actualisation toutes les 30 s</p>
        </div>
        <button type="button" onClick={() => void load(cursor)} disabled={loading} className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] hover:border-[#d99a54] disabled:opacity-50"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser</button>
      </div>
      {error && <p className="mt-3 border border-[#a45e54]/70 p-3 font-mono text-[10px] text-[#e08b7d]" role="alert">{error}</p>}
      {detail.length > 0 ? <>
        <div className="mt-3 space-y-2 sm:hidden">{detail.map(tx => <article key={tx.txid} className="border border-[#2c323a] p-3 font-mono text-[9px]">
          <div className="flex items-start justify-between gap-2"><a href={explorerUrl(network, tx.txid)} target="_blank" rel="noreferrer" className="break-all text-[#f2bd63] underline">{tx.txid}</a><a href={explorerUrl(network, tx.txid)} target="_blank" rel="noreferrer" aria-label="Ouvrir dans l’explorateur" className="shrink-0 text-[#9ea7b3]"><ExternalLink size={12} /></a></div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[#9ea7b3]"><span>Statut</span><span className={tx.confirmations > 0 ? "text-[#70c7a0]" : "text-[#e0b45f]"}>{tx.confirmations > 0 ? `${tx.confirmations} confirmation(s)` : "En attente / non confirmé"}</span><span>Date</span><span>{tx.timestamp > 0 ? new Date(tx.timestamp * 1000).toLocaleString("fr-FR") : "—"}</span><span>Entrées / sorties</span><span>{tx.nIn} / {tx.nOut}</span><span>Bloc / index</span><span>{tx.height > 0 ? `${tx.height} / ${tx.idx >= 0 ? tx.idx : "—"}` : "—"}</span><span>Identifiant du bloc</span><span className="break-all">{tx.blkid || "—"}</span><span>Flux agrégés</span><span>{formatSats(tx.inSatoshi)} / {formatSats(tx.outSatoshi)}</span><span>Taille</span><span>{tx.size.toLocaleString("fr-FR")} octets</span></div>
        </article>)}</div>
        <div className="mt-3 hidden overflow-x-auto sm:block"><table className="w-full min-w-[760px] border-collapse text-left font-mono text-[9px]"><thead><tr className="border-b border-[#3b434d] uppercase text-[#718092]"><th className="px-2 py-3">Transaction</th><th className="px-2 py-3">Date</th><th className="px-2 py-3">Confirmations</th><th className="px-2 py-3">Entrées / sorties</th><th className="px-2 py-3">Bloc / index</th><th className="px-2 py-3">Identifiant du bloc</th><th className="px-2 py-3">Sats agrégés (in / out)</th><th className="px-2 py-3">Taille (octets)</th></tr></thead><tbody>{detail.map(tx => <tr key={tx.txid} className="border-b border-[#2c323a] text-[#d9d3c6]"><td className="px-2 py-3"><a href={explorerUrl(network, tx.txid)} target="_blank" rel="noreferrer" title={tx.txid} className="inline-flex max-w-[190px] items-center gap-1 text-[#f2bd63] underline"><span className="truncate">{tx.txid}</span><ExternalLink size={10} /></a></td><td className="px-2 py-3">{tx.timestamp > 0 ? new Date(tx.timestamp * 1000).toLocaleString("fr-FR") : "—"}</td><td className={`px-2 py-3 ${tx.confirmations > 0 ? "text-[#70c7a0]" : "text-[#e0b45f]"}`}>{tx.confirmations > 0 ? tx.confirmations : "En attente"}</td><td className="px-2 py-3">{tx.nIn} / {tx.nOut}</td><td className="px-2 py-3">{tx.height > 0 ? `${tx.height} / ${tx.idx >= 0 ? tx.idx : "—"}` : "—"}</td><td className="max-w-[180px] truncate px-2 py-3" title={tx.blkid}>{tx.blkid || "—"}</td><td className="px-2 py-3">{formatSats(tx.inSatoshi)} / {formatSats(tx.outSatoshi)}</td><td className="px-2 py-3">{tx.size.toLocaleString("fr-FR")}</td></tr>)}</tbody></table></div>
      </> : !error && <p className="mt-3 border border-[#2c323a] p-4 font-mono text-[10px] text-[#718092]">{loading ? "Chargement des transactions live…" : "Aucune transaction indexée pour cette adresse sur ce réseau."}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#2c323a] pt-3 font-mono text-[9px] text-[#718092]"><span>Page {page} / {pageCount}{refreshedAt ? ` · actualisé à ${new Date(refreshedAt).toLocaleTimeString("fr-FR")}` : ""}</span><div className="flex gap-2"><button type="button" onClick={() => setCursor(value => Math.max(0, value - PAGE_SIZE))} disabled={loading || cursor === 0} className="min-h-9 border border-[#3b434d] px-3 uppercase text-[#d9d3c6] disabled:opacity-40">Précédent</button><button type="button" onClick={() => setCursor(value => value + PAGE_SIZE)} disabled={loading || cursor + PAGE_SIZE >= total} className="min-h-9 border border-[#3b434d] px-3 uppercase text-[#d9d3c6] disabled:opacity-40">Suivant</button></div></div>
    </section>
  );
}
