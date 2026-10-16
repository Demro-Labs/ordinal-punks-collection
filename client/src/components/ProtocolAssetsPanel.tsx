import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Send } from "lucide-react";
import { fetchProtocolBalances, type ProtocolBalances, type ProtocolNetwork } from "@/lib/protocol-balances";
import { Brc20TransferFlow } from "@/components/Brc20TransferFlow";

type Transferable = { inscriptionId: string; inscriptionNumber: number | null; amount: string; confirmations: number };
type Provider = { sendInscription?: (recipient: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<string | { txid?: string }> };

const API_BASE = (import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription").replace(/\/api\/live-inscription\/?$/, "");
async function json<T>(path: string): Promise<T> { const response = await fetch(`${API_BASE}${path}`, { cache: "no-store", headers: { Accept: "application/json" } }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload?.error || `API HTTP ${response.status}`); return payload as T; }

export function ProtocolAssetsPanel({ address, network, site = "pokedex" }: { address: string; network: ProtocolNetwork; site?: "punks" | "pokedex" }) {
  const [data, setData] = useState<ProtocolBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ticker, setTicker] = useState("");
  const [transferable, setTransferable] = useState<Transferable[]>([]);
  const [recipient, setRecipient] = useState("");
  const [feeRate, setFeeRate] = useState(1);
  const [selected, setSelected] = useState("");
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState("");
  const selectedBrc20 = data?.brc20.find(item => item.ticker === ticker);
  const load = () => { setLoading(true); setError(""); fetchProtocolBalances(address, network).then(setData).catch(cause => setError(cause instanceof Error ? cause.message : "Données protocole indisponibles.")).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [address, network]);
  const loadTransferable = async (nextTicker: string) => { setTicker(nextTicker); setSelected(""); setTransferMessage(""); if (!nextTicker) { setTransferable([]); return; } try { const result = await json<{ detail: Transferable[] }>(`/api/brc20/transferable?${new URLSearchParams({ address, ticker: nextTicker, chain: network })}`); setTransferable(result.detail || []); } catch (cause) { setTransferable([]); setTransferMessage(cause instanceof Error ? cause.message : "Inscriptions transférables indisponibles."); } };
  const wallet = (window as Window & { unisat?: Provider }).unisat;
  const sendBrc20 = async () => { const item = transferable.find(value => value.inscriptionId === selected); if (!item || !recipient.trim() || !transferConfirmed || !wallet?.sendInscription) return; setTransferBusy(true); setTransferMessage(""); try { const result = await wallet.sendInscription(recipient.trim(), item.inscriptionId, { feeRate: Math.max(1, Math.ceil(feeRate)) }); const txid = typeof result === "string" ? result : (result as { txid?: string })?.txid || "Transaction envoyée"; setTransferMessage(`BRC-20 ${item.amount || ticker} envoyé · TXID ${txid}`); setTransferConfirmed(false); setRecipient(""); } catch (cause) { setTransferMessage(cause instanceof Error ? cause.message : "Transfert refusé ou échoué dans UniSat."); } finally { setTransferBusy(false); } };
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  return <section className="border-t border-[#2c323a] pt-4" aria-labelledby="protocol-assets-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Protocol indexers</p><h2 id="protocol-assets-title" className="mt-1 font-display text-xl text-[#f3efe5]">BRC-20 &amp; Alkanes</h2><p className="mt-1 font-mono text-[10px] text-[#7f8b99]">Soldes et opérations indexés · signature finale dans UniSat</p></div><div className="flex gap-2"><button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser</button><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63]">Vérifier UniSat <ExternalLink size={12} /></a></div></div>
    {error && <p className="mt-3 border border-[#a45e54] p-3 font-mono text-[10px] text-[#e08b7d]">{error}</p>}
    <div className="mt-3 grid gap-3 md:grid-cols-2"><div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">Classic BRC-20</p><span className="font-mono text-[10px] text-[#718092]">{data?.brc20.length ?? 0}</span></div>{data?.brc20.length ? <div className="mt-3 space-y-2">{data.brc20.map(item => <div key={item.ticker} className="flex items-center justify-between border-b border-[#2c323a] pb-2 font-mono text-[10px]"><button type="button" onClick={() => void loadTransferable(item.ticker)} className="text-[#d9d3c6] underline decoration-[#d99a54] underline-offset-4">{item.ticker}</button><span className="text-[#70c7a0]">{item.overallBalance}<span className="ml-2 text-[#718092]">({item.transferableBalance} transf.)</span></span></div>)}</div> : <p className="mt-3 font-mono text-[10px] text-[#718092]">Aucun solde indexé.</p>}</div><div className="border border-[#3b434d] bg-[#10151a] p-3"><div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase text-[#f2bd63]">Alkanes / collections</p><span className="font-mono text-[10px] text-[#718092]">{data?.alkanes.length ?? 0}</span></div>{data?.alkanes.length ? <div className="mt-3 space-y-2">{data.alkanes.map(item => <div key={`${item.alkaneid}-${item.type}`} className="flex items-center justify-between border-b border-[#2c323a] pb-2 font-mono text-[10px]"><span className="text-[#d9d3c6]">{item.symbol || item.name || item.alkaneid}<span className="ml-2 text-[#718092]">{item.type}</span></span><span className="text-[#70c7a0]">{item.amount}</span></div>)}</div> : <p className="mt-3 font-mono text-[10px] text-[#718092]">Aucun Alkane indexé.</p>}</div></div>
    {ticker && selectedBrc20 && <Brc20TransferFlow address={address} network={network} ticker={ticker} amount={selectedBrc20.availableBalance || selectedBrc20.overallBalance} site={site} onDone={load} />}
    {data && <p className="mt-2 font-mono text-[9px] text-[#718092]">Synchronisé {new Date(data.refreshedAt).toLocaleTimeString()} · les opérations Alkanes et collections restent soumises aux méthodes officiellement exposées par UniSat.</p>}
  </section>;
}
