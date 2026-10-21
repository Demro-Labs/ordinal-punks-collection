import { useState } from "react";
import { ArrowRight, ExternalLink, ShieldCheck, Wallet, Coins, Image, Layers, LockKeyhole } from "lucide-react";
import type { LocalVaultSiteSession } from "@/lib/local-vault-bridge";

const explorerBase = (network: LocalVaultSiteSession["network"]) =>
  network === "BITCOIN_MAINNET" ? "https://mempool.space" : "https://mempool.fractalbitcoin.io";

export function TransactionControlCenter({ session }: { session: LocalVaultSiteSession }) {
  const networkLabel = session.network === "BITCOIN_MAINNET" ? "Bitcoin · BTC" : "Fractal Bitcoin · FB";
  const address = session.addresses[session.activeAddressType].address;
  const explorerAddress = `${explorerBase(session.network)}/address/${encodeURIComponent(address)}`;
  type TransferAsset = "native" | "ordinal" | "brc20" | "runes" | "brc20prog" | "alkanes";
  const [selectedAsset, setSelectedAsset] = useState<TransferAsset>("native");
  const transferChoices: { id: TransferAsset; label: string; detail: string; icon: typeof Coins }[] = [
    { id: "native", label: session.network === "BITCOIN_MAINNET" ? "BTC" : "FB", detail: "Paiement natif", icon: Coins },
    { id: "ordinal", label: "Ordinals", detail: "Inscription existante", icon: Image },
    { id: "brc20", label: "BRC-20 classique", detail: "Inscription TRANSFER", icon: Layers },
    { id: "runes", label: "Runes", detail: "Runestone dédiée", icon: Coins },
    { id: "brc20prog", label: "BRC20-Prog", detail: "Constructeur non validé", icon: LockKeyhole },
    { id: "alkanes", label: "Alkanes", detail: "Constructeur non validé", icon: LockKeyhole },
  ];
  const blocked = selectedAsset === "brc20prog" || selectedAsset === "alkanes";
  const target = selectedAsset === "ordinal" ? "#local-vault-assets"
    : selectedAsset === "brc20" ? "#local-vault-brc20-transfer"
    : selectedAsset === "runes" ? "#local-vault-runes" : "";
  const pathLabel = selectedAsset === "brc20" ? "Parcours B · Préparer puis envoyer" : "Parcours A · Actif existant";
  const pathDescription = selectedAsset === "brc20"
    ? "Créez et payez d’abord l’inscription TRANSFER. Après indexation, examinez et signez séparément l’envoi final au destinataire. Ces deux transactions ne sont jamais automatiques."
    : selectedAsset === "native"
      ? "Préparez le paiement sur le réseau sélectionné, vérifiez le destinataire, les frais et les entrées, puis signez localement et diffusez après confirmation explicite."
      : selectedAsset === "ordinal"
        ? "Sélectionnez l’inscription, prouvez sa propriété si demandé, vérifiez la sortie qui la porte et les entrées de frais, puis signez localement."
        : selectedAsset === "runes"
          ? "Choisissez le Rune et le montant. Le constructeur Runestone doit vérifier les entrées et sorties; les UTXO portant des actifs ne peuvent pas payer les frais."
          : "Ce protocole reste bloqué jusqu’à l’ajout d’un constructeur dédié et de validations indépendantes des actifs et sorties.";

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

      <div className="mb-4 rounded-lg border border-[#d7b77b]/30 bg-[#0b100f]/75 p-3 sm:p-4" aria-label="Assistant intelligent de transfert Local Vault">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#d7b77b]">Assistant de transfert</p><h5 className="mt-1 text-sm font-semibold text-[#f3efe5]">Que souhaitez-vous envoyer ?</h5></div>
          <span className="rounded border border-[#27332f] px-2 py-1 font-mono text-[9px] text-[#9ea7b3]">{networkLabel}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
          {transferChoices.map(choice => {
            const Icon = choice.icon;
            const isBlocked = choice.id === "brc20prog" || choice.id === "alkanes";
            return <button key={choice.id} type="button" aria-pressed={selectedAsset === choice.id} onClick={() => setSelectedAsset(choice.id)} className={`min-h-[76px] rounded-lg border p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d7b77b] ${selectedAsset === choice.id ? "border-[#d7b77b] bg-[#d7b77b]/10" : "border-[#27332f] bg-[#10151a] hover:border-[#56616d]"}`}>
              <span className="flex items-center gap-2 text-xs font-semibold text-[#f3efe5]"><Icon size={14} />{choice.label}</span>
              <span className={`mt-1 block text-[10px] leading-4 ${isBlocked ? "text-[#e6a69b]" : "text-[#9ea7b3]"}`}>{choice.detail}</span>
            </button>;
          })}
        </div>
        <div className={`mt-3 rounded-lg border p-3 ${blocked ? "border-[#a45e54]/50 bg-[#a45e54]/5" : "border-[#70c7a0]/30 bg-[#70c7a0]/5"}`}>
          <p className={`font-mono text-[9px] uppercase tracking-[.12em] ${blocked ? "text-[#e6a69b]" : "text-[#9fe0bd]"}`}>{blocked ? "Transfert indisponible · sécurité" : pathLabel}</p>
          <p className="mt-1 text-xs leading-5 text-[#c5cbd2]">{pathDescription}</p>
          {blocked ? <p className="mt-2 text-[10px] leading-4 text-[#e6a69b]">Aucune signature ni diffusion ne sera proposée pour cet actif tant que les contrôles spécialisés ne sont pas validés.</p>
            : target ? <a href={target} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded border border-[#d7b77b]/50 px-3 text-xs font-semibold text-[#e4c98f] hover:bg-[#d7b77b]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d7b77b]">Ouvrir le parcours <ArrowRight size={13} /></a>
            : <button type="button" onClick={() => window.dispatchEvent(new Event("ordi-wallet:open"))} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded border border-[#d7b77b]/50 px-3 text-xs font-semibold text-[#e4c98f] hover:bg-[#d7b77b]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d7b77b]"><Wallet size={13} /> Ouvrir Ordi Wallet <ArrowRight size={13} /></button>}
        </div>
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
