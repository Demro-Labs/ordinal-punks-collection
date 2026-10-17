import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Eye, EyeOff, LockKeyhole, RefreshCw, ShieldCheck, Wallet, X } from "lucide-react";
import { UniSatWalletConnect } from "@/components/UniSatWalletConnect";
import { ProtocolAssetsPanel } from "@/components/ProtocolAssetsPanel";
import {
  ADDRESS_SPECS, createMnemonic, decryptOrdiWallet, deriveOrdiWallet, encryptOrdiWallet,
  fetchAddressBalance, formatSats, readOrdiVault, type AddressType, type OrdiNetwork, type OrdiWalletRecord,
} from "@/lib/ordi-wallet";

const BASE = import.meta.env.BASE_URL;
const NETWORKS: Array<{ id: OrdiNetwork; label: string }> = [
  { id: "BITCOIN_MAINNET", label: "Bitcoin mainnet" },
  { id: "FRACTAL_BITCOIN_MAINNET", label: "Fractal Bitcoin mainnet" },
];

type Balance = { confirmed: number; unconfirmed: number; total: number } | null;

function copy(value: string) { void navigator.clipboard?.writeText(value); }
function short(value: string) { return `${value.slice(0, 12)}…${value.slice(-10)}`; }

export function OrdiWallet({ site = "pokedex" }: { site?: "punks" | "pokedex" } = {}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"vault" | "connect">("connect");
  const [connectedToSite, setConnectedToSite] = useState(false);
  const [wallet, setWallet] = useState<OrdiWalletRecord | null>(null);
  const [vaultExists, setVaultExists] = useState(false);
  const [mode, setMode] = useState<"create" | "import" | "unlock">("create");
  const [words, setWords] = useState<12 | 24>(12);
  const [mnemonic, setMnemonic] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState<OrdiNetwork>("BITCOIN_MAINNET");
  const [balances, setBalances] = useState<Record<AddressType, Balance>>({} as Record<AddressType, Balance>);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  useEffect(() => { setVaultExists(Boolean(readOrdiVault())); }, [open]);
  useEffect(() => {
    try { setConnectedToSite(localStorage.getItem(`ordi-wallet-connected:${site}`) === "1"); } catch { setConnectedToSite(false); }
  }, [open, site]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const addresses = useMemo(() => wallet ? ADDRESS_SPECS.map(spec => wallet.addresses[spec.type]) : [], [wallet]);

  async function saveWallet(record: OrdiWalletRecord) {
    const vault = await encryptOrdiWallet(record, password);
    localStorage.setItem("ordi-wallet-v1", JSON.stringify(vault));
    setWallet(record); setMnemonic(""); setPassphrase(""); setPassword(""); setMode("unlock"); setMessage("Coffre chiffré localement. Les clés ne quittent jamais ce navigateur.");
  }
  async function create() {
    setError(""); setMessage("");
    try {
      if (!mnemonic) throw new Error("Générez d’abord une phrase de récupération.");
      if (!password) throw new Error("Choisissez un mot de passe de coffre.");
      await saveWallet(deriveOrdiWallet(mnemonic, passphrase));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Création impossible."); }
  }
  async function importWallet() {
    setError(""); setMessage("");
    try {
      if (!password) throw new Error("Choisissez un mot de passe de coffre.");
      await saveWallet(deriveOrdiWallet(mnemonic, passphrase));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import impossible."); }
  }
  async function unlock() {
    setError("");
    try {
      const vault = readOrdiVault();
      if (!vault) throw new Error("Aucun coffre local trouvé.");
      setWallet(await decryptOrdiWallet(vault, password)); setPassword(""); setMessage("Coffre déverrouillé dans cette session.");
    } catch { setError("Mot de passe incorrect ou coffre illisible."); }
  }
  async function refresh() {
    if (!wallet) return;
    setLoading(true); setError("");
    try {
      const entries = await Promise.all(addresses.map(async item => [item.type, await fetchAddressBalance(network, item.address)] as const));
      setBalances(Object.fromEntries(entries) as Record<AddressType, Balance>);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de charger les soldes."); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (wallet) void refresh(); }, [wallet, network]);
  function toggleSiteConnection() {
    const next = !connectedToSite;
    try { localStorage.setItem(`ordi-wallet-connected:${site}`, next ? "1" : "0"); } catch { /* storage may be unavailable */ }
    setConnectedToSite(next);
    setMessage(next ? "Ordi Wallet est connecté à ce site en lecture seule. Les clés privées restent dans le coffre local." : "Ordi Wallet est déconnecté de ce site.");
  }

  return <>
    <button type="button" onClick={() => { setView("connect"); setOpen(true); }} className="inline-flex min-h-10 items-center gap-2 border border-[#d99a54]/70 bg-[#d99a54]/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63] transition hover:bg-[#d99a54]/20" aria-label="Connecter UniSat au site">
      <Wallet size={15} /> <span>Ordi Wallet</span>{vaultExists && <span className="rounded-full bg-[#70c7a0]/15 px-1.5 py-0.5 text-[8px] text-[#70c7a0]">COFFRE</span>}
    </button>
    {open && createPortal(<div className="fixed inset-0 z-[100] flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-[#050608]/85 p-3 backdrop-blur-sm sm:p-6" onMouseDown={event => event.target === event.currentTarget && setOpen(false)}>
      <section className="my-auto max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl overflow-auto border border-[#3b434d] bg-[#0e1217] shadow-[0_24px_100px_rgba(0,0,0,.65)] sm:max-h-[min(900px,calc(100dvh-3rem))]" role="dialog" aria-modal="true" aria-label="Ordi Wallet">
        <div className="flex items-center justify-between border-b border-[#2c323a] px-4 py-3 sm:px-7">
          <div className="flex items-center gap-3"><img src={`${BASE}assets/brand/ordi-wallet.png`} alt="Ordi Wallet" className="h-9 w-9 object-contain" /><div><p className="font-display text-lg font-semibold text-[#f3efe5]">Ordi Wallet</p><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#718092]">Bitcoin · Fractal · local non-custodial</p></div></div>
          <button type="button" onClick={() => setOpen(false)} className="p-2 text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Fermer"><X size={18} /></button>
        </div>
        <div className="flex gap-1 border-b border-[#2c323a] px-4 pt-3 sm:px-7">
          <button type="button" onClick={() => setView("vault")} className={`border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] ${view === "vault" ? "border-[#d99a54] text-[#f2bd63]" : "border-transparent text-[#718092] hover:text-[#d9d3c6]"}`}>Coffre local</button>
          <button type="button" onClick={() => setView("connect")} className={`border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] ${view === "connect" ? "border-[#70c7a0] text-[#9fe0bd]" : "border-transparent text-[#718092] hover:text-[#d9d3c6]"}`}>UniSat / Site</button>
        </div>
        {view === "connect" ? <div className="p-3 sm:p-6"><UniSatWalletConnect site={site} /></div> : <>
        {!wallet ? <div className="grid gap-5 p-4 sm:p-7 lg:grid-cols-[1.1fr_.9fr]">
          <div className="border border-[#2c323a] bg-[#12171d] p-4 sm:p-6"><div className="mb-5 flex items-center gap-2 text-[#70c7a0]"><ShieldCheck size={18} /><span className="font-mono text-[10px] uppercase tracking-[.15em]">Clés générées localement</span></div>
            {vaultExists && <div className="mb-5 flex gap-1 border-b border-[#2c323a] pb-3"><button onClick={() => setMode("unlock")} className={`px-2 py-2 font-mono text-[10px] uppercase ${mode === "unlock" ? "text-[#f2bd63]" : "text-[#718092]"}`}>Déverrouiller</button><button onClick={() => setMode("create")} className={`px-2 py-2 font-mono text-[10px] uppercase ${mode === "create" ? "text-[#f2bd63]" : "text-[#718092]"}`}>Nouveau</button><button onClick={() => setMode("import")} className={`px-2 py-2 font-mono text-[10px] uppercase ${mode === "import" ? "text-[#f2bd63]" : "text-[#718092]"}`}>Importer</button></div>}
            {mode === "unlock" ? <><p className="mb-3 text-sm text-[#d9d3c6]">Le coffre est partagé par les deux sites sur la même origine.</p><input className="w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-sm text-[#f3efe5]" type="password" placeholder="Mot de passe du coffre" value={password} onChange={event => setPassword(event.target.value)} /><button onClick={() => void unlock()} className="mt-3 inline-flex min-h-11 items-center gap-2 bg-[#d99a54] px-4 font-mono text-[10px] uppercase tracking-[.12em] text-[#0b0d10]"><LockKeyhole size={15} /> Déverrouiller</button></> : <>
              {mode === "create" && <div className="mb-4"><label className="font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Longueur de la phrase</label><div className="mt-2 flex gap-2"><button onClick={() => { setWords(12); setMnemonic(""); }} className={`border px-3 py-2 font-mono text-[10px] ${words === 12 ? "border-[#d99a54] text-[#f2bd63]" : "border-[#3b434d] text-[#9ea7b3]"}`}>12 mots</button><button onClick={() => { setWords(24); setMnemonic(""); }} className={`border px-3 py-2 font-mono text-[10px] ${words === 24 ? "border-[#d99a54] text-[#f2bd63]" : "border-[#3b434d] text-[#9ea7b3]"}`}>24 mots</button></div></div>}
              <textarea className="min-h-24 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-xs leading-6 text-[#f3efe5]" placeholder={mode === "create" ? "Cliquez sur Générer pour créer votre phrase" : "Entrez votre phrase BIP39 en anglais"} value={mnemonic} onChange={event => setMnemonic(event.target.value)} />
              {mode === "create" && <button onClick={() => setMnemonic(createMnemonic(words))} className="mt-2 border border-[#d99a54]/60 px-3 py-2 font-mono text-[10px] uppercase text-[#f2bd63]" >Générer une phrase {words} mots</button>}
              <input className="mt-4 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-sm text-[#f3efe5]" placeholder="Passphrase BIP39 (optionnelle)" value={passphrase} onChange={event => setPassphrase(event.target.value)} />
              <input className="mt-3 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-sm text-[#f3efe5]" type="password" placeholder="Mot de passe du coffre · 10 caractères minimum" value={password} onChange={event => setPassword(event.target.value)} />
              <button onClick={() => void (mode === "create" ? create() : importWallet())} className="mt-3 min-h-11 bg-[#d99a54] px-4 font-mono text-[10px] uppercase tracking-[.12em] text-[#0b0d10]">{mode === "create" ? "Créer Ordi Wallet" : "Importer dans le coffre"}</button>
            </>}
            {error && <p className="mt-4 border border-[#a45e54]/50 bg-[#a45e54]/10 p-3 font-mono text-[10px] text-[#e6a69b]">{error}</p>}
            {message && <p className="mt-4 border border-[#70c7a0]/40 bg-[#70c7a0]/10 p-3 font-mono text-[10px] text-[#9fe0bd]">{message}</p>}
          </div>
          <div className="border border-[#2c323a] bg-[#0b0f13] p-4 sm:p-6"><h3 className="font-display text-xl text-[#f3efe5]">Sécurité Ordi Wallet</h3><ul className="mt-4 space-y-3 font-mono text-[10px] leading-5 text-[#9ea7b3]"><li>• BIP39 + BIP32 : standards déterministes interopérables.</li><li>• AES-256-GCM + PBKDF2 : le coffre local est chiffré avant stockage.</li><li>• Aucun seed, mot de passe ou clé privée n’est envoyé à UniSat, Mempool ou au serveur du site.</li><li>• Toujours sauvegarder la phrase hors ligne avant de fermer cette fenêtre.</li><li>• Les adresses sont affichées pour Bitcoin et Fractal ; les réseaux sont séparés au niveau des soldes et des explorateurs.</li></ul></div>
        </div> : <div className="p-4 sm:p-7">
          <div className="flex flex-col gap-4 border-b border-[#2c323a] pb-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#70c7a0]">Coffre déverrouillé en mémoire</p><h2 className="mt-1 font-display text-2xl text-[#f3efe5]">Dashboard Ordi Wallet</h2><p className="mt-1 font-mono text-[9px] text-[#718092]">Site actif : {site === "punks" ? "Ordinal Punks" : "Fractal Pokédex"}</p></div><div className="flex flex-wrap items-center gap-2"><button type="button" onClick={toggleSiteConnection} className={`border px-3 py-2 font-mono text-[9px] uppercase tracking-[.1em] ${connectedToSite ? "border-[#70c7a0] bg-[#70c7a0]/10 text-[#9fe0bd]" : "border-[#d99a54] text-[#f2bd63]"}`}>{connectedToSite ? "Wallet connecté au site" : "Connecter au site"}</button><select className="border border-[#3b434d] bg-[#0b0f13] px-3 py-2 font-mono text-[10px] text-[#f3efe5]" value={network} onChange={event => setNetwork(event.target.value as OrdiNetwork)}>{NETWORKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button onClick={() => void refresh()} className="border border-[#3b434d] p-2 text-[#f2bd63]" aria-label="Actualiser les soldes"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button></div></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{addresses.map(item => <article key={item.type} className="border border-[#2c323a] bg-[#12171d] p-4"><div className="flex items-start justify-between gap-2"><div><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63]">{item.label}</p><p className="mt-2 break-all font-mono text-[10px] text-[#d9d3c6]">{short(item.address)}</p></div><button onClick={() => copy(item.address)} className="text-[#9ea7b3] hover:text-[#f2bd63]" aria-label="Copier l’adresse"><Copy size={13} /></button></div><p className="mt-4 font-display text-xl text-[#f3efe5]">{formatSats(balances[item.type]?.total ?? null)}</p><p className="mt-1 font-mono text-[9px] text-[#718092]">Confirmé {formatSats(balances[item.type]?.confirmed ?? null)}</p><details className="mt-4 border-t border-[#2c323a] pt-3"><summary className="cursor-pointer font-mono text-[9px] uppercase text-[#718092]">Clés avancées</summary><p className="mt-2 break-all font-mono text-[9px] text-[#718092]">Path: {item.path}</p><button onClick={() => setReveal(value => ({ ...value, [item.type]: !value[item.type] }))} className="mt-2 inline-flex items-center gap-1 font-mono text-[9px] uppercase text-[#e6a69b]">{reveal[item.type] ? <EyeOff size={12} /> : <Eye size={12} />}{reveal[item.type] ? "Masquer la clé privée" : "Afficher la clé privée"}</button>{reveal[item.type] && <><p className="mt-2 break-all border border-[#a45e54]/50 bg-[#a45e54]/10 p-2 font-mono text-[9px] text-[#e6a69b]">{item.privateKey}</p><button onClick={() => copy(item.privateKey)} className="mt-2 font-mono text-[9px] uppercase text-[#f2bd63]">Copier la clé privée</button></>}</details></article>)}</div>
          {connectedToSite && <div className="mt-5 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-4"><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#9fe0bd]">Connexion active · lecture seule</p><p className="mt-2 font-mono text-[10px] leading-5 text-[#d9d3c6]">Le site utilise l’adresse Native SegWit du coffre pour afficher les soldes live. Aucune clé privée n’est exposée. Les transferts restent désactivés pour ce coffre local tant qu’une confirmation de signature dédiée n’est pas disponible.</p><ProtocolAssetsPanel address={wallet.addresses["native-segwit"].address} network={network} site={site} /></div>}
          <div className="mt-5 grid gap-3 lg:grid-cols-2"><div className="border border-[#2c323a] bg-[#12171d] p-4"><p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Phrase de récupération</p><p className="mt-2 break-words font-mono text-xs leading-6 text-[#d9d3c6]">{reveal.mnemonic ? wallet.mnemonic : "•••••••• •••••••• •••••••• ••••••••"}</p><button onClick={() => setReveal(value => ({ ...value, mnemonic: !value.mnemonic }))} className="mt-3 inline-flex items-center gap-1 font-mono text-[9px] uppercase text-[#f2bd63]">{reveal.mnemonic ? <EyeOff size={12} /> : <Eye size={12} />} {reveal.mnemonic ? "Masquer" : "Afficher"}</button>{reveal.mnemonic && <button onClick={() => copy(wallet.mnemonic)} className="ml-3 font-mono text-[9px] uppercase text-[#f2bd63]">Copier</button>}</div><div className="border border-[#70c7a0]/30 bg-[#70c7a0]/5 p-4 font-mono text-[10px] leading-5 text-[#9fe0bd]">Lecture des soldes via les endpoints publics Mempool. Les signatures et les broadcasts restent soumis à une confirmation explicite ; Ordi Wallet ne délègue jamais une clé privée à un serveur.</div></div>
        </div>}
        </>}
      </section>
    </div>, document.body)}
  </>;
}
