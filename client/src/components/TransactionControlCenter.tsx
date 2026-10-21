import { ArrowRight, ExternalLink, ShieldCheck, Wallet } from "lucide-react";
import type { LocalVaultSiteSession } from "@/lib/local-vault-bridge";

const explorerBase = (network: LocalVaultSiteSession["network"]) =>
  network === "BITCOIN_MAINNET" ? "https://mempool.space" : "https://mempool.fractalbitcoin.io";

export function TransactionControlCenter({ session }: { session: LocalVaultSiteSession }) {
  const networkLabel = session.network === "BITCOIN_MAINNET" ? "Bitcoin · BTC" : "Fractal Bitcoin · FB";
  const address = session.addresses[session.activeAddressType].address;
  const explorerAddress = `${explorerBase(session.network)}/address/${encodeURIComponent(address)}`;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-[#d7b77b]/35 bg-[linear-gradient(135deg,rgba(215,183,123,.08),rgba(13,19,16,.96)_52%)]" aria-labelledby="transaction-control-center-title">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#27332f] p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#d7b77b]/30 bg-[#d7b77b]/10 text-[#e4c98f]"><ShieldCheck size={19} /></div>
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#d7b77b]">Ordi Wallet · contrôle sécurisé</p>
            <h4 id="transaction-control-center-title" className="mt-1 font-display text-lg font-semibold text-[#f3efe5]">Centre de contrôle des transactions</h4>
            <p className="mt-1 text-xs leading-5 text-[#9ea7b3]">Préparez, vérifiez et signez dans le coffre local. Cet écran ne signe et ne diffuse rien automatiquement.</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-[#d7b77b]/30 bg-[#0b100f]/70 px-3 py-2 font-mono text-[9px] uppercase tracking-[.1em] text-[#e4c98f]"><span className="h-1.5 w-1.5 rounded-full bg-[#d7b77b]" /> Réseau sélectionné · {networkLabel}</span>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-2" aria-label="Parcours A et B des transferts Local Vault">
        <article className="rounded-lg border border-[#70c7a0]/30 bg-[#0b100f]/75 p-3"><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#9fe0bd]">Parcours A · actif existant</p><p className="mt-1 text-xs leading-5 text-[#9ea7b3]">Choisir l’actif existant, vérifier le réseau, le destinataire et tous les UTXO, examiner la transaction, signer dans le Local Vault puis confirmer la diffusion.</p></article>
        <article className="rounded-lg border border-[#d7b77b]/30 bg-[#0b100f]/75 p-3"><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#e4c98f]">Parcours B · préparation requise</p><p className="mt-1 text-xs leading-5 text-[#9ea7b3]">Pour BRC-20 classique, créer d’abord l’inscription TRANSFER puis envoyer cette inscription dans une transaction distincte. Les autres protocoles utilisent leur constructeur dédié; aucun transfert n’est lancé automatiquement.</p></article>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
        <article className="rounded-lg border border-[#27332f] bg-[#0b100f]/75 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#9fe0bd]">01 · Entrées</p>
          <h5 className="mt-2 text-sm font-semibold text-[#f3efe5]">Actualiser les UTXO</h5>
          <p className="mt-1 text-xs leading-5 text-[#9ea7b3]">Recharger la liste complète et vérifier l’état des sorties avant de construire un PSBT.</p>
          <a href="#transaction-utxo-review" className="mt-3 inline-flex min-h-9 items-center gap-2 text-xs font-semibold text-[#9fe0bd] hover:text-[#f3efe5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d7b77b]">Voir les UTXO <ArrowRight size={13} /></a>
        </article>
        <article className="rounded-lg border border-[#27332f] bg-[#0b100f]/75 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#9fe0bd]">02 · Construction</p>
          <h5 className="mt-2 text-sm font-semibold text-[#f3efe5]">Reconstruire le PSBT</h5>
          <p className="mt-1 text-xs leading-5 text-[#9ea7b3]">En cas d’entrée absente ou périmée, ne réutilisez pas l’ancien PSBT : repartez des UTXO actuellement vérifiés.</p>
        </article>
        <article className="rounded-lg border border-[#27332f] bg-[#0b100f]/75 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#e4c98f]">03 · Examen</p>
          <h5 className="mt-2 text-sm font-semibold text-[#f3efe5]">Contrôler chaque détail</h5>
          <p className="mt-1 text-xs leading-5 text-[#9ea7b3]">Confirmez réseau, adresse, entrées, sorties, frais et actifs Ordinals/Runes avant toute signature.</p>
        </article>
        <article className="rounded-lg border border-[#27332f] bg-[#0b100f]/75 p-3">
          <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#e4c98f]">04 · Autorisation</p>
          <h5 className="mt-2 text-sm font-semibold text-[#f3efe5]">Signature locale explicite</h5>
          <p className="mt-1 text-xs leading-5 text-[#9ea7b3]">UniSat peut fournir les données; il ne signe pas à la place du coffre local. Aucune diffusion automatique.</p>
          <button type="button" onClick={() => window.dispatchEvent(new Event("ordi-wallet:open"))} className="mt-3 inline-flex min-h-9 items-center gap-2 text-xs font-semibold text-[#e4c98f] hover:text-[#f3efe5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d7b77b]"><Wallet size={13} /> Ouvrir Ordi Wallet</button>
        </article>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#27332f] bg-[#0b100f]/65 px-4 py-3 sm:px-5">
        <p className="max-w-3xl text-xs leading-5 text-[#e0b45f]">Sécurité : si l’indexeur est indisponible, si le scan est incomplet ou si une entrée n’est plus disponible, la signature doit rester bloquée. Ne contournez pas ces contrôles.</p>
        <a href={explorerAddress} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-2 text-xs text-[#9ea7b3] hover:text-[#f3efe5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d7b77b]">Explorer l’adresse <ExternalLink size={12} /></a>
      </div>
    </section>
  );
}
