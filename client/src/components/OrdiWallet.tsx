import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Eye, EyeOff, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Wallet, X } from "lucide-react";
import { UniSatWalletConnect } from "@/components/UniSatWalletConnect";
import { ProtocolAssetsPanel } from "@/components/ProtocolAssetsPanel";
import { ProtocolTransferCenter } from "@/components/ProtocolTransferCenter";
import { LocalPsbtSignerPanel } from "@/components/LocalPsbtSignerPanel";
import {
  ADDRESS_SPECS,
  createMnemonic,
  decryptOrdiWallet,
  deriveOrdiWallet,
  encryptOrdiWallet,
  fetchAddressBalance,
  formatSats,
  readOrdiVault,
  type AddressType,
  type OrdiNetwork,
  type OrdiWalletRecord,
} from "@/lib/ordi-wallet";
import { createLocalVaultSiteSession, isWalletExtensionContext, LOCAL_VAULT_SESSION_EVENT, publishLocalVaultSiteSession, readLocalVaultSiteSession, type LocalVaultSiteSession } from "@/lib/local-vault-bridge";

const BASE = import.meta.env.BASE_URL;
const NETWORKS: Array<{ id: OrdiNetwork; label: string }> = [
  { id: "BITCOIN_MAINNET", label: "Bitcoin mainnet" },
  { id: "FRACTAL_BITCOIN_MAINNET", label: "Fractal Bitcoin mainnet" },
];

type Balance = { confirmed: number; unconfirmed: number; total: number } | null;

function copy(value: string) {
  void navigator.clipboard?.writeText(value);
}

function short(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

const inputClass = "min-h-12 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm";
const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 px-4 py-2 font-mono text-[10px] uppercase tracking-[.12em]";

export function OrdiWallet({ site = "pokedex" }: { site?: "punks" | "pokedex" } = {}) {
  const extensionContext = isWalletExtensionContext();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"vault" | "connect">("vault");
  const [connectedToSite, setConnectedToSite] = useState(false);
  const [wallet, setWallet] = useState<OrdiWalletRecord | null>(null);
  const [vaultExists, setVaultExists] = useState(false);
  const [mode, setMode] = useState<"create" | "import" | "unlock">("create");
  const [words, setWords] = useState<12 | 24>(12);
  const [mnemonic, setMnemonic] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState<OrdiNetwork>("BITCOIN_MAINNET");
  const [activeAddressType, setActiveAddressType] = useState<AddressType>("native-segwit");
  const [balances, setBalances] = useState<Record<AddressType, Balance>>({} as Record<AddressType, Balance>);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setVaultExists(Boolean(readOrdiVault()));
  }, [open]);

  useEffect(() => {
    try {
      setConnectedToSite(Boolean(readLocalVaultSiteSession(site)));
    } catch {
      setConnectedToSite(false);
    }
  }, [open, site]);

  useEffect(() => {
    const sync = (event?: Event) => {
      const detail = event ? (event as CustomEvent<LocalVaultSiteSession | null>).detail : undefined;
      setConnectedToSite(Boolean(detail?.site === site ? detail : readLocalVaultSiteSession(site)));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === `ordi-wallet-site-session:${site}`) sync();
    };
    window.addEventListener(LOCAL_VAULT_SESSION_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LOCAL_VAULT_SESSION_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [site]);

  const lockWallet = () => {
    setWallet(null);
    setReveal({});
    setMnemonic("");
    setPassphrase("");
    setPassword("");
    setMode("unlock");
    setError("");
    setMessage("Wallet locked. The encrypted vault remains stored in this browser.");
  };

  const closeWallet = () => {
    lockWallet();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWallet();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const addresses = useMemo(() => (wallet ? ADDRESS_SPECS.map(spec => wallet.addresses[spec.type]) : []), [wallet]);

  async function saveWallet(record: OrdiWalletRecord) {
    const vault = await encryptOrdiWallet(record, password);
    localStorage.setItem("ordi-wallet-v1", JSON.stringify(vault));
    setVaultExists(true);
    setWallet(record);
    setMnemonic("");
    setPassphrase("");
    setPassword("");
    setMode("unlock");
    setMessage("Encrypted locally. Your keys never leave this browser.");
  }

  async function create() {
    setError("");
    setMessage("");
    try {
      if (!mnemonic) throw new Error("Generate a recovery phrase first.");
      if (!password) throw new Error("Choose a vault password.");
      await saveWallet(deriveOrdiWallet(mnemonic, passphrase));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet creation failed.");
    }
  }

  async function importWallet() {
    setError("");
    setMessage("");
    try {
      if (!password) throw new Error("Choose a vault password.");
      await saveWallet(deriveOrdiWallet(mnemonic, passphrase));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet import failed.");
    }
  }

  async function unlock() {
    setError("");
    try {
      const vault = readOrdiVault();
      if (!vault) throw new Error("No local vault was found.");
      setWallet(await decryptOrdiWallet(vault, password));
      setPassword("");
      setMessage("Vault unlocked for this session.");
    } catch {
      setError("Incorrect password or unreadable vault.");
    }
  }

  async function refresh() {
    if (!wallet) return;
    setLoading(true);
    setError("");
    try {
      const entries = await Promise.all(addresses.map(async item => [item.type, await fetchAddressBalance(network, item.address)] as const));
      setBalances(Object.fromEntries(entries) as Record<AddressType, Balance>);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load balances.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (wallet) void refresh();
  }, [wallet, network]);

  useEffect(() => {
    if (!wallet || !connectedToSite) return;
    publishLocalVaultSiteSession(createLocalVaultSiteSession({ wallet, site, network, activeAddressType }));
  }, [wallet, connectedToSite, network, activeAddressType, site]);

  function toggleSiteConnection() {
    if (!wallet) {
      setError("Unlock the local vault before connecting it to this site.");
      return;
    }
    const next = !connectedToSite;
    try {
      localStorage.setItem(`ordi-wallet-connected:${site}`, next ? "1" : "0");
    } catch {
      // Browser storage may be unavailable.
    }
    if (next) {
      publishLocalVaultSiteSession(createLocalVaultSiteSession({ wallet, site, network, activeAddressType }));
    } else {
      publishLocalVaultSiteSession(null, site);
    }
    setConnectedToSite(next);
    setMessage(next
      ? extensionContext
        ? "Local Vault enabled in this extension only. Browser extensions have separate storage from websites; import the same recovery phrase into the target site’s Local Vault to use it there."
        : "Local Vault linked to this site: only the selected network and public addresses are shared. Private keys stay in the encrypted vault; UniSat remains a separate signing provider."
      : "Ordi Wallet is disconnected from this site.");
  }

  function openWallet() {
    setView("vault");
    setMode(readOrdiVault() ? "unlock" : "create");
    setError("");
    setMessage("");
    setOpen(true);
  }

  useEffect(() => {
    const onOpen = () => openWallet();
    window.addEventListener("ordi-wallet:open", onOpen);
    return () => window.removeEventListener("ordi-wallet:open", onOpen);
  }, [site]);

  return <>
    <button type="button" onClick={openWallet} className="inline-flex min-h-11 items-center gap-2 border border-[#d99a54]/70 bg-[#d99a54]/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63] transition hover:bg-[#d99a54]/20" aria-label="Open Ordi Wallet">
      <Wallet size={15} /> <span>Ordi Wallet</span>{vaultExists && <span className="rounded-full bg-[#70c7a0]/15 px-1.5 py-0.5 text-[8px] text-[#70c7a0]">VAULT</span>}
    </button>
    {!window.location.protocol.includes("extension") && <a href={`${BASE}extension-install.html`} target="_blank" rel="noreferrer" className="hidden min-h-11 items-center border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6] hover:border-[#d99a54] hover:text-[#f2bd63] md:inline-flex" title="Install the desktop browser extension preview">Add extension</a>}
    {open && createPortal(
      <div className="fixed inset-0 z-[100] flex min-h-[100dvh] items-stretch justify-start overflow-y-auto bg-[#050608]/90 p-0 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6" onMouseDown={event => event.target === event.currentTarget && closeWallet()}>
        <section className="flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden border border-[#3b434d] bg-[#0e1217] shadow-[0_24px_100px_rgba(0,0,0,.65)] sm:my-auto sm:h-auto sm:max-h-[min(900px,calc(100dvh-3rem))] sm:max-w-6xl" role="dialog" aria-modal="true" aria-label="Ordi Wallet">
          <header className="flex shrink-0 items-center justify-between border-b border-[#2c323a] px-4 py-3 sm:px-7">
            <div className="flex min-w-0 items-center gap-3"><img src={`${BASE}assets/brand/ordi-wallet.png`} alt="" className="h-9 w-9 shrink-0 object-contain" /><div className="min-w-0"><p className="font-display text-lg font-semibold text-[#f3efe5]">Ordi Wallet</p><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#718092]">Bitcoin · Fractal · local non-custodial</p></div></div>
            <button type="button" onClick={closeWallet} className="ml-2 flex min-h-11 min-w-11 items-center justify-center text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Close wallet"><X size={18} /></button>
          </header>
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#2c323a] px-4 pt-2 sm:px-7" aria-label="Wallet sections">
            <button type="button" onClick={() => setView("vault")} className={`min-h-11 shrink-0 border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] ${view === "vault" ? "border-[#d99a54] text-[#f2bd63]" : "border-transparent text-[#718092] hover:text-[#d9d3c6]"}`}>Local Vault</button>
            <button type="button" onClick={() => setView("connect")} className={`min-h-11 shrink-0 border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] ${view === "connect" ? "border-[#70c7a0] text-[#9fe0bd]" : "border-transparent text-[#718092] hover:text-[#d9d3c6]"}`}>UniSat / Site</button>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]">
            {view === "connect" ? <div className="p-3 sm:p-6"><UniSatWalletConnect site={site} /></div> : <>
              {!wallet ? <div className="grid gap-4 p-3 sm:gap-5 sm:p-7 lg:grid-cols-[1.1fr_.9fr]">
                <div className="min-w-0 border border-[#2c323a] bg-[#12171d] p-4 sm:p-6">
                  <div className="mb-5 flex items-center gap-2 text-[#70c7a0]"><ShieldCheck size={18} /><span className="font-mono text-[10px] uppercase tracking-[.15em]">Keys generated locally</span></div>
                  <div className="mb-5 flex gap-1 overflow-x-auto border-b border-[#2c323a] pb-3">
                    {(["unlock", "create", "import"] as const).map(item => <button key={item} type="button" onClick={() => { setMode(item); setError(""); setMessage(""); }} className={`min-h-11 shrink-0 px-3 py-2 font-mono text-[10px] uppercase ${mode === item ? "text-[#f2bd63]" : "text-[#718092]"}`}>{item === "unlock" ? "Unlock" : item === "create" ? "New wallet" : "Import"}</button>)}
                  </div>
                  {mode === "unlock" ? <>
                    <p className="mb-3 text-sm leading-6 text-[#d9d3c6]">This encrypted vault is stored locally in this browser and site origin.</p>
                    <input className={inputClass} type="password" autoComplete="current-password" placeholder="Vault password" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => event.key === "Enter" && void unlock()} />
                    <button type="button" onClick={() => void unlock()} className={`${buttonClass} mt-3 w-full bg-[#d99a54] text-[#0b0d10] sm:w-auto`}><LockKeyhole size={15} /> Unlock wallet</button>
                  </> : <>
                    {mode === "create" && <div className="mb-4"><label className="font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Recovery phrase length</label><div className="mt-2 flex gap-2">
                      {([12, 24] as const).map(count => <button key={count} type="button" onClick={() => { setWords(count); setMnemonic(""); }} className={`min-h-11 flex-1 border px-3 py-2 font-mono text-[10px] sm:flex-none ${words === count ? "border-[#d99a54] text-[#f2bd63]" : "border-[#3b434d] text-[#9ea7b3]"}`}>{count} words</button>)}
                    </div></div>}
                    <label className="sr-only" htmlFor="ordi-mnemonic">Recovery phrase</label>
                    <textarea id="ordi-mnemonic" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="min-h-28 w-full resize-y border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base leading-6 text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" placeholder={mode === "create" ? "Generate a recovery phrase or enter one" : "Enter your BIP39 recovery phrase in English"} value={mnemonic} onChange={event => setMnemonic(event.target.value)} />
                    {mode === "create" && <button type="button" onClick={() => setMnemonic(createMnemonic(words))} className={`${buttonClass} mt-2 w-full border border-[#d99a54]/60 text-[#f2bd63] sm:w-auto`}>Generate {words}-word phrase</button>}
                    <label className="sr-only" htmlFor="ordi-passphrase">Optional BIP39 passphrase</label>
                    <input id="ordi-passphrase" autoCapitalize="none" autoCorrect="off" className={`${inputClass} mt-4`} placeholder="Optional BIP39 passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} />
                    <label className="sr-only" htmlFor="ordi-password">Vault password</label>
                    <input id="ordi-password" autoComplete="new-password" className={`${inputClass} mt-3`} type="password" placeholder="Vault password · at least 10 characters" value={password} onChange={event => setPassword(event.target.value)} />
                    <button type="button" onClick={() => void (mode === "create" ? create() : importWallet())} className={`${buttonClass} mt-3 w-full bg-[#d99a54] text-[#0b0d10] sm:w-auto`}>{mode === "create" ? "Create Ordi Wallet" : "Import into vault"}</button>
                  </>}
                  {error && <p className="mt-4 break-words border border-[#a45e54]/50 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
                  {message && <p className="mt-4 break-words border border-[#70c7a0]/40 bg-[#70c7a0]/10 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
                </div>
                <aside className="border border-[#2c323a] bg-[#0b0f13] p-4 sm:p-6"><h3 className="font-display text-xl text-[#f3efe5]">Ordi Wallet security</h3><ul className="mt-4 space-y-3 font-mono text-[10px] leading-5 text-[#9ea7b3]"><li>• BIP39 + BIP32: interoperable wallet standards.</li><li>• AES-256-GCM + PBKDF2: the local vault is encrypted before storage.</li><li>• Your recovery phrase, password, and private keys are not sent to UniSat, Mempool, or the site server.</li><li>• Back up your recovery phrase offline before closing this wallet.</li><li>• Bitcoin and Fractal balances are queried separately.</li></ul></aside>
              </div> : <div className="p-3 sm:p-7">
                <div className="flex flex-col gap-4 border-b border-[#2c323a] pb-5 sm:flex-row sm:items-center sm:justify-between">
                  <div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#70c7a0]">Vault unlocked in memory</p><h2 className="mt-1 font-display text-2xl text-[#f3efe5]">Ordi Wallet dashboard</h2><p className="mt-1 font-mono text-[9px] text-[#718092]">{extensionContext ? "Extension vault · isolated from website storage" : `Active site: ${site === "punks" ? "Ordinal Punks" : "Fractal Pokédex"}`}</p></div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                    <button type="button" onClick={toggleSiteConnection} className={`col-span-2 ${buttonClass} border px-3 text-[9px] tracking-[.1em] sm:col-span-1 ${connectedToSite ? "border-[#70c7a0] bg-[#70c7a0]/10 text-[#9fe0bd]" : "border-[#d99a54] text-[#f2bd63]"}`}>{connectedToSite ? extensionContext ? "Enabled in extension" : "Connected to site" : extensionContext ? "Enable in extension" : "Connect local vault"}</button>
                    <select aria-label="Select network" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#0b0f13] px-2 font-mono text-[10px] text-[#f3efe5] sm:px-3" value={network} onChange={event => setNetwork(event.target.value as OrdiNetwork)}>{NETWORKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                    <select aria-label="Select address type" className="min-h-11 min-w-0 border border-[#3b434d] bg-[#0b0f13] px-2 font-mono text-[10px] text-[#f3efe5] sm:px-3" value={activeAddressType} onChange={event => setActiveAddressType(event.target.value as AddressType)}>{ADDRESS_SPECS.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}</select>
                    <button type="button" onClick={() => void refresh()} className="flex min-h-11 items-center justify-center border border-[#3b434d] px-3 text-[#f2bd63]" aria-label="Refresh balances"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button>
                    <button type="button" onClick={lockWallet} className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 border border-[#a45e54]/60 px-3 font-mono text-[9px] uppercase tracking-[.1em] text-[#e6a69b] sm:col-span-1"><LogOut size={13} /> Lock wallet</button>
                  </div>
                </div>
                {error && <p className="mt-4 break-words border border-[#a45e54]/50 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
                <div className="mt-4 grid min-w-0 gap-3 sm:mt-5 sm:grid-cols-2 xl:grid-cols-4">{addresses.map(item => <article key={item.type} className="min-w-0 border border-[#2c323a] bg-[#12171d] p-4">
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63]">{item.label}</p><p className="mt-2 break-all font-mono text-[10px] text-[#d9d3c6]">{short(item.address)}</p></div><button type="button" onClick={() => copy(item.address)} className="flex min-h-10 min-w-10 shrink-0 items-center justify-center text-[#9ea7b3] hover:text-[#f2bd63]" aria-label="Copy address"><Copy size={15} /></button></div>
                  <p className="mt-3 font-display text-xl text-[#f3efe5]">{formatSats(balances[item.type]?.total ?? null)}</p><p className="mt-1 font-mono text-[9px] text-[#718092]">Confirmed {formatSats(balances[item.type]?.confirmed ?? null)}</p>
                  <details className="mt-4 border-t border-[#2c323a] pt-3"><summary className="min-h-10 cursor-pointer py-2 font-mono text-[9px] uppercase text-[#718092]">Advanced keys</summary><p className="mt-2 break-all font-mono text-[9px] text-[#718092]">Derivation path: {item.path}</p><button type="button" onClick={() => setReveal(value => ({ ...value, [item.type]: !value[item.type] }))} className="mt-2 inline-flex min-h-10 items-center gap-1 font-mono text-[9px] uppercase text-[#e6a69b]">{reveal[item.type] ? <EyeOff size={12} /> : <Eye size={12} />}{reveal[item.type] ? "Hide private key" : "Reveal private key"}</button>{reveal[item.type] && <><p className="mt-2 break-all border border-[#a45e54]/50 bg-[#a45e54]/10 p-2 font-mono text-[9px] text-[#e6a69b]">{item.privateKey}</p><button type="button" onClick={() => copy(item.privateKey)} className="mt-2 min-h-10 font-mono text-[9px] uppercase text-[#f2bd63]">Copy private key</button></>}</details>
                </article>)}</div>
                {connectedToSite && <div className="mt-4 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 sm:mt-5 sm:p-4"><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#9fe0bd]">{extensionContext ? "Local vault enabled in this extension only" : "Local vault connected to this site"}</p><p className="mt-2 break-all font-mono text-[10px] leading-5 text-[#d9d3c6]">{ADDRESS_SPECS.find(item => item.type === activeAddressType)?.label} address: {wallet.addresses[activeAddressType].address}</p><p className="mt-2 font-mono text-[10px] leading-5 text-[#d9d3c6]">{extensionContext ? "Extension storage is isolated from website origins. Import this recovery phrase separately into the target site’s Local Vault; no keys are shared across origins." : "Only the selected network and public addresses are shared with this page. Private keys remain in the unlocked vault; transaction signing still requires a separate review."}</p><ProtocolAssetsPanel address={wallet.addresses[activeAddressType].address} network={network} site={site} /><ProtocolTransferCenter network={network} /></div>}
                {connectedToSite && <LocalPsbtSignerPanel wallet={wallet} network={network} />}
                <div className="mt-4 grid gap-3 sm:mt-5 lg:grid-cols-2"><div className="min-w-0 border border-[#2c323a] bg-[#12171d] p-4"><p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Recovery phrase</p><p className="mt-2 break-words font-mono text-xs leading-6 text-[#d9d3c6]">{reveal.mnemonic ? wallet.mnemonic : "•••••••• •••••••• •••••••• ••••••••"}</p><button type="button" onClick={() => setReveal(value => ({ ...value, mnemonic: !value.mnemonic }))} className="mt-2 inline-flex min-h-10 items-center gap-1 font-mono text-[9px] uppercase text-[#f2bd63]">{reveal.mnemonic ? <EyeOff size={12} /> : <Eye size={12} />} {reveal.mnemonic ? "Hide" : "Reveal"}</button>{reveal.mnemonic && <button type="button" onClick={() => copy(wallet.mnemonic)} className="ml-3 min-h-10 font-mono text-[9px] uppercase text-[#f2bd63]">Copy</button>}</div><div className="border border-[#70c7a0]/30 bg-[#70c7a0]/5 p-4 font-mono text-[10px] leading-5 text-[#9fe0bd]">Balances are fetched from public Mempool endpoints. Signing happens locally after explicit review; Ordi Wallet never sends a private key to a server.</div></div>
              </div>}
            </>}
          </div>
        </section>
      </div>, document.body)}
  </>;
}
