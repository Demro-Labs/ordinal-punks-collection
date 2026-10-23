import { useState } from "react";
import { Loader2, Radar, Send } from "lucide-react";
import { validateMempoolAddress } from "@/lib/mempool";
import type { OrdiNetwork } from "@/lib/ordi-wallet";

type Item = { inscriptionId: string; amount: string };
const API = (import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription").replace(/\\/api\\/live-inscription\\/?$/, "");

export function LocalVaultBrc20InscriptionScanner({ address, network, ticker, recipient, disabled, onSelect }: {
  address: string; network: OrdiNetwork; ticker: string; recipient: string; disabled?: boolean;
  onSelect: (inscriptionId: string, recipient: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);

  async function scan() {
    const symbol = ticker.trim();
    if (!/^[a-z0-9]{1,32}$/i.test(symbol)) { setError("Sélectionnez un ticker BRC-20 valide avant le scan."); return; }
    setScanning(true); setError(""); setItems([]); setScanned(false);
    try {
      const found: Item[] = [];
      const pageSize = 50;
      let total: number | null = null;
      for (let start = 0; start < 10_000;) {
        const query = new URLSearchParams({ address, ticker: symbol, chain: network, start: String(start), limit: String(pageSize) });
        const response = await fetch(API + "/api/brc20/transferable?" + query, { cache: "no-store", headers: { Accept: "application/json" } });
        const payload = await response.json().catch(() => null) as { network?: string; address?: string; ticker?: string; start?: number; total?: number; detail?: Array<{ inscriptionId?: string; amount?: string }>; error?: string } | null;
        if (!response.ok || !payload || !Array.isArray(payload.detail)) throw new Error(payload?.error || "Le scanner BRC-20 n’a pas retourné une page valide.");
        if (payload.network !== network || payload.address?.toLowerCase() !== address.toLowerCase() || payload.ticker?.toLowerCase() !== symbol.toLowerCase() || payload.start !== start) throw new Error("Réponse du scanner incohérente avec le compte, le réseau, le ticker ou la page demandée.");
        if (!Number.isSafeInteger(payload.total) || (payload.total as number) < 0 || (total !== null && total !== payload.total)) throw new Error("Le total d’inscriptions transférables est incohérent; sélection bloquée.");
        total = payload.total as number;
        for (const item of payload.detail) {
          if (typeof item.inscriptionId !== "string" || !/^[a-f0-9]{64}i\\d+$/i.test(item.inscriptionId) || typeof item.amount !== "string" || !/^(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(item.amount) || !/[1-9]/.test(item.amount)) throw new Error("Une inscription transférable contient des données invalides; le résultat complet n’est pas fiable.");
          found.push({ inscriptionId: item.inscriptionId, amount: item.amount });
        }
        if (found.length >= total || payload.detail.length === 0) break;
        start += payload.detail.length;
        if (start >= 10_000 && found.length < total) throw new Error("La limite de sécurité du scan a été atteinte avant la fin de la liste. Aucun résultat partiel n’est proposé.");
      }
      if (total === null || found.length !== total) throw new Error("Le scan n’a pas confirmé la liste complète des inscriptions transférables.");
      setItems(found); setScanned(true);
      if (!found.length) setError("Aucune inscription TRANSFER disponible pour ce ticker sur ce compte et ce réseau.");
    } catch (cause) {
      setItems([]); setScanned(false);
      setError(cause instanceof Error ? cause.message : "Échec du scan BRC-20.");
    } finally { setScanning(false); }
  }

  async function select(item: Item) {
    try {
      if (!recipient.trim()) throw new Error("Saisissez d’abord l’adresse destinataire.");
      await validateMempoolAddress(network, recipient.trim());
      onSelect(item.inscriptionId, recipient.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Adresse destinataire invalide."); }
  }

  return <div className="mt-3 border border-[#70c7a0]/35 bg-[#0b0f13] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h4 className="font-mono text-[10px] uppercase tracking-[.12em] text-[#9fe0bd]">Scanner des inscriptions BRC-20</h4><p className="mt-1 font-mono text-[9px] text-[#9ea7b3]">Ticker {ticker || "—"} · {network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}</p></div>
      <button type="button" onClick={() => void scan()} disabled={scanning || disabled || !ticker.trim()} className="inline-flex min-h-10 items-center gap-2 border border-[#70c7a0]/50 px-3 font-mono text-[9px] uppercase text-[#9fe0bd] disabled:opacity-40">{scanning ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} Scanner les TRANSFER</button>
    </div>
    {scanned && <p className="mt-2 font-mono text-[9px] text-[#70c7a0]">{items.length} inscription(s) transférable(s) vérifiée(s).</p>}
    {items.length > 0 && <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">{items.map(item => <div key={item.inscriptionId} className="border border-[#2c323a] p-2">
      <p className="font-mono text-[10px] text-[#f2bd63]">{item.amount} {ticker}</p><p className="break-all font-mono text-[9px] text-[#9ea7b3]">{item.inscriptionId}</p>
      <button type="button" onClick={() => void select(item)} disabled={scanning || disabled} className="mt-2 inline-flex min-h-9 items-center gap-2 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40"><Send size={11} /> Sélectionner pour transfert</button>
    </div>)}</div>}
    {error && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]" role="alert">{error}</p>}
  </div>;
}
