import { useState } from "react";
import { Check, Copy, Loader2, Search, Wallet } from "lucide-react";
import { getSpendableUtxos, getUtxoBalanceSummary } from "@/lib/mempool";
import { ADDRESS_SPECS, fetchAddressBalance, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";

type ScanRow = { type: AddressType; address: string; confirmedSats: number | null; pendingSats: number | null; totalSats: number | null; safeSats: number | null; safeUtxos: number | null; totalUtxos: number | null; availableUtxos: number | null; unavailableUtxos: number | null; summaryError?: string; balanceError?: string; safeError?: string };

export function LocalVaultSafeBalanceDiscovery({ wallet, network, selectedAddressType, onSelectAddressType }: {
  wallet: OrdiWalletRecord; network: OrdiNetwork; selectedAddressType: AddressType; onSelectAddressType?: (type: AddressType) => void;
}) {
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");
  const scan = async () => {
    setBusy(true); setNotice(""); setRows(null);
    try {
      const results: ScanRow[] = await Promise.all(ADDRESS_SPECS.map(async (spec): Promise<ScanRow> => {
        const address = wallet.addresses[spec.type]?.address ?? "";
        if (!address) return { type: spec.type, address, confirmedSats: null, pendingSats: null, totalSats: null, safeSats: null, safeUtxos: null, totalUtxos: null, availableUtxos: null, unavailableUtxos: null, balanceError: "Adresse absente du coffre.", safeError: "Adresse absente du coffre." } satisfies ScanRow;
        const [balanceResult, safeResult, summaryResult] = await Promise.allSettled([fetchAddressBalance(network, address), getSpendableUtxos(network, address, 1, { collectAll: true }), getUtxoBalanceSummary(network, address)]);
        const balance = balanceResult.status === "fulfilled" ? balanceResult.value : null;
        const safe = safeResult.status === "fulfilled" ? safeResult.value : null;
        const summary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
        return {
          type: spec.type, address, confirmedSats: balance?.confirmed ?? null, pendingSats: balance?.unconfirmed ?? null, totalSats: balance?.total ?? null,
          safeSats: safe ? safe.reduce((sum, item) => sum + item.satoshi, 0) : null, safeUtxos: safe?.length ?? null,
          totalUtxos: summary?.totalUtxoCount ?? null, availableUtxos: summary?.availableUtxoCount ?? null, unavailableUtxos: summary?.unavailableUtxoCount ?? null,
          ...(summaryResult.status === "rejected" ? { summaryError: summaryResult.reason instanceof Error ? summaryResult.reason.message : "Résumé UTXO indisponible." } : {}),
          ...(balanceResult.status === "rejected" ? { balanceError: balanceResult.reason instanceof Error ? balanceResult.reason.message : "Solde total indisponible." } : {}),
          ...(safeResult.status === "rejected" ? { safeError: safeResult.reason instanceof Error ? safeResult.reason.message : "Solde sûr indisponible." } : {}),
        } satisfies ScanRow;
      }));
      setRows(results);
      if (results.some(row => row.balanceError || row.safeError || row.summaryError)) setNotice("Scan partiel : les erreurs restent distinctes du solde zéro. Réessayez après résolution de l’indexeur.");
      else setNotice("Scan terminé. Le solde confirmé, le mempool et les sats sûrs sont affichés séparément. Les sorties d’actifs restent protégées.");
    } finally { setBusy(false); }
  };
  const copyAddress = async (address: string) => {
    try { await navigator.clipboard.writeText(address); setCopied(address); setNotice("Adresse copiée. Vérifiez le réseau avant tout dépôt."); }
    catch { setNotice("Copie automatique indisponible. Sélectionnez et copiez l’adresse affichée."); }
  };
  return <div className="mt-3 border border-[#3b434d] bg-[#0b0f13] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-[#d9d3c6]"><Wallet size={13} /> Scanner les soldes du coffre</p>
      <button type="button" onClick={() => void scan()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {busy ? "Analyse…" : "Scanner les 4 adresses"}
      </button>
    </div>
    <p className="mt-2 font-mono text-[9px] leading-4 text-[#718092]">BTC/FB · Legacy, Nested SegWit, Native SegWit, Taproot. La limite de 500 est un plafond de scan, pas un nombre garanti : UniSat ne renvoie ici que les UTXO disponibles. Inscriptions, Runes, Alkanes, poussières et sorties non vérifiées restent exclus des sats sûrs.</p>
    {notice && <p className="mt-2 font-mono text-[9px] leading-4 text-[#9ea7b3]" role="status">{notice}</p>}
    {rows && <div className="mt-3 space-y-2">
      {rows.map(row => {
        const spec = ADDRESS_SPECS.find(item => item.type === row.type)!;
        return <div key={row.type} className="border border-[#252d36] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[10px] text-[#d9d3c6]">{spec.label}</p>
            <p className="font-mono text-[10px] text-[#f2bd63]">{row.totalSats === null ? "Solde total indisponible" : `Total ${row.totalSats.toLocaleString("fr-FR")} sats`}</p>
          </div>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">\n            <p className="font-mono text-[9px] text-[#9ea7b3]">UTXO indexés : {row.totalUtxos === null ? "—" : row.totalUtxos} · disponibles UniSat : {row.availableUtxos === null ? "—" : row.availableUtxos} · indisponibles : {row.unavailableUtxos === null ? "—" : row.unavailableUtxos}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">Confirmé : {row.confirmedSats === null ? "—" : `${row.confirmedSats.toLocaleString("fr-FR")} sats`}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">Mempool : {row.pendingSats === null ? "—" : `${row.pendingSats.toLocaleString("fr-FR")} sats`}</p>
            <p className="font-mono text-[9px] text-[#9fe0bd]">Sûr vérifié : {row.safeSats === null ? "—" : `${row.safeSats.toLocaleString("fr-FR")} sats · ${row.safeUtxos} UTXO`}</p>
          </div>
          <p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#718092]">{row.address || "Adresse absente"}</p>
          {row.summaryError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Résumé UTXO : {row.summaryError}</p>}\n          {row.summaryError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Résumé UTXO : {row.summaryError}</p>}
          {row.balanceError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Solde total : {row.balanceError}</p>}
          {row.safeError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Scan UTXO sûr : {row.safeError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {row.address && <button type="button" onClick={() => void copyAddress(row.address)} className="inline-flex min-h-9 items-center gap-1 border border-[#3b434d] px-2 font-mono text-[9px] text-[#9ea7b3]">{copied === row.address ? <Check size={12} /> : <Copy size={12} />} Copier l’adresse</button>}
            {!row.balanceError && !row.safeError && onSelectAddressType && <button type="button" onClick={() => onSelectAddressType(row.type)} disabled={selectedAddressType === row.type} className="min-h-9 border border-[#d99a54]/70 px-2 font-mono text-[9px] text-[#f2bd63] disabled:opacity-40">{selectedAddressType === row.type ? "Adresse sélectionnée" : "Utiliser cette adresse"}</button>}
          </div>
        </div>;
      })}
    </div>}
  </div>;
}
