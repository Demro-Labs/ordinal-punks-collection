import { useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Bitcoin, Blocks, CheckCircle2, ScanSearch, ShieldCheck, Sparkles } from "lucide-react";
import type { OrdinalNetwork } from "@/lib/ordinals";

type Filter = "all" | "native" | "ordinals" | "brc20" | "runes" | "scanners";
type Row = { id: string; category: Exclude<Filter, "all">; title: string; detail: string; target: string; action: string; scanner?: boolean };

const rows: Row[] = [
  { id: "native-send", category: "native", title: "BTC / FB — transfert natif", detail: "Envoi de sats, estimation et revue des frais, signature locale et diffusion confirmée.", target: "local-native-transfer", action: "Ouvrir le transfert" },
  { id: "utxo-scan", category: "scanners", title: "Scanner UTXO sûrs", detail: "Parcourir les sorties et sélectionner le type d’adresse avant de préparer un paiement.", target: "local-native-transfer", action: "Ouvrir le scanner", scanner: true },
  { id: "ordinal-send", category: "ordinals", title: "Ordinals / inscriptions", detail: "Scanner les inscriptions indexées, choisir l’inscription et vérifier la propriété avant signature.", target: "local-vault-ordinal-scanner", action: "Voir les inscriptions", scanner: true },
  { id: "brc20-send", category: "brc20", title: "BRC-20 classique", detail: "Scanner les inscriptions transférables par ticker, préparer TRANSFER, payer avec revue locale puis envoyer l’inscription séparément.", target: "local-vault-brc20-transfer", action: "Ouvrir le scanner BRC-20", scanner: true },
  { id: "runes-send", category: "runes", title: "Runes", detail: "Scanner les soldes paginés, sélectionner le Rune et préparer la transaction dédiée.", target: "local-vault-runes", action: "Ouvrir le scanner Runes", scanner: true },
];

const filters: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Toutes" },
  { id: "native", label: "BTC / FB" },
  { id: "ordinals", label: "Ordinals" },
  { id: "brc20", label: "BRC-20" },
  { id: "runes", label: "Runes" },
  { id: "scanners", label: "Scanners" },
];

export function LocalVaultTransactionHub({ network }: { network: OrdinalNetwork }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState("native-send");
  const networkLabel = network === "BITCOIN_MAINNET" ? "Bitcoin · BTC" : "Fractal Bitcoin · FB";
  const visibleRows = rows.filter(row => filter === "all" || row.category === filter || (filter === "scanners" && row.scanner));
  function openTarget(row: Row) {
    setSelected(row.id);
    const target = document.getElementById(row.target);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (target) target.setAttribute("tabindex", "-1");
    target?.focus({ preventScroll: true });
  }
  return <section className="mt-4 overflow-hidden border border-[#70c7a0]/40 bg-[#0b0f13]" aria-labelledby="local-vault-transaction-hub-title">
    <div className="flex flex-col gap-3 border-b border-[#2c323a] bg-gradient-to-r from-[#14251f] via-[#101a16] to-[#171b20] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.2em] text-[#9fe0bd]"><Sparkles size={13} /> Ordi Wallet · Premium Control Center</p>
        <h2 id="local-vault-transaction-hub-title" className="mt-1 font-display text-xl text-[#f3efe5]">Centre de transactions Local Vault</h2>
        <p className="mt-1 font-mono text-[10px] text-[#9ea7b3]">{networkLabel} · signature locale · revue obligatoire avant diffusion</p>
      </div>
      <div className="flex items-center gap-2 self-start border border-[#70c7a0]/30 bg-[#70c7a0]/5 px-3 py-2 font-mono text-[9px] uppercase text-[#9fe0bd]"><ShieldCheck size={14} /> Protections actives</div>
    </div>
    <div className="flex flex-wrap gap-2 border-b border-[#2c323a] p-3" role="group" aria-label="Filtrer les types de transaction">
      {filters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} className={`min-h-9 border px-3 font-mono text-[9px] uppercase tracking-[.08em] transition-colors ${filter === item.id ? "border-[#70c7a0] bg-[#70c7a0]/15 text-[#9fe0bd]" : "border-[#3b434d] text-[#9ea7b3] hover:border-[#70c7a0]/60"}`}>{item.label}</button>)}
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[650px] border-collapse text-left">
        <thead><tr className="border-b border-[#2c323a] font-mono text-[9px] uppercase tracking-[.1em] text-[#718092]"><th className="px-3 py-3">Type</th><th className="px-3 py-3">Fonction / scanner</th><th className="px-3 py-3">Réseau</th><th className="px-3 py-3">Action</th></tr></thead>
        <tbody>{visibleRows.map(row => <tr key={row.id} className={`border-b border-[#20262d] align-top last:border-b-0 ${selected === row.id ? "bg-[#70c7a0]/[.06]" : "hover:bg-white/[.02]"}`}>
          <td className="px-3 py-3"><div className="flex items-start gap-2 text-[#f3efe5]">{row.category === "native" ? <Bitcoin size={15} className="mt-0.5 text-[#f2bd63]" /> : row.category === "ordinals" ? <Blocks size={15} className="mt-0.5 text-[#f2bd63]" /> : row.scanner ? <ScanSearch size={15} className="mt-0.5 text-[#9fe0bd]" /> : <ArrowUpRight size={15} className="mt-0.5 text-[#f2bd63]" />}<span className="font-mono text-[10px]">{row.title}</span></div></td>
          <td className="px-3 py-3"><p className="max-w-xl font-mono text-[10px] leading-5 text-[#9ea7b3]">{row.detail}</p>{row.scanner && <span className="mt-1 inline-flex items-center gap-1 font-mono text-[8px] uppercase text-[#9fe0bd]"><ScanSearch size={10} /> Sélectionnable</span>}</td>
          <td className="whitespace-nowrap px-3 py-3 font-mono text-[9px] text-[#d9d3c6]">{network === "BITCOIN_MAINNET" ? "BTC · mainnet" : "FB · mainnet"}</td>
          <td className="px-3 py-3"><button type="button" onClick={() => openTarget(row)} className="inline-flex min-h-9 items-center gap-1 whitespace-nowrap border border-[#d99a54]/70 px-3 font-mono text-[9px] uppercase text-[#f2bd63] hover:bg-[#d99a54]/10"><ArrowDownToLine size={12} /> {row.action}</button></td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="flex items-start gap-2 border-t border-[#2c323a] px-3 py-3 font-mono text-[9px] leading-5 text-[#718092]"><CheckCircle2 size={13} className="mt-0.5 shrink-0 text-[#9fe0bd]" /> Les actions ouvrent les outils réels ci-dessous. Les UTXO portant une inscription, une Rune ou un actif protocolaire ne doivent jamais servir aux frais. BRC20-Prog et Alkanes restent exclus de ce centre tant que leurs constructeurs dédiés ne sont pas validés.</p>
  </section>;
}
