import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, Eye, EyeOff, LockKeyhole, LogOut, QrCode, RefreshCw, ShieldCheck, Wallet, X } from "lucide-react";
import { UniSatWalletConnect } from "@/components/UniSatWalletConnect";
import { LocalPsbtSignerPanel } from "@/components/LocalPsbtSignerPanel";
import { LocalNativeTransferPanel } from "@/components/LocalNativeTransferPanel";
import { LocalVaultAssetPanel } from "@/components/LocalVaultAssetPanel";
import { LocalVaultPortfolioPanel } from "@/components/LocalVaultPortfolioPanel";
import {
  ADDRESS_SPECS,
  createMnemonic,
  decryptOrdiWallet,
  deriveOrdiWallet,
  encryptOrdiWallet,
  fetchAddressBalance,
  readOrdiVault,
  type AddressType,
  type OrdiNetwork,
  type OrdiWalletRecord,
} from "@/lib/ordi-wallet";
import { createLocalVaultSiteSession, isWalletExtensionContext, LOCAL_VAULT_SESSION_EVENT, publishLocalVaultSiteSession, readLocalVaultSiteSession, type LocalVaultSiteSession } from "@/lib/local-vault-bridge";
import { formatSatsAsAsset } from "@/lib/bitcoin-units";

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

function qrUrl(value: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(value)}`;
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
  const [balances, setBalances] = useState<Record<OrdiNetwork, Partial<Record<AddressType, Balance>>>>({ BITCOIN_MAINNET: {}, FRACTAL_BITCOIN_MAINNET: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [showReceiveQr, setShowReceiveQr] = useState<Partial<Record<AddressType, boolean>>>({ legacy: true, "nested-segwit": true, "native-segwit": true, taproot: true });

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
    const networks: OrdiNetwork[] = ["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"];
    const checks = await Promise.all(networks.flatMap(chain => addresses.map(async item => ({
      network: chain,
      type: item.type,
      result: await Promise.allSettled([fetchAddressBalance(chain, item.address)]).then(([result]) => result),
    }))));
    const next: Record<OrdiNetwork, Partial<Record<AddressType, Balance>>> = {
      BITCOIN_MAINNET: {},
      FRACTAL_BITCOIN_MAINNET: {},
    };
    const failures: string[] = [];
    for (const check of checks) {
      if (check.result.status === "fulfilled") {
        next[check.network][check.type] = check.result.value;
      } else {
        next[check.network][check.type] = null;
        const networkLabel = check.network === "BITCOIN_MAINNET" ? "BTC" : "FB";
        const addressLabel = ADDRESS_SPECS.find(spec => spec.type === check.type)?.label ?? check.type;
        failures.push(`${networkLabel} / ${addressLabel}`);
      }
    }
    setBalances(next);
    if (failures.length) {
      setError(`Scan partiel : solde indisponible pour ${failures.join(", ")}. Ces résultats ne sont pas considérés comme 0 sats; relancez le scan après vérification de l’indexeur.`);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (wallet) void refresh();
  }, [wallet]);

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
    {!window.location.protocol.includes("extension") && <a href={`${BASE}extension-install.html`} target="_blank" rel="noreferrer" aria-label="Add Ordi Wallet desktop extension" className="inline-flex min-h-11 w-11 shrink-0 items-center justify-center border border-[#3b434d] font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6] hover:border-[#d99a54] hover:text-[#f2bd63] sm:w-auto sm:gap-2 sm:px-3 sm:py-2" title="Desktop browser extension preview — not installable in most mobile browsers"><Download size={14} /><span className="hidden sm:inline">Add extension</span></a>}
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
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63]">{item.label}</p><p className="mt-2 break-all font-mono text-[10px] text-[#d9d3c6]">{short(item.address)}</p></div><button type="button" onClick={() => copy(item.address)} className="flex min-h-10 min-w-10 shrink-0 items-center justify-center text-[#9ea7b3] hover:text-[#f2bd63]" aria-label="Copy address"><Copy size={15} /></button><button type="button" onClick={() => setShowReceiveQr(current => ({ ...current, [item.type]: !current[item.type] }))} className="flex min-h-10 min-w-10 shrink-0 items-center justify-center text-[#9ea7b3] hover:text-[#f2bd63]" aria-label={`Show receive QR for ${item.label}`} aria-expanded={Boolean(showReceiveQr[item.type])}><QrCode size={15} /></button></div>{showReceiveQr[item.type] && <div className="mt-3 border border-[#2c323a] bg-white p-3"><img src={qrUrl(item.address)} alt={`${item.label} receive address QR code`} width="180" height="180" loading="eager" onError={event => { const image = event.currentTarget; if (image.dataset.qrFallback !== "used") { image.dataset.qrFallback = "used"; image.src = `https://chart.googleapis.com/chart?cht=qr&chs=180x180&chld=M|1&chl=${encodeURIComponent(item.address)}`; } }} className="mx-auto h-[180px] w-[180px]" /><p className="mt-2 break-all text-center font-mono text-[9px] text-[#0b0f13]">Receive on {network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}</p></div>}
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="border border-[#2c323a] bg-[#0b0f13] p-2">
                      <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#9fe0bd]">Bitcoin · BTC</p>
                      <p className="mt-1 font-display text-lg text-[#f3efe5]">{formatSatsAsAsset(balances.BITCOIN_MAINNET[item.type]?.total ?? null, "BTC")}</p>
                      <p className="mt-1 font-mono text-[9px] text-[#718092]">Confirmé {formatSatsAsAsset(balances.BITCOIN_MAINNET[item.type]?.confirmed ?? null, "BTC")} · Mempool {formatSatsAsAsset(balances.BITCOIN_MAINNET[item.type]?.unconfirmed ?? null, "BTC")}</p>
                    </div>
                    <div className="border border-[#2c323a] bg-[#0b0f13] p-2">
                      <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63]">Fractal Bitcoin · FB</p>
                      <p className="mt-1 font-display text-lg text-[#f3efe5]">{formatSatsAsAsset(balances.FRACTAL_BITCOIN_MAINNET[item.type]?.total ?? null, "FB")}</p>
                      <p className="mt-1 font-mono text-[9px] text-[#718092]">Confirmé {formatSatsAsAsset(balances.FRACTAL_BITCOIN_MAINNET[item.type]?.confirmed ?? null, "FB")} · Mempool {formatSatsAsAsset(balances.FRACTAL_BITCOIN_MAINNET[item.type]?.unconfirmed ?? null, "FB")}</p>
                    </div>
                  </div>
                  <details className="mt-4 border-t border-[#2c323a] pt-3"><summary className="min-h-10 cursor-pointer py-2 font-mono text-[9px] uppercase text-[#718092]">Advanced keys</summary><p className="mt-2 break-all font-mono text-[9px] text-[#718092]">Derivation path: {item.path}</p><button type="button" onClick={() => setReveal(value => ({ ...value, [item.type]: !value[item.type] }))} className="mt-2 inline-flex min-h-10 items-center gap-1 font-mono text-[9px] uppercase text-[#e6a69b]">{reveal[item.type] ? <EyeOff size={12} /> : <Eye size={12} />}{reveal[item.type] ? "Hide private key" : "Reveal private key"}</button>{reveal[item.type] && <><p className="mt-2 break-all border border-[#a45e54]/50 bg-[#a45e54]/10 p-2 font-mono text-[9px] text-[#e6a69b]">{item.privateKey}</p><button type="button" onClick={() => copy(item.privateKey)} className="mt-2 min-h-10 font-mono text-[9px] uppercase text-[#f2bd63]">Copy private key</button></>}</details>
                </article>)}</div>
                <LocalVaultPortfolioPanel addresses={wallet.addresses} network={network} />
                <LocalVaultAssetPanel address={wallet.addresses[activeAddressType].address} network={network} site={site} wallet={wallet} addressType={activeAddressType} />
                {connectedToSite && <div className="mt-4 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 sm:mt-5 sm:p-4"><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#9fe0bd]">{extensionContext ? "Local vault enabled in this extension only" : "Local vault connected to this site"}</p><p className="mt-2 break-all font-mono text-[10px] leading-5 text-[#d9d3c6]">{ADDRESS_SPECS.find(item => item.type === activeAddressType)?.label} address: {wallet.addresses[activeAddressType].address}</p><p className="mt-2 font-mono text-[10px] leading-5 text-[#d9d3c6]">{extensionContext ? "Extension storage is isolated from website origins. Import this recovery phrase separately into the target site’s Local Vault; no keys are shared across origins." : "Only the selected network and public addresses are shared with this page. Private keys remain in the unlocked vault; transaction signing still requires a separate review."}</p><div className="mt-3 border border-[#2c323a] bg-[#0b0f13] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]"><p className="uppercase tracking-[.12em] text-[#9fe0bd]">Local signing only · no UniSat fallback</p><p className="mt-1">Available locally: native BTC/FB, single Ordinal inscriptions (including an already-created BRC-20 transfer inscription), and Rune Runestones after exact review. Alkanes and BRC20-Prog remain blocked until their dedicated local protocol builders and tests are complete.</p></div></div>}
                <LocalNativeTransferPanel wallet={wallet} network={network} addressType={activeAddressType} onAddressTypeChange={setActiveAddressType} site={site} onDone={() => void refresh()} />
                {connectedToSite && <LocalPsbtSignerPanel wallet={wallet} network={network} site={site} initialAddressType={activeAddressType} />}
                <div className="mt-4 grid gap-3 sm:mt-5 lg:grid-cols-2"><div className="min-w-0 border border-[#2c323a] bg-[#12171d] p-4"><p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Recovery phrase</p><p className="mt-2 break-words font-mono text-xs leading-6 text-[#d9d3c6]">{reveal.mnemonic ? wallet.mnemonic : "•••••••• •••••••• •••••••• ••••••••"}</p><button type="button" onClick={() => setReveal(value => ({ ...value, mnemonic: !value.mnemonic }))} className="mt-2 inline-flex min-h-10 items-center gap-1 font-mono text-[9px] uppercase text-[#f2bd63]">{reveal.mnemonic ? <EyeOff size={12} /> : <Eye size={12} />} {reveal.mnemonic ? "Hide" : "Reveal"}</button>{reveal.mnemonic && <button type="button" onClick={() => copy(wallet.mnemonic)} className="ml-3 min-h-10 font-mono text-[9px] uppercase text-[#f2bd63]">Copy</button>}</div><div className="border border-[#70c7a0]/30 bg-[#70c7a0]/5 p-4 font-mono text-[10px] leading-5 text-[#9fe0bd]">Balances are fetched from public Mempool endpoints. Signing happens locally after explicit review; Ordi Wallet never sends a private key to a server.</div></div>
              </div>}
            </>}
          </div>
        </section>
      </div>, document.body)}
  </>;
}
