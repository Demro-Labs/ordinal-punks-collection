import { useEffect, useRef, useState } from "react";
import { ExternalLink, Wallet } from "lucide-react";

type UniSatChain = {
  enum?: string;
  name?: string;
  network?: string;
};

type UniSatInscription = {
  inscriptionId: string;
  inscriptionNumber?: string | number;
  content?: string;
  preview?: string;
};

type UniSatBalance = {
  confirmed?: number;
  unconfirmed?: number;
  total?: number;
};
type UniSatBalanceV2 = {
  available?: number;
  unavailable?: number;
  total?: number;
};

type UniSatProvider = {
  requestAccounts: () => Promise<string[]>;
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<UniSatChain>;
  getBalance?: () => Promise<UniSatBalance>;
  getBalanceV2?: () => Promise<UniSatBalanceV2>;
  getBitcoinUtxos?: (cursor: number, size: number) => Promise<unknown>;
  switchChain?: (chain: "FRACTAL_BITCOIN_MAINNET") => Promise<UniSatChain>;
  getInscriptions?: (cursor: number, size: number) => Promise<{
    total: number;
    list: UniSatInscription[];
  }>;
  sendInscription?: (
    address: string,
    inscriptionId: string,
    options?: { feeRate?: number }
  ) => Promise<{ txid: string }>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    unisat?: UniSatProvider;
  }
}

const FRACTAL_MAINNET = "FRACTAL_BITCOIN_MAINNET";
const BITCOIN_MAINNET = "BITCOIN_MAINNET";
const MEMPOOL_ENDPOINTS: Record<string, { api: string; explorer: string; label: string }> = {
  [FRACTAL_MAINNET]: {
    api: "https://mempool.fractalbitcoin.io",
    explorer: "https://mempool.fractalbitcoin.io/tx/",
    label: "Fractal Bitcoin",
  },
  [BITCOIN_MAINNET]: {
    api: "https://mempool.space",
    explorer: "https://mempool.space/tx/",
    label: "Bitcoin",
  },
};
type MempoolTrackingStatus = "idle" | "checking" | "pending" | "confirmed" | "timeout" | "error";
const MARKETPLACE_URL = "https://fractal.unisat.io/market/collection?collectionId=opunk";
const INSCRIPTIONS_PAGE_SIZE = 50;
const INSCRIPTION_ID_PATTERN = /^[a-f0-9]{64}i\d+$/i;
let pendingTransferRequest: string | null = null;

function sameInscriptionId(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

export function requestUniSatTransfer(inscriptionId: string) {
  if (!INSCRIPTION_ID_PATTERN.test(inscriptionId)) return;
  pendingTransferRequest = inscriptionId;
  window.dispatchEvent(new CustomEvent("ordinal-punks:request-transfer", { detail: { inscriptionId } }));
  document.getElementById("live-market")?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("ordinal-punks:request-transfer", { detail: { inscriptionId } }));
  }, 700);
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

async function ensureFeeBalance(provider: UniSatProvider) {
  if (provider.getBalanceV2) {
    const balance = await provider.getBalanceV2();
    const available = Number(balance.available ?? 0);
    if (!Number.isFinite(available) || available <= 0) {
      throw new Error("No spendable FB fee UTXO is available. Add separate FB to UniSat or use the UniSat UTXO tool to unlock/consolidate the dust UTXO before transferring.");
    }
    return;
  }

  if (provider.getBitcoinUtxos) {
    const result = await provider.getBitcoinUtxos(0, 10);
    const utxos = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "list" in result && Array.isArray(result.list)
        ? result.list
        : [];
    if (utxos.length === 0) {
      throw new Error("No spendable FB fee UTXO is available. Add separate FB to UniSat or use the UniSat UTXO tool to unlock/consolidate the dust UTXO before transferring.");
    }
    return;
  }

  if (!provider.getBalance) return;
  const balance = await provider.getBalance();
  const confirmed = Number(balance.confirmed ?? 0);
  const unconfirmed = Number(balance.unconfirmed ?? 0);
  const total = Number(balance.total ?? confirmed + unconfirmed);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Add separate FB to this UniSat wallet to pay the Fractal Bitcoin network fee before transferring.");
  }
}

function describeWalletError(cause: unknown, fallback: string) {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause && typeof cause === "object") {
    const details = cause as { message?: unknown; error?: unknown; code?: unknown };
    const message = typeof details.message === "string"
      ? details.message
      : typeof details.error === "string"
        ? details.error
        : "";
    const code = typeof details.code === "string" || typeof details.code === "number"
      ? ` (code ${details.code})`
      : "";
    if (message) return `${message}${code}`;
  }
  return fallback;
}

export function UniSatWalletConnect() {
  const [providerAvailable, setProviderAvailable] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [chain, setChain] = useState<UniSatChain | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inscriptions, setInscriptions] = useState<UniSatInscription[]>([]);
  const [inscriptionsLoaded, setInscriptionsLoaded] = useState(false);
  const [inscriptionTotal, setInscriptionTotal] = useState(0);
  const [inscriptionCursor, setInscriptionCursor] = useState(0);
  const [selectedInscriptionId, setSelectedInscriptionId] = useState("");
  const [destination, setDestination] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [txid, setTxid] = useState("");
  const [mempoolStatus, setMempoolStatus] = useState<MempoolTrackingStatus>("idle");
  const [mempoolMessage, setMempoolMessage] = useState("");
  const [mempoolNetwork, setMempoolNetwork] = useState("");
  const [mempoolBlockHeight, setMempoolBlockHeight] = useState<number | null>(null);
  const [mempoolExplorerUrl, setMempoolExplorerUrl] = useState("");
  const trackingRunRef = useRef(0);

  const resetMempoolTracking = () => {
    trackingRunRef.current += 1;
    setMempoolStatus("idle");
    setMempoolMessage("");
    setMempoolNetwork("");
    setMempoolBlockHeight(null);
    setMempoolExplorerUrl("");
  };

  useEffect(() => {
    const handleTransferRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ inscriptionId?: unknown }>).detail;
      const requestedId = typeof detail?.inscriptionId === "string" ? detail.inscriptionId : "";
      if (!INSCRIPTION_ID_PATTERN.test(requestedId)) return;
      pendingTransferRequest = requestedId;
      setSelectedInscriptionId(inscriptions.some(item => sameInscriptionId(item.inscriptionId, requestedId)) ? requestedId : "");
      setConfirmed(false);
      setTxid("");
      resetMempoolTracking();
      setTransferError(
        address && chain?.enum === FRACTAL_MAINNET
          ? inscriptions.length > 0
            ? inscriptions.some(item => sameInscriptionId(item.inscriptionId, requestedId))
              ? ""
              : "This Ordinal Punks inscription is not among the inscriptions loaded from this UniSat account."
            : "Load your UniSat inscriptions first; the transfer will only use an inscription owned by this account."
          : "Connect UniSat on Fractal Bitcoin, then load your inscriptions before transferring."
      );
      if (address && chain?.enum === FRACTAL_MAINNET && !busy && (!inscriptionsLoaded || !inscriptions.some(item => sameInscriptionId(item.inscriptionId, requestedId)))) {
        void loadInscriptions(false, requestedId);
      }
      if (!address && providerAvailable && !busy) {
        void connect();
      }
    };
    window.addEventListener("ordinal-punks:request-transfer", handleTransferRequest);
    if (pendingTransferRequest) {
      handleTransferRequest(new CustomEvent("ordinal-punks:request-transfer", { detail: { inscriptionId: pendingTransferRequest } }));
    }
    return () => window.removeEventListener("ordinal-punks:request-transfer", handleTransferRequest);
  }, [address, chain, inscriptions, inscriptionsLoaded, busy, providerAvailable]);

  useEffect(() => {
    if (!pendingTransferRequest) return;
    if (inscriptions.some(item => sameInscriptionId(item.inscriptionId, pendingTransferRequest!))) {
      setSelectedInscriptionId(pendingTransferRequest);
      setConfirmed(false);
      setTxid("");
      setTransferError("");
      pendingTransferRequest = null;
    }
  }, [inscriptions]);

  const clearOwnedInscriptions = () => {
    setInscriptions([]);
    setInscriptionsLoaded(false);
    setInscriptionTotal(0);
    setInscriptionCursor(0);
    setSelectedInscriptionId("");
    setConfirmed(false);
    setTxid("");
  };

  useEffect(() => {
    const provider = window.unisat;
    setProviderAvailable(Boolean(provider));
    if (!provider) return;

    const handleAccounts = (...args: unknown[]) => {
      const accounts = args[0];
      setAddress(Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null);
      setDestination("");
      setTransferError("");
      clearOwnedInscriptions();
    };
    const handleChain = () => {
      void provider.getChain?.().then(nextChain => {
        setChain(nextChain);
        setDestination("");
        setTransferError("");
        clearOwnedInscriptions();
      }).catch(() => {
        setChain(null);
        setDestination("");
        setTransferError("");
        clearOwnedInscriptions();
      });
    };

    provider.on?.("accountsChanged", handleAccounts);
    provider.on?.("chainChanged", handleChain);
    provider.on?.("networkChanged", handleChain);
    void (async () => {
      try {
        const [accounts, currentChain] = await Promise.all([
          provider.getAccounts?.(),
          provider.getChain?.(),
        ]);
        const currentAddress = accounts?.[0];
        if (currentAddress) setAddress(currentAddress);
        if (currentChain) setChain(currentChain);
      } catch {
        // The wallet may be unavailable while the extension is initializing.
      }
    })();
    return () => {
      provider.removeListener?.("accountsChanged", handleAccounts);
      provider.removeListener?.("chainChanged", handleChain);
      provider.removeListener?.("networkChanged", handleChain);
    };
  }, []);

  const connect = async () => {
    const provider = window.unisat;
    setError("");
    if (!provider) {
      setProviderAvailable(false);
      setError("Install or enable the official UniSat Wallet extension, then try again.");
      return;
    }
    if (!provider.getChain) {
      setError("Update UniSat Wallet to a version that supports chain detection.");
      return;
    }

    setBusy(true);
    try {
      const accounts = await provider.requestAccounts();
      const selectedAddress = accounts[0];
      if (!selectedAddress) throw new Error("UniSat did not return an account.");
      const selectedChain = await provider.getChain();
      clearOwnedInscriptions();
      setDestination("");
      setAddress(selectedAddress);
      setChain(selectedChain);
      if (selectedChain.enum !== FRACTAL_MAINNET) {
        setError("Wallet connected, but it is not on Fractal Bitcoin mainnet.");
      }
    } catch (cause) {
      setError(describeWalletError(cause, "UniSat connection was cancelled or failed."));
    } finally {
      setBusy(false);
    }
  };

  const switchToFractal = async () => {
    const provider = window.unisat;
    if (!provider?.switchChain) {
      setError("Update UniSat Wallet to enable Fractal Bitcoin network switching.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const selectedChain = await provider.switchChain(FRACTAL_MAINNET);
      setChain(selectedChain);
      clearOwnedInscriptions();
      if (selectedChain.enum !== FRACTAL_MAINNET) {
        setError("UniSat did not confirm Fractal Bitcoin mainnet.");
      }
    } catch (cause) {
      setError(describeWalletError(cause, "Network switch was cancelled or failed."));
    } finally {
      setBusy(false);
    }
  };

  const loadInscriptions = async (append = false, targetId?: string) => {
    const provider = window.unisat;
    if (!provider?.getInscriptions) {
      setTransferError("Update UniSat Wallet to view inscriptions from this site.");
      return;
    }
    setBusy(true);
    setTransferError("");
    try {
      const currentChain = await window.unisat?.getChain?.();
      if (currentChain?.enum !== FRACTAL_MAINNET) {
        setChain(currentChain ?? null);
        clearOwnedInscriptions();
        throw new Error("Switch UniSat to Fractal Bitcoin mainnet, then reload your inscriptions.");
      }
      if (address && provider.getAccounts) {
        const currentAccounts = await provider.getAccounts();
        if (!currentAccounts.includes(address)) {
          setAddress(currentAccounts[0] ?? null);
          clearOwnedInscriptions();
          throw new Error("The selected wallet account changed. Reconnect UniSat and reload.");
        }
      }
      const initialCursor = append ? inscriptionCursor : 0;
      let cursor = initialCursor;
      let total = 0;
      const loaded: UniSatInscription[] = [];
      do {
        const page = await provider.getInscriptions(cursor, INSCRIPTIONS_PAGE_SIZE);
        const currentItems = Array.isArray(page.list) ? page.list : [];
        total = Number.isFinite(page.total) ? page.total : cursor + currentItems.length;
        loaded.push(...currentItems.filter(item =>
          typeof item.inscriptionId === "string" && INSCRIPTION_ID_PATTERN.test(item.inscriptionId)
        ));
        cursor += currentItems.length;
        if (currentItems.length === 0 || cursor >= total) break;
      } while (true);

      const valid = loaded.filter((item, index, items) =>
        items.findIndex(candidate => sameInscriptionId(candidate.inscriptionId, item.inscriptionId)) === index
      );
      setInscriptions(previous => append
        ? [...previous, ...valid.filter(item => !previous.some(existing => sameInscriptionId(existing.inscriptionId, item.inscriptionId)))]
        : valid
      );
      setInscriptionsLoaded(true);
      setInscriptionTotal(total);
      setInscriptionCursor(cursor);
      const found = targetId ? valid.find(item => sameInscriptionId(item.inscriptionId, targetId)) : undefined;
      setSelectedInscriptionId(found?.inscriptionId ?? (append ? selectedInscriptionId : ""));
      setConfirmed(false);
      setTxid("");
      if (targetId && found) {
        pendingTransferRequest = null;
        setTransferError("");
      } else if (targetId && !found) {
        pendingTransferRequest = null;
        setTransferError("This Ordinal Punks inscription was not found among the inscriptions owned by this UniSat account.");
      } else if (!valid.length && total > 0) {
        setTransferError("UniSat returned no usable inscription IDs. Refresh the wallet and try again.");
      }
    } catch (cause) {
      setTransferError(describeWalletError(cause, "Could not load inscriptions from UniSat."));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!providerAvailable || !address || chain?.enum !== FRACTAL_MAINNET || inscriptionsLoaded || busy) return;
    void loadInscriptions(false);
  }, [providerAvailable, address, chain?.enum, inscriptionsLoaded, busy]);

  const trackTransaction = async (transactionId: string, networkEnum?: string) => {
    const config = MEMPOOL_ENDPOINTS[networkEnum ?? FRACTAL_MAINNET] ?? MEMPOOL_ENDPOINTS[FRACTAL_MAINNET];
    const run = ++trackingRunRef.current;
    setMempoolStatus("checking");
    setMempoolMessage("Checking the transaction in Mempool…");
    setMempoolNetwork(config.label);
    setMempoolBlockHeight(null);
    setMempoolExplorerUrl(`${config.explorer}${encodeURIComponent(transactionId)}`);

    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (run !== trackingRunRef.current) return;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${config.api}/api/tx/${encodeURIComponent(transactionId)}/status`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const status = (await response.json()) as { confirmed?: boolean; block_height?: number };
          if (status.confirmed) {
            setMempoolStatus("confirmed");
            setMempoolMessage("Transaction confirmed on-chain.");
            setMempoolBlockHeight(typeof status.block_height === "number" ? status.block_height : null);
            return;
          }
          setMempoolStatus("pending");
          setMempoolMessage("Transaction is visible in the mempool and is waiting for confirmation.");
        } else if (response.status === 404) {
          setMempoolStatus("pending");
          setMempoolMessage("Transaction sent; waiting for Mempool to index it.");
        } else {
          throw new Error(`Mempool returned HTTP ${response.status}.`);
        }
      } catch {
        if (run !== trackingRunRef.current) return;
        setMempoolStatus("error");
        setMempoolMessage("Mempool is temporarily unavailable; retrying automatically.");
      } finally {
        window.clearTimeout(timeout);
      }
      await new Promise(resolve => window.setTimeout(resolve, 10_000));
    }
    if (run === trackingRunRef.current) {
      setMempoolStatus("timeout");
      setMempoolMessage("No confirmation received after 30 minutes. Check the transaction in Mempool.");
    }
  };

  const sendSelectedInscription = async () => {
    const provider = window.unisat;
    const recipient = destination.trim();
    const selected = inscriptions.find(item => item.inscriptionId === selectedInscriptionId);
    setTransferError("");
    setTxid("");

    if (!provider?.sendInscription || !provider.getChain) {
      setTransferError("Update UniSat Wallet to enable inscription transfers.");
      return;
    }
    if (!address || chain?.enum !== FRACTAL_MAINNET) {
      setTransferError("Connect UniSat on Fractal Bitcoin mainnet before transferring.");
      return;
    }
    if (!selected || !INSCRIPTION_ID_PATTERN.test(selected.inscriptionId)) {
      setTransferError("Select an inscription loaded from your connected UniSat wallet.");
      return;
    }
    if (!recipient || recipient.length > 100) {
      setTransferError("Enter a valid Fractal Bitcoin receiving address.");
      return;
    }
    if (!confirmed) {
      setTransferError("Review the inscription and destination, then confirm the transfer checkbox.");
      return;
    }

    setTransferBusy(true);
    try {
      const currentChain = await provider.getChain();
      if (currentChain.enum !== FRACTAL_MAINNET) {
        setChain(currentChain);
        throw new Error("The wallet network changed. Switch back to Fractal Bitcoin and review the transfer again.");
      }
      if (provider.getAccounts) {
        const currentAccounts = await provider.getAccounts();
        if (!currentAccounts.includes(address)) {
          clearOwnedInscriptions();
          setAddress(currentAccounts[0] ?? null);
          throw new Error("The selected wallet account changed. Reload its inscriptions and review the transfer again.");
        }
      }

      await ensureFeeBalance(provider);
      const result = await provider.sendInscription(recipient, selected.inscriptionId);
      const returnedTxid = typeof result === "string" ? result : result?.txid;
      if (!returnedTxid || !/^[a-f0-9]{64}$/i.test(returnedTxid)) {
        throw new Error("UniSat did not return a valid transaction ID. Check the wallet before retrying.");
      }
      setTxid(returnedTxid);
      void trackTransaction(returnedTxid, currentChain.enum);
      setInscriptions(previous => previous.filter(item => item.inscriptionId !== selected.inscriptionId));
      setInscriptionTotal(previous => Math.max(0, previous - 1));
      setSelectedInscriptionId("");
      setConfirmed(false);
      setDestination("");
    } catch (cause) {
      setTransferError(describeWalletError(cause, "Transfer was cancelled or failed in UniSat."));
    } finally {
      setTransferBusy(false);
    }
  };

  const connectedToFractal = Boolean(address && chain?.enum === FRACTAL_MAINNET);
  const selectedInscription = inscriptions.find(item => item.inscriptionId === selectedInscriptionId);

  return (
    <div className="flex flex-col gap-4 border border-[#2c323a] bg-[#14191f] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#d9d3c6]">
            <Wallet size={14} className="text-[#d99a54]" />
            {connectedToFractal ? "UniSat · Fractal Bitcoin" : "UniSat Wallet · Fractal Bitcoin"}
          </p>
          <p className="mt-1 font-mono text-[10px] text-[#7f8b99]" aria-live="polite">
            {connectedToFractal
              ? `Connected: ${shortAddress(address!)}`
              : address
                ? `Connected to ${chain?.name ?? "another network"}; switch to Fractal to continue.`
                : providerAvailable
                  ? "Connect only when you choose. No signature is requested on connection."
                  : "UniSat Wallet extension not detected."}
          </p>
          {connectedToFractal && (
            <p className="mt-1 font-mono text-[9px] text-[#718092]">
              Clear session hides this address here; revoke site access in UniSat to remove its permission.
            </p>
          )}
          {error && <p className="mt-2 font-mono text-[10px] text-[#e08b7d]" role="alert">{error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {connectedToFractal ? (
            <>
              <button
                type="button"
                onClick={() => void loadInscriptions()}
                disabled={busy || transferBusy}
                className="border border-[#d99a54] bg-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-50"
              >
                {busy ? "Loading wallet…" : "Load my inscriptions"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddress(null);
                  setChain(null);
                  setDestination("");
                  clearOwnedInscriptions();
                  setError("");
                  setTransferError("");
                }}
                disabled={busy || transferBusy}
                className="border border-[#3b434d] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#d9d3c6] hover:border-[#d99a54] disabled:opacity-50"
              >
                Clear session
              </button>
            </>
          ) : address ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void switchToFractal()}
              className="border border-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63] disabled:opacity-50"
            >
              {busy ? "Waiting for UniSat…" : "Switch to Fractal"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void connect()}
              className="border border-[#d99a54] bg-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-50"
            >
              {busy ? "Waiting for UniSat…" : "Connect UniSat"}
            </button>
          )}
          <a
            href={MARKETPLACE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] hover:border-[#d99a54] hover:text-[#f3efe5]"
          >
            Open UniSat market <ExternalLink size={12} />
          </a>
        </div>
      </div>

      {connectedToFractal && inscriptions.length > 0 && (
        <section className="border-t border-[#2c323a] pt-4" aria-labelledby="ordinal-transfer-title">
          <h3 id="ordinal-transfer-title" className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#d9d3c6]">
            On-chain Ordinal transfer · peer to peer
          </h3>
          <p className="mt-1 font-mono text-[10px] leading-5 text-[#7f8b99]">
            Choose an inscription you own and enter a receiving address for this transfer. UniSat will show its transaction and network fee before you sign.
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <label className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">
              Inscription from your UniSat wallet
              <select
                value={selectedInscriptionId}
                onChange={event => {
                  setSelectedInscriptionId(event.target.value);
                  setConfirmed(false);
                  setTxid("");
                  resetMempoolTracking();
                  setTransferError("");
                }}
                className="mt-2 block w-full border border-[#3b434d] bg-[#10151a] px-3 py-3 font-mono text-xs normal-case text-[#f3efe5]"
              >
                <option value="">Select an inscription</option>
                {inscriptions.map(item => (
                  <option key={item.inscriptionId} value={item.inscriptionId}>
                    {item.inscriptionNumber != null ? `#${item.inscriptionNumber} · ` : ""}{item.inscriptionId}
                  </option>
                ))}
              </select>
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">
              Destination address · Fractal Bitcoin
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={destination}
                onChange={event => {
                  setDestination(event.target.value);
                  setConfirmed(false);
                  setTxid("");
                  setTransferError("");
                }}
                placeholder="Paste the recipient address for this transfer"
                maxLength={100}
                className="mt-2 block w-full border border-[#3b434d] bg-[#10151a] px-3 py-3 font-mono text-xs normal-case text-[#f3efe5] placeholder:text-[#596473]"
              />
            </label>
          </div>

          {selectedInscription && destination.trim() && (
            <div className="mt-3 border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]">
              <p><span className="text-[#718092]">Asset:</span> {selectedInscription.inscriptionId}</p>
              <p className="break-all"><span className="text-[#718092]">Recipient:</span> {destination.trim()}</p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-[#d9d3c6]">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={event => setConfirmed(event.target.checked)}
                  className="mt-0.5 accent-[#d99a54]"
                />
                <span>I checked this inscription and destination. I understand the on-chain transfer cannot be reversed.</span>
              </label>
              <button
                type="button"
                onClick={() => void sendSelectedInscription()}
                disabled={!confirmed || transferBusy || busy}
                className="mt-3 border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {transferBusy ? "Waiting for UniSat approval…" : "Review transfer in UniSat"}
              </button>
            </div>
          )}
          {inscriptionCursor < inscriptionTotal && (
            <button
              type="button"
              onClick={() => void loadInscriptions(true)}
              disabled={busy || transferBusy}
              className="mt-3 border border-[#3b434d] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-50"
            >
              Load more inscriptions ({inscriptionCursor} of {inscriptionTotal})
            </button>
          )}
          {transferError && <p className="mt-3 font-mono text-[10px] text-[#e08b7d]" role="alert">{transferError}</p>}
          {txid && (
            <>
              <p className="mt-3 break-all font-mono text-[10px] text-[#70c7a0]" role="status">
                UniSat returned transaction ID: {txid}.
              </p>
              {mempoolStatus !== "idle" && (
                <div className="mt-2 border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]" role="status" aria-live="polite">
                  <p><span className="text-[#718092]">{mempoolNetwork} Mempool:</span> {mempoolMessage}</p>
                  {mempoolBlockHeight !== null && <p><span className="text-[#718092]">Block:</span> {mempoolBlockHeight}</p>}
                  {mempoolExplorerUrl && <a className="mt-1 inline-flex text-[#d99a54] underline underline-offset-2" href={mempoolExplorerUrl} target="_blank" rel="noreferrer">Open transaction in Mempool <ExternalLink size={11} /></a>}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {connectedToFractal && inscriptions.length === 0 && inscriptionTotal === 0 && !busy && (
        <p className="border-t border-[#2c323a] pt-3 font-mono text-[10px] text-[#7f8b99]">
          Loading all Ordinals owned by this wallet automatically…
        </p>
      )}
      {connectedToFractal && inscriptions.length === 0 && inscriptionTotal > 0 && (
        <p className="border-t border-[#2c323a] pt-3 font-mono text-[10px] text-[#7f8b99]">
          UniSat reports {inscriptionTotal} inscription(s), but none had a recognized inscription ID. Refresh your wallet and try again.
        </p>
      )}
    </div>
  );
}
