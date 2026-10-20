import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, RefreshCw, ShieldCheck, Wallet, WalletCards } from "lucide-react";
import { ProtocolAssetsPanel } from "@/components/ProtocolAssetsPanel";
import { LocalVaultActiveUtxosPanel } from "@/components/LocalVaultActiveUtxosPanel";
import { clearLocalVaultSiteSession, LOCAL_VAULT_SESSION_EVENT, readLocalVaultSiteSession, type LocalVaultSite, type LocalVaultSiteSession } from "@/lib/local-vault-bridge";
import { ADDRESS_SPECS, fetchAddressBalance, formatSats } from "@/lib/ordi-wallet";

type AddressType = LocalVaultSiteSession["activeAddressType"];
type Network = LocalVaultSiteSession["network"];
type Balance = { confirmed: number; unconfirmed: number; total: number } | null;
type MempoolTx = {
  txid: string;
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
  vin?: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
  vout?: Array<{ scriptpubkey_address?: string; value?: number }>;
};

const endpoint = (network: LocalVaultSiteSession["network"]) =>
  network === "BITCOIN_MAINNET" ? "https://mempool.space" : "https://mempool.fractalbitcoin.io";

function short(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function explorerAddress(network: LocalVaultSiteSession["network"], address: string) {
  const base = endpoint(network);
  return `${base}/address/${encodeURIComponent(address)}`;
}

function transactionSummary(tx: MempoolTx, address: string) {
  const incoming = (tx.vout ?? []).reduce((sum, output) => output.scriptpubkey_address === address ? sum + (output.value ?? 0) : sum, 0);
  const outgoing = (tx.vin ?? []).reduce((sum, input) => input.prevout?.scriptpubkey_address === address ? sum + (input.prevout.value ?? 0) : sum, 0);
  return { net: incoming - outgoing, kind: outgoing > 0 ? "Sent" : incoming > 0 ? "Received" : "Activity" };
}

export function LocalVaultSiteDashboard({ session }: { session: LocalVaultSiteSession }) {
  const [balances, setBalances] = useState<Record<Network, Partial<Record<AddressType, Balance>>>>({ BITCOIN_MAINNET: {}, FRACTAL_BITCOIN_MAINNET: {} });
  const [transactions, setTransactions] = useState<MempoolTx[]>([]);
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [activityError, setActivityError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setBalanceError("");
    setActivityError("");
    const base = endpoint(session.network);
    const addresses = ADDRESS_SPECS.map(spec => ({ type: spec.type, address: session.addresses[spec.type].address }));
    const networks: Network[] = ["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"];
    const balanceResults = await Promise.all(networks.flatMap(chain => addresses.map(async item => ({
      network: chain,
      type: item.type,
      result: await Promise.allSettled([fetchAddressBalance(chain, item.address)]).then(([result]) => result),
    }))));
    const nextBalances: Record<Network, Partial<Record<AddressType, Balance>>> = { BITCOIN_MAINNET: {}, FRACTAL_BITCOIN_MAINNET: {} };
    const failedBalances: string[] = [];
    for (const check of balanceResults) {
      if (check.result.status === "fulfilled") nextBalances[check.network][check.type] = check.result.value;
      else failedBalances.push(`${check.network === "BITCOIN_MAINNET" ? "BTC" : "FB"} / ${ADDRESS_SPECS.find(spec => spec.type === check.type)?.label ?? check.type}`);
    }
    setBalances(nextBalances);
    if (failedBalances.length) setBalanceError(`Scan partiel : solde indisponible pour ${failedBalances.join(", ")}. Les résultats en erreur ne sont pas considérés comme 0 sats.`);

    try {
      const activeAddress = session.addresses[session.activeAddressType].address;
      const response = await fetch(`${base}/api/address/${encodeURIComponent(activeAddress)}/txs`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Activity endpoint returned HTTP ${response.status}`);
      const result = await response.json() as MempoolTx[];
      setTransactions(Array.isArray(result) ? result.slice(0, 6) : []);
    } catch {
      setTransactions([]);
      setActivityError("Recent activity is temporarily unavailable.");
    } finally {
      setUpdatedAt(new Date().toISOString());
      setBusy(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const networkLabel = session.network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin";
  const activeBalance = balances[session.network][session.activeAddressType];

  return <section className="mt-4 overflow-hidden rounded-2xl border border-[#27332f] bg-[#0a0f0e] shadow-[0_24px_70px_rgba(0,0,0,.22)]" aria-labelledby="ordi-vault-live-title">
    <div className="relative overflow-hidden border-b border-[#27332f] bg-[radial-gradient(ellipse_at_top_right,rgba(112,199,160,.12),transparent_55%),linear-gradient(135deg,#101a17,#0b100f_65%)] p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#70c7a0]/30 bg-[#70c7a0]/10 text-[#9fe0bd]"><Wallet size={20} /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h3 id="ordi-vault-live-title" className="font-display text-xl font-semibold tracking-tight text-[#f3efe5]">Local Vault overview</h3><span className="inline-flex items-center gap-1 rounded-full border border-[#70c7a0]/30 bg-[#70c7a0]/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[.1em] text-[#9fe0bd]"><span className="h-1.5 w-1.5 rounded-full bg-[#70c7a0]" /> Read-only</span></div>
            <p className="mt-1 text-sm text-[#9ea7b3]">{networkLabel} <span className="mx-1 text-[#52605b]">/</span> public chain data <span className="mx-1 text-[#52605b]">/</span> private keys remain local</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {updatedAt && <span className="hidden text-right font-mono text-[10px] text-[#718092] sm:block">Updated<br />{new Date(updatedAt).toLocaleTimeString()}</span>}
          <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#35443d] bg-[#121b17] px-4 text-xs font-semibold text-[#d9d3c6] transition hover:border-[#70c7a0]/70 hover:text-[#9fe0bd] disabled:cursor-wait disabled:opacity-50" aria-label="Refresh Ordi Wallet live data"><RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh</button>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <article className="rounded-xl border border-[#70c7a0]/20 bg-[#0c1411]/80 p-4">
          <p className="flex items-center gap-2 text-xs text-[#9ea7b3]"><WalletCards size={14} className="text-[#70c7a0]" /> Active account balance</p>
          <p className="mt-2 font-display text-2xl font-semibold tracking-tight text-[#f3efe5]">{formatSats(activeBalance?.total ?? null)}</p>
          <p className="mt-1 text-xs text-[#718092]">Confirmed {formatSats(activeBalance?.confirmed ?? null)} <span className="px-1">·</span> Pending {formatSats(activeBalance?.unconfirmed ?? null)}</p>
        </article>
        <article className="rounded-xl border border-[#27332f] bg-[#0c1411]/80 p-4">
          <p className="flex items-center gap-2 text-xs text-[#9ea7b3]"><ShieldCheck size={14} className="text-[#70c7a0]" /> Signing protection</p>
          <p className="mt-2 text-base font-semibold text-[#f3efe5]">Local review required</p>
          <p className="mt-1 text-xs leading-5 text-[#718092]">Dashboard never signs or broadcasts a transaction.</p>
        </article>
        <article className="rounded-xl border border-[#27332f] bg-[#0c1411]/80 p-4">
          <p className="flex items-center gap-2 text-xs text-[#9ea7b3]"><Wallet size={14} className="text-[#d99a54]" /> Active address type</p>
          <p className="mt-2 text-base font-semibold text-[#f3efe5]">{ADDRESS_SPECS.find(spec => spec.type === session.activeAddressType)?.label ?? session.activeAddressType}</p>
          <a href={explorerAddress(session.network, session.addresses[session.activeAddressType].address)} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-xs text-[#9fe0bd] hover:text-[#f3efe5]">{short(session.address)} <ExternalLink size={11} /></a>
        </article>
      </div>
      {balanceError && <p className="mt-3 rounded-lg border border-[#e0b45f]/30 bg-[#e0b45f]/5 p-3 text-xs text-[#e0b45f]" role="status">{balanceError}</p>}
    </div>

    <div className="p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><h4 className="font-display text-base font-semibold text-[#f3efe5]">Address accounts</h4><p className="mt-1 text-xs text-[#718092]">All four derivation types · separate BTC and FB balances</p></div><span className="font-mono text-[10px] uppercase tracking-[.12em] text-[#718092]">4 accounts</span></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ADDRESS_SPECS.map(spec => {
          const address = session.addresses[spec.type].address;
          const balance = balances[spec.type];
          const active = session.activeAddressType === spec.type;
          return <article key={spec.type} className={`min-w-0 rounded-xl border p-4 transition ${active ? "border-[#70c7a0]/60 bg-[#70c7a0]/[.07] shadow-[inset_0_0_0_1px_rgba(112,199,160,.08)]" : "border-[#27332f] bg-[#101613] hover:border-[#3a4a42]"}`}>
            <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-[#d9d3c6]">{spec.label}</p>{active && <span className="rounded-full bg-[#70c7a0]/10 px-2 py-1 font-mono text-[8px] uppercase tracking-[.1em] text-[#9fe0bd]">Active</span>}</div>
            <a href={explorerAddress(session.network, address)} target="_blank" rel="noreferrer" className="mt-3 flex items-start gap-1 break-all font-mono text-[10px] leading-5 text-[#718d81] hover:text-[#9fe0bd]">{short(address)} <ExternalLink size={10} className="mt-1 shrink-0" /></a>
            <div className="mt-3 grid gap-2">
              <div className="rounded-lg border border-[#27332f] bg-[#0b0f0e] p-2">
                <p className="font-mono text-[9px] uppercase tracking-[.1em] text-[#9fe0bd]">Bitcoin · BTC</p>
                <p className="mt-1 font-display text-lg font-semibold tracking-tight text-[#f3efe5]">{formatSats(balances.BITCOIN_MAINNET[spec.type]?.total ?? null)}</p>
                <p className="mt-1 text-[9px] text-[#718092]">Confirmé {formatSats(balances.BITCOIN_MAINNET[spec.type]?.confirmed ?? null)} · Mempool {formatSats(balances.BITCOIN_MAINNET[spec.type]?.unconfirmed ?? null)}</p>
              </div>
              <div className="rounded-lg border border-[#27332f] bg-[#0b0f0e] p-2">
                <p className="font-mono text-[9px] uppercase tracking-[.1em] text-[#f2bd63]">Fractal Bitcoin · FB</p>
                <p className="mt-1 font-display text-lg font-semibold tracking-tight text-[#f3efe5]">{formatSats(balances.FRACTAL_BITCOIN_MAINNET[spec.type]?.total ?? null)}</p>
                <p className="mt-1 text-[9px] text-[#718092]">Confirmé {formatSats(balances.FRACTAL_BITCOIN_MAINNET[spec.type]?.confirmed ?? null)} · Mempool {formatSats(balances.FRACTAL_BITCOIN_MAINNET[spec.type]?.unconfirmed ?? null)}</p>
              </div>
            </div>
          </article>;
        })}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
        <section className="min-w-0 rounded-xl border border-[#27332f] bg-[#0d1310] p-4 sm:p-5" aria-label="UTXO review">
          <div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#d99a54]/10 text-[#f2bd63]"><ShieldCheck size={17} /></div><div className="min-w-0"><h4 className="font-display text-base font-semibold text-[#f3efe5]">UTXO safety & selection</h4><p className="mt-1 text-xs leading-5 text-[#718092]">Network-specific output review for the selected account. Asset-bearing outputs must not be used as fee inputs.</p></div></div>
          <div className="mt-4"><LocalVaultActiveUtxosPanel address={session.addresses[session.activeAddressType].address} network={session.network} /></div>
        </section>
        <section className="min-w-0 rounded-xl border border-[#27332f] bg-[#0d1310] p-4 sm:p-5" aria-label="Recent transactions">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-display text-base font-semibold text-[#f3efe5]">Recent activity</h4><p className="mt-1 text-xs text-[#718092]">{ADDRESS_SPECS.find(spec => spec.type === session.activeAddressType)?.label} · last 6 transactions</p></div><span className="rounded-full border border-[#27332f] px-2 py-1 font-mono text-[9px] text-[#718092]">Live data</span></div>
          {activityError ? <p className="mt-4 rounded-lg border border-[#e0b45f]/30 bg-[#e0b45f]/5 p-3 text-xs text-[#e0b45f]" role="status">{activityError}</p> : transactions.length === 0 ? <div className="mt-4 rounded-lg border border-dashed border-[#27332f] p-5 text-center"><p className="text-sm text-[#d9d3c6]">{busy ? "Loading live activity…" : "No recent transactions"}</p><p className="mt-1 text-xs text-[#718092]">{busy ? "Fetching public chain data." : "Activity will appear here when available."}</p></div> : <ul className="mt-4 divide-y divide-[#27332f]">{transactions.map(tx => {
            const summary = transactionSummary(tx, session.addresses[session.activeAddressType].address);
            const explorerTx = `${endpoint(session.network)}/tx/${encodeURIComponent(tx.txid)}`;
            return <li key={tx.txid} className="flex items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-start gap-3"><div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${summary.kind === "Received" ? "bg-[#70c7a0]/10 text-[#9fe0bd]" : summary.kind === "Sent" ? "bg-[#d99a54]/10 text-[#f2bd63]" : "bg-[#27332f] text-[#9ea7b3]"}`}>{summary.kind === "Received" ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</div><div className="min-w-0"><p className="text-sm font-medium text-[#d9d3c6]">{summary.kind} <span className="text-[#9ea7b3]">· {summary.net > 0 ? "+" : ""}{formatSats(summary.net)}</span></p><a href={explorerTx} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-all font-mono text-[10px] text-[#718092] hover:text-[#9fe0bd]">{short(tx.txid)} <ExternalLink size={10} /></a></div></div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] ${tx.status?.confirmed ? "bg-[#70c7a0]/10 text-[#9fe0bd]" : "bg-[#e0b45f]/10 text-[#e0b45f]"}`}>{tx.status?.confirmed ? `Confirmed${tx.status.block_height ? ` · #${tx.status.block_height}` : ""}` : "Pending"}</span>
            </li>;
          })}</ul>}
        </section>
      </div>
      <p className="mt-4 flex items-start gap-2 border-t border-[#27332f] pt-4 text-xs leading-5 text-[#718092]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#70c7a0]" /> Balances and activity come from public Mempool endpoints. This view is informational: private keys stay in the encrypted local vault and every signing/broadcast action remains separate and explicit.</p>
      {activeBalance && <span className="sr-only">Active account balance {activeBalance.total} satoshis.</span>}
    </div>
  </section>;
}

export function LocalVaultPagePanel({ site }: { site: LocalVaultSite }) {
  const [session, setSession] = useState<LocalVaultSiteSession | null>(() => readLocalVaultSiteSession(site));
  useEffect(() => {
    const sync = (event?: Event) => {
      const detail = event ? (event as CustomEvent<LocalVaultSiteSession | null>).detail : undefined;
      setSession(detail?.site === site ? detail : readLocalVaultSiteSession(site));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === `ordi-wallet-site-session:${site}`) sync();
    };
    window.addEventListener(LOCAL_VAULT_SESSION_EVENT, sync);
    window.addEventListener("storage", onStorage);
    sync();
    return () => {
      window.removeEventListener(LOCAL_VAULT_SESSION_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [site]);

  if (!session) return null;
  const disconnect = () => {
    try { localStorage.removeItem(`ordi-wallet-connected:${site}`); } catch { /* Storage can be unavailable. */ }
    clearLocalVaultSiteSession(site);
  };
  return <section className="mx-auto my-6 w-full max-w-[1480px] px-3 sm:px-6 lg:px-10" aria-label="Connected Ordi Wallet dashboard">
    <div className="overflow-hidden rounded-2xl border border-[#27332f] bg-[#0b100f] p-3 shadow-[0_30px_100px_rgba(0,0,0,.18)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#70c7a0]">Local Ordi Wallet connected · {session.network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}</p><p className="mt-1 break-all font-mono text-[10px] text-[#d9d3c6]">Active {ADDRESS_SPECS.find(spec => spec.type === session.activeAddressType)?.label}: {short(session.address)}</p><p className="mt-1 font-mono text-[9px] text-[#718092]">This is the Local Ordi Wallet dashboard, not UniSat. Local keys stay here; signing is a separate reviewed action.</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => window.dispatchEvent(new Event("ordi-wallet:open"))} className="inline-flex min-h-11 items-center border border-[#d99a54] px-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#f2bd63] hover:bg-[#d99a54]/10">Open Ordi Wallet</button>
          <button type="button" onClick={disconnect} className="inline-flex min-h-11 items-center border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#d9d3c6] hover:border-[#a45e54]">Disconnect site</button>
        </div>
      </div>
      <LocalVaultSiteDashboard session={session} />
      <div className="mt-5 rounded-xl border border-[#27332f] bg-[#101613] p-3 sm:p-5"><ProtocolAssetsPanel address={session.address} network={session.network} site={site} /></div>
    </div>
  </section>;
}
