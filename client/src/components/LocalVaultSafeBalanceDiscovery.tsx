import { useState } from "react";
import { Check, Copy, Loader2, Search, Wallet } from "lucide-react";
import { getSpendableUtxos } from "@/lib/mempool";
import { ADDRESS_SPECS, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";

type ScanRow = { type: AddressType; address: string; safeSats: number; safeUtxos: number; error?: string };

export function LocalVaultSafeBalanceDiscovery({ wallet, network, selectedAddressType, onSelectAddressType }: {
  wallet: OrdiWalletRecord;
  network: OrdiNetwork;
  selectedAddressType: AddressType;
  onSelectAddressType?: (type: AddressType) => void;
}) {
  const [rows, setRows] = useState<ScanRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");

  const scan = async () => {
    setBusy(true);
    setNotice("");
    setRows(null);
    try {
      const results = await Promise.all(ADDRESS_SPECS.map(async spec => {
        const address = wallet.addresses[spec.type]?.address ?? "";
        try {
          if (!address) throw new Error("Adresse absente du coffre.");
          const utxos = await getSpendableUtxos(network, address, 1, { collectAll: true });
          return { type: spec.type, address, safeSats: utxos.reduce((sum, item) => sum + item.satoshi, 0), safeUtxos: utxos.length } satisfies ScanRow;
        } catch (cause) {
          return { type: spec.type, address, safeSats: 0, safeUtxos: 0, error: cause instanceof Error ? cause.message : "Analyse indisponible." } satisfies ScanRow;
        }
      }));
      setRows(results);
      if (results.some(row => row.error)) setNotice("Certaines adresses n’ont pas pu être vérifiées complètement. Ne les considérez pas comme ayant un solde sûr nul : réessayez après résolution de l’erreur.");
      else setNotice("Analyse terminée : seuls les UTXO confirmés vérifiés sans inscription, Rune ou Alkane sont comptés. Les fonds protégés ne sont pas inclus.");
    } finally {
      setBusy(false);
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
      <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-[#d9d3c6]"><Wallet size={13} /> Diagnostiquer les 4 adresses du coffre</p>
      <button type="button" onClick={() => void scan()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#d99a54] px-3 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {busy ? "Analyse…" : "Scanner les soldes sûrs"}
      </button>
    </div>
    <p className="mt-2 font-mono text-[9px] leading-4 text-[#718092]">Recherche les sats utilisables sur Legacy, Nested SegWit, Native SegWit et Taproot, sans déplacer ni signer de fonds. Une adresse en erreur doit être rescannée avant de conclure.</p>
    {notice && <p className="mt-2 font-mono text-[9px] leading-4 text-[#9ea7b3]" role="status">{notice}</p>}
    {rows && <div className="mt-3 space-y-2">
      {rows.map(row => {
        const spec = ADDRESS_SPECS.find(item => item.type === row.type)!;
        return <div key={row.type} className="border border-[#252d36] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[10px] text-[#d9d3c6]">{spec.label}</p>
            <p className="font-mono text-[10px] text-[#f2bd63]">{row.error ? "Vérification incomplète" : `${row.safeSats.toLocaleString("en-US")} sats sûrs · ${row.safeUtxos} UTXO`}</p>
          </div>
          <p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#718092]">{row.address || "Adresse absente"}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {row.address && <button type="button" onClick={() => void copyAddress(row.address)} className="inline-flex min-h-9 items-center gap-1 border border-[#3b434d] px-2 font-mono text-[9px] text-[#9ea7b3]">{copied === row.address ? <Check size={12} /> : <Copy size={12} />} Copier l’adresse</button>}
            {!row.error && onSelectAddressType && <button type="button" onClick={() => onSelectAddressType(row.type)} disabled={selectedAddressType === row.type} className="min-h-9 border border-[#d99a54]/70 px-2 font-mono text-[9px] text-[#f2bd63] disabled:opacity-40">{selectedAddressType === row.type ? "Adresse sélectionnée" : "Utiliser cette adresse"}</button>}
          </div>
          {row.error && <p className="mt-2 break-words font-mono text-[9px] leading-4 text-[#e6a69b]">{row.error}</p>}
        </div>;
      })}
    </div>}
  </div>;
}
