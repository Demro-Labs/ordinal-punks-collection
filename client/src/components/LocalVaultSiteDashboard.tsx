import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Wallet } from "lucide-react";
import { ProtocolAssetsPanel } from "@/components/ProtocolAssetsPanel";
import { LocalVaultActiveUtxosPanel } from "@/components/LocalVaultActiveUtxosPanel";
import { clearLocalVaultSiteSession, LOCAL_VAULT_SESSION_EVENT, readLocalVaultSiteSession, type LocalVaultSite, type LocalVaultSiteSession } from "@/lib/local-vault-bridge";
import { ADDRESS_SPECS, formatSats } from "@/lib/ordi-wallet";

type AddressType = LocalVaultSiteSession["activeAddressType"];
type Balance = { confirmed: number; unconfirmed: number; total: number };
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
  const [balances, setBalances] = useState<Partial<Record<AddressType, Balance>>>({});
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
    const balanceResults = await Promise.allSettled(addresses.map(async item => {
      const response = await fetch(`${base}/api/address/${encodeURIComponent(item.address)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Balance endpoint returned HTTP ${response.status}`);
      const data = await response.json() as {
        chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
        mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
      };
      const chain = data.chain_stats ?? {};
      const pending = data.mempool_stats ?? {};
      const confirmed = (chain.funded_txo_sum ?? 0) - (chain.spent_txo_sum ?? 0);
      const unconfirmed = (pending.funded_txo_sum ?? 0) - (pending.spent_txo_sum ?? 0);
      return [item.type, { confirmed, unconfirmed, total: confirmed + unconfirmed }] as const;
    }));
    const nextBalances: Partial<Record<AddressType, Balance>> = {};
    for (const result of balanceResults) {
      if (result.status === "fulfilled") nextBalances[result.value[0]] = result.value[1];
    }
    setBalances(nextBalances);
    if (Object.keys(nextBalances).length !== addresses.length) setBalanceError("Some live balances are temporarily unavailable.");

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
  const activeBalance = balances[session.activeAddressType];

  return <section className="mt-3 border border-[#70c7a0]/50 bg-[#0e1513] p-3 sm:p-4" aria-labelledby="ordi-vault-live-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2"><Wallet size={15} className="shrink-0 text-[#70c7a0]" /><div className="min-w-0"><h3 id="ordi-vault-live-title" className="font-mono text-[10px] uppercase tracking-[.15em] text-[#9fe0bd]">Ordi Wallet · Live vault dashboard</h3><p className="mt-1 font-mono text-[9px] text-[#718092]">{networkLabel} · public blockchain data · read-only</p></div></div>
      <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6] hover:border-[#70c7a0] disabled:opacity-50" aria-label="Refresh Ordi Wallet live data"><RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Refresh</button>
    </div>

    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {ADDRESS_SPECS.map(spec => {
        const address = session.addresses[spec.type].address;
        const balance = balances[spec.type];
        const active = session.activeAddressType === spec.type;
        return <article key={spec.type} className={`min-w-0 border p-3 ${active ? "border-[#70c7a0]/70 bg-[#70c7a0]/5" : "border-[#2c323a] bg-[#10151a]"}`}>
          <div className="flex items-center justify-between gap-2"><p className="font-mono text-[9px] uppercase tracking-[.1em] text-[#f2bd63]">{spec.label}</p>{active && <span className="font-mono text-[8px] uppercase text-[#9fe0bd]">Active</span>}</div>
          <a href={explorerAddress(session.network, address)} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-[9px] leading-4 text-[#9ea7b3] hover:text-[#f3efe5]">{short(address)} <ExternalLink size={10} className="inline" /></a>
          <p className="mt-3 font-display text-lg text-[#f3efe5]">{formatSats(balance?.total ?? null)}</p>
          <p className="mt-1 font-mono text-[9px] text-[#718092]">Confirmed {formatSats(balance?.confirmed ?? null)} · Pending {formatSats(balance?.unconfirmed ?? null)}</p>
        </article>;
      })}
    </div>
    {balanceError && <p className="mt-2 font-mono text-[9px] text-[#e0b45f]" role="status">{balanceError}</p>}

    <div className="mt-3 grid gap-3 xl:grid-cols-2"><LocalVaultActiveUtxosPanel address={session.addresses[session.activeAddressType].address} network="BITCOIN_MAINNET" /><LocalVaultActiveUtxosPanel address={session.addresses[session.activeAddressType].address} network="FRACTAL_BITCOIN_MAINNET" /></div>

    <div className="mt-3 border border-[#2c323a] bg-[#10151a] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-mono text-[9px] uppercase tracking-[.12em] text-[#d9d3c6]">Recent activity · {session.activeAddressType.replaceAll("-", " ")}</h4>{updatedAt && <p className="font-mono text-[8px] text-[#718092]">Updated {new Date(updatedAt).toLocaleTimeString()}</p>}</div>
      {activityError ? <p className="mt-3 font-mono text-[9px] text-[#e0b45f]" role="status">{activityError}</p> : transactions.length === 0 ? <p className="mt-3 font-mono text-[9px] text-[#718092]">{busy ? "Loading live activity…" : "No recent transactions for this address."}</p> : <ul className="mt-2 divide-y divide-[#2c323a]">{transactions.map(tx => {
        const summary = transactionSummary(tx, session.addresses[session.activeAddressType].address);
        const explorerTx = `${endpoint(session.network)}/tx/${encodeURIComponent(tx.txid)}`;
        return <li key={tx.txid} className="flex flex-wrap items-center justify-between gap-2 py-2 font-mono text-[9px]">
          <div className="min-w-0"><p className="text-[#d9d3c6]">{summary.kind} · {summary.net > 0 ? "+" : ""}{formatSats(summary.net)}</p><a href={explorerTx} target="_blank" rel="noreferrer" className="break-all text-[#718092] hover:text-[#f2bd63]">{short(tx.txid)} <ExternalLink size={9} className="inline" /></a></div>
          <span className={tx.status?.confirmed ? "text-[#70c7a0]" : "text-[#e0b45f]"}>{tx.status?.confirmed ? `Confirmed${tx.status.block_height ? ` · #${tx.status.block_height}` : ""}` : "Pending"}</span>
        </li>;
      })}</ul>}
    </div>
    <p className="mt-2 font-mono text-[9px] leading-4 text-[#718092]">Balance and history are queried from public Mempool endpoints. Signing and broadcasting are separate actions that always require an explicit review.</p>
    {activeBalance && <span className="sr-only">Active account balance {activeBalance.total} satoshis.</span>}
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
  return <section className="mx-auto my-4 w-full max-w-[1440px] px-4 sm:px-8 lg:px-12" aria-label="Connected Ordi Wallet dashboard">
    <div className="border border-[#70c7a0]/50 bg-[#0b100f] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#70c7a0]">Local Ordi Wallet connected · {session.network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}</p><p className="mt-1 break-all font-mono text-[10px] text-[#d9d3c6]">Active {ADDRESS_SPECS.find(spec => spec.type === session.activeAddressType)?.label}: {short(session.address)}</p><p className="mt-1 font-mono text-[9px] text-[#718092]">This is the Local Ordi Wallet dashboard, not UniSat. Local keys stay here; signing is a separate reviewed action.</p></div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => window.dispatchEvent(new Event("ordi-wallet:open"))} className="inline-flex min-h-11 items-center border border-[#d99a54] px-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#f2bd63] hover:bg-[#d99a54]/10">Open Ordi Wallet</button>
          <button type="button" onClick={disconnect} className="inline-flex min-h-11 items-center border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#d9d3c6] hover:border-[#a45e54]">Disconnect site</button>
        </div>
      </div>
      <LocalVaultSiteDashboard session={session} />
      <div className="mt-3 border border-[#2c323a] bg-[#10151a] p-3 sm:p-4"><ProtocolAssetsPanel address={session.address} network={session.network} site={site} /></div>
    </div>
  </section>;
}
