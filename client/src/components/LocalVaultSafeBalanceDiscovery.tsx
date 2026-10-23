import { useState } from "react";
import { Check, Copy, Loader2, Search, Wallet } from "lucide-react";
import { getSpendableUtxos, getUtxoBalanceSummary, scanAddressUtxoInventory } from "@/lib/mempool";
import { ADDRESS_SPECS, fetchAddressBalance, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";

type ScanRow = {
  type: AddressType;
  address: string;
  confirmedSats: number | null;
  pendingSats: number | null;
  totalSats: number | null;
  safeSats: number | null;
  safeUtxos: number | null;
  totalUtxos: number | null;
  availableUtxos: number | null;
  unavailableUtxos: number | null;
  availableSats: number | null;
  unavailableSats: number | null;
  inventoryScannedUtxos?: number;
  inventoryTotalUtxos?: number;
  scannedUtxos?: number;
  scanTotalUtxos?: number;
  summaryError?: string;
  balanceError?: string;
  inventoryError?: string;
  safeError?: string;
  consistencyError?: string;
  rejectionCounts?: Record<string, number>;
  rejectionSats?: Record<string, number>;
};

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function addConsistencyWarning(row: ScanRow, message: string): ScanRow {
  return { ...row, consistencyError: row.consistencyError ? `${row.consistencyError} ${message}` : message };
}

export function LocalVaultSafeBalanceDiscovery({ wallet, network, selectedAddressType, onSelectAddressType }: {
  wallet: OrdiWalletRecord;
  network: OrdiNetwork;
  selectedAddressType: AddressType;
  onSelectAddressType?: (type: AddressType) => void;
}) {
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");

  const scan = async () => {
    setBusy(true);
    setProgress("");
    setNotice("");
    setRows(null);
    const results: ScanRow[] = [];
    try {
      for (let index = 0; index < ADDRESS_SPECS.length; index += 1) {
        const spec = ADDRESS_SPECS[index];
        const label = `${index + 1}/${ADDRESS_SPECS.length} · ${spec.label}`;
        setProgress(`${label} · soldes`);
        const address = wallet.addresses?.[spec.type]?.address ?? "";
        if (!address) {
          results.push({
            type: spec.type, address, confirmedSats: null, pendingSats: null, totalSats: null,
            safeSats: null, safeUtxos: null, totalUtxos: null, availableUtxos: null,
            unavailableUtxos: null, availableSats: null, unavailableSats: null,
            balanceError: "Adresse absente du coffre.", inventoryError: "Adresse absente du coffre.", safeError: "Adresse absente du coffre.",
          });
          setRows([...results]);
          continue;
        }

        // Read aggregate balances first, then scan this address's safe UTXOs before
        // starting the next address. This avoids multiplying the Worker/IP quota by four.
        const [balanceResult, summaryResult] = await Promise.allSettled([
          fetchAddressBalance(network, address),
          getUtxoBalanceSummary(network, address),
        ]);
        let row: ScanRow = {
          type: spec.type,
          address,
          confirmedSats: balanceResult.status === "fulfilled" ? balanceResult.value.confirmed : null,
          pendingSats: balanceResult.status === "fulfilled" ? balanceResult.value.unconfirmed : null,
          totalSats: balanceResult.status === "fulfilled" ? balanceResult.value.total : null,
          safeSats: null,
          safeUtxos: null,
          totalUtxos: summaryResult.status === "fulfilled" ? summaryResult.value.totalUtxoCount : null,
          availableUtxos: summaryResult.status === "fulfilled" ? summaryResult.value.availableUtxoCount : null,
          unavailableUtxos: summaryResult.status === "fulfilled" ? summaryResult.value.unavailableUtxoCount : null,
          availableSats: summaryResult.status === "fulfilled" ? summaryResult.value.availableBalance : null,
          unavailableSats: summaryResult.status === "fulfilled" ? summaryResult.value.unavailableBalance : null,
          ...(balanceResult.status === "rejected" ? { balanceError: errorMessage(balanceResult.reason, "Solde total indisponible.") } : {}),
          ...(summaryResult.status === "rejected" ? { summaryError: errorMessage(summaryResult.reason, "Résumé UTXO indisponible.") } : {}),
        };
        results.push(row);
        setRows([...results]);

        setProgress(`${label} · inventaire complet`);
        try {
          const inventory = await scanAddressUtxoInventory(network, address, {
            onProgress: scan => {
              row = { ...row, inventoryScannedUtxos: scan.scannedCount, inventoryTotalUtxos: scan.totalCount };
              results[results.length - 1] = row;
              setRows([...results]);
              setProgress(`${label} · inventaire ${scan.scannedCount.toLocaleString("fr-FR")}/${scan.totalCount.toLocaleString("fr-FR")}`);
            },
          });
          row = { ...row, inventoryScannedUtxos: inventory.scannedCount, inventoryTotalUtxos: inventory.totalCount };
          if (summaryResult.status === "fulfilled" && inventory.totalCount !== summaryResult.value.totalUtxoCount) {
            row = addConsistencyWarning(row, `Le résumé UniSat annonce ${summaryResult.value.totalUtxoCount} UTXO, mais l’inventaire complet en confirme ${inventory.totalCount}.`);
          }
        } catch (error) {
          row = { ...row, inventoryError: errorMessage(error, "Inventaire complet UTXO indisponible.") };
        }
        results[results.length - 1] = row;
        setRows([...results]);

        setProgress(`${label} · UTXO sûrs`);
        try {
          const safe = await getSpendableUtxos(network, address, 1, {
            collectAll: true,
            allowInsufficientSafeBalance: true,
            onDiagnostics: diagnostics => {
              row = { ...row, rejectionCounts: diagnostics.counts, rejectionSats: diagnostics.sats };
              results[results.length - 1] = row;
              setRows([...results]);
            },
            onProgress: scan => {
              row = { ...row, scannedUtxos: scan.scannedCount, scanTotalUtxos: scan.totalCount };
              results[results.length - 1] = row;
              setRows([...results]);
              setProgress(`${label} · UTXO disponibles ${scan.scannedCount.toLocaleString("fr-FR")}/${scan.totalCount.toLocaleString("fr-FR")}`);
            },
          });
          const safeSats = safe.reduce((sum, item) => sum + item.satoshi, 0);
          row = { ...row, safeSats, safeUtxos: safe.length };
          // Reconcile source outputs traversed separately from the fee-safe subset.
          // A single-page scan must never appear complete just because it found one safe UTXO.
          if (summaryResult.status === "fulfilled" && row.scannedUtxos !== undefined && row.scannedUtxos !== summaryResult.value.availableUtxoCount) {
            row = addConsistencyWarning(row, "Le scanner a parcouru " + row.scannedUtxos + " sorties disponibles, mais le résumé UniSat en annonce " + summaryResult.value.availableUtxoCount + ". Le scan n’est pas considéré comme concordant.");
          }
          if (summaryResult.status === "fulfilled" && (safe.length !== summaryResult.value.availableUtxoCount || safeSats !== summaryResult.value.availableBalance)) {
            row = addConsistencyWarning(row, `UniSat annonce ${summaryResult.value.availableUtxoCount} UTXO disponibles (${summaryResult.value.availableBalance.toLocaleString("fr-FR")} sats), mais la validation stricte confirme ${safe.length} (${safeSats.toLocaleString("fr-FR")} sats).`);
          }
        } catch (error) {
          row = { ...row, safeError: errorMessage(error, "Scan UTXO sûr indisponible.") };
        }
        results[results.length - 1] = row;
        setRows([...results]);
      }
      if (results.some(row => row.balanceError || row.safeError || row.summaryError || row.inventoryError || row.consistencyError)) {
        setNotice("Scan terminé avec erreurs signalées par adresse. Une erreur d’indexeur n’est pas affichée comme un solde zéro.");
      } else {
        setNotice("Scan terminé pour les quatre adresses. L’inventaire complet et les UTXO disponibles pour frais sont vérifiés séparément; les sorties exclues restent hors du solde sûr.");
      }
    } catch (error) {
      setNotice(`Scan interrompu : ${errorMessage(error, "erreur inattendue")}. Les lignes déjà terminées restent affichées.`);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const copyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      setNotice("Adresse copiée. Vérifiez le réseau avant tout dépôt.");
    } catch {
      setNotice("Copie automatique indisponible. Sélectionnez et copiez l’adresse affichée.");
    }
  };

  return <div className="mt-3 border border-[#3b434d] bg-[#0b0f13] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-[#d9d3c6]"><Wallet size={13} /> Scanner les soldes du coffre</p>
      <button type="button" onClick={() => void scan()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {busy ? `Analyse ${progress || "…"}` : "Scanner les 4 adresses"}
      </button>
    </div>
    <p className="mt-2 font-mono text-[9px] leading-4 text-[#718092]">BTC/FB · Legacy, Nested SegWit, Native SegWit, Taproot. Scan séquentiel et paginé de tout l’inventaire, puis vérification séparée des seuls UTXO UniSat disponibles pour frais. Le solde total peut inclure des sorties qui restent exclues du solde sûr.</p>
    {busy && progress && <p className="mt-2 font-mono text-[9px] leading-4 text-[#f2bd63]" role="status" aria-live="polite">{progress}</p>}
    {notice && <p className="mt-2 font-mono text-[9px] leading-4 text-[#9ea7b3]" role="status">{notice}</p>}
    {rows && <div className="mt-3 space-y-2">
      {rows.map(row => {
        const spec = ADDRESS_SPECS.find(item => item.type === row.type)!;
        return <div key={row.type} className="border border-[#252d36] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[10px] text-[#d9d3c6]">{spec.label}</p>
            <p className="font-mono text-[10px] text-[#f2bd63]">{row.totalSats === null ? "Solde total indisponible" : `Total ${row.totalSats.toLocaleString("fr-FR")} sats`}</p>
          </div>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            <p className="font-mono text-[9px] text-[#9ea7b3]">UTXO indexés : {row.totalUtxos === null ? "—" : row.totalUtxos} · disponibles UniSat : {row.availableUtxos === null ? "—" : row.availableUtxos} · indisponibles : {row.unavailableUtxos === null ? "—" : row.unavailableUtxos}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">Inventaire UTXO parcouru : {row.inventoryScannedUtxos === undefined ? "—" : `${row.inventoryScannedUtxos.toLocaleString("fr-FR")} / ${row.inventoryTotalUtxos?.toLocaleString("fr-FR")}`}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">UTXO disponibles UniSat vérifiés : {row.scannedUtxos === undefined ? "—" : `${row.scannedUtxos.toLocaleString("fr-FR")} / ${row.scanTotalUtxos?.toLocaleString("fr-FR")}`}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">Sats disponibles UniSat : {row.availableSats === null ? "—" : `${row.availableSats.toLocaleString("fr-FR")} sats`} · indisponibles : {row.unavailableSats === null ? "—" : `${row.unavailableSats.toLocaleString("fr-FR")} sats`}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">Confirmé : {row.confirmedSats === null ? "—" : `${row.confirmedSats.toLocaleString("fr-FR")} sats`}</p>
            <p className="font-mono text-[9px] text-[#9ea7b3]">Mempool : {row.pendingSats === null ? "—" : `${row.pendingSats.toLocaleString("fr-FR")} sats`}</p>
            <p className="font-mono text-[9px] text-[#9fe0bd]">Sûrs vérifiés pour frais (sous-ensemble) : {row.safeSats === null ? "—" : `${row.safeSats.toLocaleString("fr-FR")} sats · ${row.safeUtxos} UTXO`}</p>
            {row.rejectionCounts && <p className="font-mono text-[9px] leading-4 text-[#9ea7b3]">Rejets (UTXO) : {Object.entries(row.rejectionCounts).filter(([, count]) => count > 0).map(([key, count]) => `${({ identityMismatch: "adresse/outpoint incohérent", invalidValue: "montant invalide/trop faible", invalidScript: "script invalide", unconfirmedOrInvalidHeight: "non confirmé/hauteur invalide", invalidFlags: "métadonnées invalides", hasInscriptionOrUnknown: "inscription/statut inconnu", detailMismatch: "détail incohérent", spentOrUnknown: "dépensé/état inconnu", hasRunes: "Rune", hasAlkanes: "Alkane" } as Record<string, string>)[key] ?? key}: ${count}`).join(" · ") || "aucun"}</p>}
            {row.rejectionSats && <p className="font-mono text-[9px] leading-4 text-[#9ea7b3]">Valeur rejetée : {Object.entries(row.rejectionSats).filter(([, sats]) => sats > 0).map(([key, sats]) => `${({ unconfirmedOrInvalidHeight: "non confirmé", invalidFlags: "métadonnées invalides", hasInscriptionOrUnknown: "inscription/statut inconnu", detailMismatch: "détail incohérent", spentOrUnknown: "dépensé/état inconnu", hasRunes: "Rune", hasAlkanes: "Alkane" } as Record<string, string>)[key] ?? key}: ${sats.toLocaleString("fr-FR")} sats`).join(" · ") || "aucune"}</p>}
          </div>
          <p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#718092]">{row.address || "Adresse absente"}</p>
          {row.summaryError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Résumé UTXO : {row.summaryError}</p>}
          {row.balanceError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Solde total : {row.balanceError}</p>}
          {row.inventoryError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Inventaire UTXO : {row.inventoryError}</p>}
          {row.safeError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Scan UTXO sûr : {row.safeError}</p>}
          {row.consistencyError && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">Écart de vérification : {row.consistencyError}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {row.address && <button type="button" onClick={() => void copyAddress(row.address)} className="inline-flex min-h-9 items-center gap-1 border border-[#3b434d] px-2 font-mono text-[9px] text-[#9ea7b3]">{copied === row.address ? <Check size={12} /> : <Copy size={12} />} Copier l’adresse</button>}
            {!row.balanceError && !row.safeError && onSelectAddressType && <button type="button" onClick={() => onSelectAddressType(row.type)} disabled={selectedAddressType === row.type} className="min-h-9 border border-[#d99a54]/70 px-2 font-mono text-[9px] text-[#f2bd63] disabled:opacity-40">{selectedAddressType === row.type ? "Adresse sélectionnée" : "Utiliser cette adresse"}</button>}
          </div>
        </div>;
      })}
    </div>}
  </div>;
}
