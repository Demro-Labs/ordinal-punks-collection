import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { OrdiNetwork } from "@/lib/ordi-wallet";
import { LIVE_DATA_API_BASE } from "@/lib/live";

type ActiveUtxo = {
  txid: string;
  vout: number;
  satoshi: number;
  height: number | null;
  scriptPk: string | null;
  inscriptions: string[] | null;
  runes: unknown[] | null;
  alkanes: unknown[] | null;
  isSpent: boolean | null;
};
type UtxoPage = { chain: string; address: string; cursor: number; nextCursor: number; total: number; scannedCount: number; utxo: ActiveUtxo[] };
const PAGE_SIZE = 25;
// Keep in sync with the Worker cursor validation for /api/address-utxos.
const MAX_UTXO_CURSOR = 1_000_000;
const MAX_UTXO_REQUESTS_PER_MINUTE = 120;
const UTXO_REQUEST_WINDOW_MS = 60_000;
const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`;
function explainUtxoFailure(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : "Impossible de récupérer les UTXO actifs.";
  const code = raw.match(/\[([A-Z0-9_]+)\]/)?.[1] ?? "";
  if (code.includes("UNISAT_KEY_MISSING")) return "Clé API UniSat Fractal absente côté serveur. Configurez le secret UNISAT_API_KEY dans le Worker, puis vérifiez son autorisation.";
  if (code.includes("UNISAT_BITCOIN_API_KEY_MISSING")) return "Clé API UniSat Bitcoin absente côté serveur. Configurez le secret UNISAT_BITCOIN_API dans le Worker; la clé Fractal ne remplace pas la clé Bitcoin.";
  if (code.includes("UNISAT_RATE_LIMITED")) return "UniSat a refusé la requête pour quota/limitation. Réduisez les rafraîchissements et vérifiez le quota et les droits de la clé; réessayez plus tard.";
  if (code.includes("UNISAT_HTTP_403")) return "UniSat a refusé l’accès (HTTP 403). Vérifiez la clé et ses droits pour ce réseau, l’accès à l’endpoint et les journaux du Worker (code upstream/request ID). Ne répétez pas les requêtes en boucle.";
  if (code.includes("UNISAT_HTTP_401")) return "UniSat refuse l’authentification (HTTP 401). Vérifiez la clé API et l’en-tête Authorization côté Worker.";
  if (code.includes("UNISAT_HTTP_429")) return "UniSat limite les requêtes (HTTP 429). Espacez les appels et réessayez après le délai indiqué.";
  if (code.includes("UPSTREAM_CONNECTION_OR_RESPONSE")) return "L’API UniSat est inaccessible ou a renvoyé une réponse invalide. Vérifiez l’état du service et les journaux du Worker.";
  return raw;
}

export function LocalVaultActiveUtxosPanel({ address, network }: { address: string; network: OrdiNetwork }) {
  const [items, setItems] = useState<ActiveUtxo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [sourceTotal, setSourceTotal] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true); setError(""); setItems([]); setPageIndex(0); setSourceTotal(null);
    try {
      const chain = network === "BITCOIN_MAINNET" ? "bitcoin" : "fractal";
      const collected: ActiveUtxo[] = [];
      let cursor = 0;
      let total = 0;
      let expectedTotal: number | null = null;
      let requestWindowStartedAt = Date.now();
      let requestsInWindow = 0;
      while (true) {
        if (requestsInWindow >= MAX_UTXO_REQUESTS_PER_MINUTE) {
          const waitMs = Math.max(0, requestWindowStartedAt + UTXO_REQUEST_WINDOW_MS - Date.now());
          if (waitMs > 0) await new Promise<void>(resolve => window.setTimeout(resolve, waitMs));
          requestWindowStartedAt = Date.now();
          requestsInWindow = 0;
        }
        requestsInWindow += 1;
        const query = new URLSearchParams({ chain, address, cursor: String(cursor), size: String(PAGE_SIZE) });
        const response = await fetch(`${LIVE_DATA_API_BASE}/api/address-utxos?${query}`, { cache: "no-store", headers: { Accept: "application/json" } });
        const body = await response.json().catch(() => null) as UtxoPage | { error?: string; code?: string } | null;
        if (!response.ok) throw new Error(body && "error" in body && body.error ? `${body.error}${body.code ? ` [${body.code}]` : ""}` : `UTXO endpoint HTTP ${response.status}`);
        if (!body || !("utxo" in body) || body.chain !== chain || body.address !== address || body.cursor !== cursor ||
            !Array.isArray(body.utxo) || !Number.isSafeInteger(body.scannedCount) || body.scannedCount < 0 ||
            body.scannedCount > PAGE_SIZE || body.nextCursor !== cursor + body.scannedCount ||
            !Number.isSafeInteger(body.total) || body.total < body.nextCursor || body.utxo.length > body.scannedCount ||
            (expectedTotal !== null && body.total !== expectedTotal)) {
          throw new Error("L’indexeur n’a pas confirmé une page UTXO cohérente. Les données partielles ne sont pas affichées.");
        }
        expectedTotal ??= body.total;
        collected.push(...body.utxo);
        total = body.total;
        cursor = body.nextCursor;
        if (cursor >= total) break;
        if (body.scannedCount === 0 || cursor > MAX_UTXO_CURSOR || total > MAX_UTXO_CURSOR) {
          throw new Error(`Scan UTXO incomplet : ${cursor} sorties vérifiées sur ${total}. L’indexeur n’a pas avancé ou sa limite de curseur (1 000 000) est atteinte. Aucune liste partielle n’est affichée.`);
        }
      }
      setItems(collected);
      setSourceTotal(total);
      setUpdatedAt(new Date().toISOString());
      if (collected.length === 0 && total > 0) setError("L’indexeur signale des sorties mais n’a renvoyé aucune ligne UTXO valide.");
    } catch (cause) {
      setError(explainUtxoFailure(cause));
    } finally { setBusy(false); }
  }, [address, network]);

  useEffect(() => { void refresh(); }, [refresh]);

  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const visible = useMemo(() => items.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE), [items, pageIndex]);
  const explorer = network === "BITCOIN_MAINNET" ? "https://mempool.space" : "https://mempool.fractalbitcoin.io";
  const label = network === "BITCOIN_MAINNET" ? "BTC" : "FB";
  const safeTotal = items.filter(item => item.isSpent === false && (item.height ?? 0) > 0 && item.satoshi >= 600 && Array.isArray(item.inscriptions) && item.inscriptions.length === 0 && Array.isArray(item.runes) && item.runes.length === 0 && Array.isArray(item.alkanes) && item.alkanes.length === 0 && Boolean(item.scriptPk)).reduce((sum, item) => sum + item.satoshi, 0);
  return <section className="mt-3 border border-[#70c7a0]/40 bg-[#0e1513] p-3 sm:p-4" aria-labelledby="active-utxos-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h4 id="active-utxos-title" className="font-mono text-[10px] uppercase tracking-[.13em] text-[#9fe0bd]">Active UTXOs · {label}</h4><p className="mt-1 font-mono text-[9px] leading-4 text-[#718092]">Scan complet jusqu’au total annoncé par l’indexeur · affichage par pages de 25 · adresse active seulement</p></div>
      <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6] hover:border-[#70c7a0] disabled:opacity-50"><RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Actualiser</button>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      <div className="border border-[#2c323a] bg-[#10151a] p-2"><p className="font-mono text-[8px] uppercase text-[#718092]">Lignes récupérées</p><p className="mt-1 font-display text-lg text-[#f3efe5]">{items.length}{sourceTotal !== null ? ` / ${sourceTotal}` : ""}</p></div>
      <div className="border border-[#2c323a] bg-[#10151a] p-2"><p className="font-mono text-[8px] uppercase text-[#718092]">Total listé</p><p className="mt-1 font-display text-lg text-[#f3efe5]">{sourceTotal === null ? "—" : sourceTotal.toLocaleString("fr-FR")}</p></div>
      <div className="border border-[#2c323a] bg-[#10151a] p-2"><p className="font-mono text-[8px] uppercase text-[#718092]">Candidats indicatifs sans actifs de protocole</p><p className="mt-1 font-display text-lg text-[#f3efe5]">{safeTotal.toLocaleString("fr-FR")} sats</p></div>
    </div>
    <p className="mt-2 font-mono text-[8px] leading-4 text-[#e0b45f]">Le total indicatif n’est pas une autorisation de dépense : seuls les UTXO confirmés dont l’absence d’inscriptions, Runes et Alkanes est explicitement connue sont comptés. Chaque entrée de frais est revalidée séparément avant signature.</p>
    {error && <p className="mt-3 break-words border border-[#e0b45f]/40 p-2 font-mono text-[9px] text-[#e0b45f]" role="status">{error}</p>}
    {!error && items.length === 0 && <p className="mt-3 font-mono text-[9px] text-[#718092]">{busy ? "Chargement des UTXO…" : "Aucune sortie active renvoyée par l’indexeur."}</p>}
    {visible.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] border-collapse text-left font-mono text-[9px]">
      <thead><tr className="border-b border-[#3b434d] text-[#718092]"><th className="p-2">Outpoint</th><th className="p-2">Valeur</th><th className="p-2">Confirmations</th><th className="p-2">Inscriptions</th><th className="p-2">Runes / Alkanes</th><th className="p-2">État</th></tr></thead>
      <tbody>{visible.map(item => <tr key={`${item.txid}:${item.vout}`} className="border-b border-[#2c323a] text-[#d9d3c6]">
        <td className="p-2"><a href={`${explorer}/tx/${encodeURIComponent(item.txid)}#${item.vout}`} target="_blank" rel="noreferrer" className="hover:text-[#f2bd63]">{short(item.txid)}:{item.vout} <ExternalLink size={9} className="inline" /></a></td>
        <td className="p-2">{item.satoshi.toLocaleString("fr-FR")} sats</td>
        <td className="p-2">{item.height === null ? "Inconnues" : item.height > 0 ? `Confirmée · bloc ${item.height}` : "Non confirmée"}</td>
        <td className="p-2">{item.inscriptions === null ? "À vérifier" : item.inscriptions.length ? `${item.inscriptions.length} détectée(s)` : "Aucune listée"}</td>
        <td className="p-2">{item.runes === null || item.alkanes === null ? "À vérifier" : item.runes.length || item.alkanes.length ? `Runes ${item.runes.length} · Alkanes ${item.alkanes.length}` : "Aucun détecté"}</td>
        <td className="p-2">{item.isSpent === false ? "Active" : item.isSpent === true ? "Dépensée" : "État à vérifier"}</td>
      </tr>)}</tbody>
    </table></div>}
    {items.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[9px]"><span className="text-[#718092]">Page {pageIndex + 1} / {pageCount}</span><div className="flex gap-2"><button type="button" onClick={() => setPageIndex(value => Math.max(0, value - 1))} disabled={pageIndex === 0} className="min-h-9 border border-[#3b434d] px-3 disabled:opacity-40">Précédent</button><button type="button" onClick={() => setPageIndex(value => Math.min(pageCount - 1, value + 1))} disabled={pageIndex + 1 >= pageCount} className="min-h-9 border border-[#3b434d] px-3 disabled:opacity-40">Suivant</button></div></div>}
    {updatedAt && <p className="mt-2 font-mono text-[8px] text-[#718092]">Mis à jour {new Date(updatedAt).toLocaleTimeString()}</p>}
  </section>;
}
