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
  location?: string;
  output?: string;
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
  sendBitcoin?: (address: string, satoshis: number, options?: { feeRate?: number }) => Promise<string | { txid?: string }>;
  getPublicKey?: () => Promise<string>;
  signPsbt?: (
    psbtHex: string,
    options?: {
      autoFinalized?: boolean;
      toSignInputs?: Array<{
        index: number;
        address?: string;
        publicKey?: string;
        disableTweakSigner?: boolean;
        useTweakedSigner?: boolean;
      }>;
    }
  ) => Promise<string>;
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

function getMempoolConfig(networkEnum?: string) {
  return networkEnum ? MEMPOOL_ENDPOINTS[networkEnum] : undefined;
}

function isSupportedMainnet(networkEnum?: string) {
  return Boolean(getMempoolConfig(networkEnum));
}

async function getRecommendedFeeRate(networkEnum: string) {
  const config = getMempoolConfig(networkEnum);
  if (!config) throw new Error("Select Bitcoin mainnet or Fractal Bitcoin mainnet in UniSat.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${config.api}/api/v1/fees/recommended`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Mempool fee API returned HTTP ${response.status}.`);
    const fees = (await response.json()) as {
      fastestFee?: number;
      halfHourFee?: number;
      hourFee?: number;
      minimumFee?: number;
    };
    const selected = fees.halfHourFee ?? fees.fastestFee ?? fees.hourFee ?? fees.minimumFee;
    const feeRate = Number(selected);
    if (!Number.isFinite(feeRate) || feeRate <= 0) {
      throw new Error("Mempool did not return a valid fee rate.");
    }
    return Math.max(1, Math.ceil(feeRate));
  } finally {
    window.clearTimeout(timeout);
  }
}

async function validateMempoolAddress(networkEnum: string, address: string) {
  const config = getMempoolConfig(networkEnum);
  if (!config) throw new Error("Select Bitcoin mainnet or Fractal Bitcoin mainnet in UniSat.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${config.api}/api/v1/validate-address/${encodeURIComponent(address)}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Mempool address API returned HTTP ${response.status}.`);
    const result = (await response.json()) as { isvalid?: boolean };
    if (!result.isvalid) throw new Error(`The recipient address is not valid for ${config.label} mainnet.`);
  } finally {
    window.clearTimeout(timeout);
  }
}

const MARKETPLACE_URL = "https://fractal.unisat.io/market/collection?collectionId=opunk";
const INSCRIPTIONS_PAGE_SIZE = 50;
const INSCRIPTION_ID_PATTERN = /^[a-f0-9]{64}i\d+$/i;
// Experimental custom PSBT path stays off until user review and wallet/manual validation.
const CUSTOM_PSBT_TRANSFER_ENABLED = true;
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

async function ensureFeeBalance(
  provider: UniSatProvider,
  networkEnum: string,
  inscription: UniSatInscription,
  feeRate: number
) {
  const networkLabel = getMempoolConfig(networkEnum)?.label ?? "selected network";
  const feeAsset = networkEnum === BITCOIN_MAINNET ? "BTC" : "FB";
  // Reserve a conservative 350 vB for the inscription transfer plus a non-dust change output.
  const minimumFeeBalance = Math.max(1_000, Math.ceil(feeRate * 350) + 600);
  let availableBalance: number | null = null;
  if (provider.getBalanceV2) {
    const balance = await provider.getBalanceV2();
    const available = Number(balance.available ?? 0);
    if (!Number.isFinite(available) || available <= 0) {
      throw new Error(`UniSat reports no spendable ${feeAsset} fee balance on ${networkLabel}. Add a separate, non-dust ${feeAsset} UTXO before transferring.`);
    }
    availableBalance = available;
    if (available < minimumFeeBalance) {
      const additional = Math.ceil(minimumFeeBalance - available);
      throw new Error(
        `Insufficient spendable ${feeAsset} on ${networkLabel} for fees and non-dust change. UniSat reports ${Math.floor(available)} sats available; add about ${additional} more sats (estimated minimum ${minimumFeeBalance} sats at ${feeRate} sat/vB).`
      );
    }
  }

  if (provider.getBitcoinUtxos) {
    const result = await provider.getBitcoinUtxos(0, 100);
    const utxos = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "list" in result && Array.isArray(result.list)
        ? result.list
        : [];
    const location = typeof inscription.location === "string" ? inscription.location : "";
    const inscriptionOutpoint = location.match(/^([a-f0-9]{64}):(\d+)(?::\d+)?$/i);
    const spendableUtxos = inscriptionOutpoint
      ? utxos.filter(item => {
          if (!item || typeof item !== "object") return false;
          const utxo = item as { txid?: unknown; vout?: unknown };
          return typeof utxo.txid === "string"
            && typeof utxo.vout === "number"
            && `${utxo.txid}:${utxo.vout}`.toLowerCase() !== `${inscriptionOutpoint[1]}:${inscriptionOutpoint[2]}`.toLowerCase();
        })
      : utxos;
    if (spendableUtxos.length === 0) {
      throw new Error(`No separate spendable ${feeAsset} fee UTXO is available on ${networkLabel}. The inscription output itself is reserved for the Ordinal and cannot also pay network fees; add another non-dust UTXO.`);
    }
    return;
  }

  if (availableBalance !== null) return;

  if (!provider.getBalance) return;
  const balance = await provider.getBalance();
  const confirmed = Number(balance.confirmed ?? 0);
  const unconfirmed = Number(balance.unconfirmed ?? 0);
  const total = Number(balance.total ?? confirmed + unconfirmed);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`Add a separate, spendable ${feeAsset} UTXO to this UniSat wallet to pay the ${networkLabel} network fee before transferring.`);
  }
}

const WALLET_REQUEST_TIMEOUT_MS = 30_000;
const UNISAT_MOBILE_APP_NAME = "Ordinal Punks";

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function openUniSatMobileWallet() {
  if (!isMobileBrowser()) return false;
  // UniSat's mobile connect deeplink returns to a custom app scheme, which
  // Safari/Chrome cannot receive. The official openDapp flow loads this site
  // inside UniSat's in-app browser where window.unisat is injected.
  const dappUrl = window.location.href;
  const data = btoa(JSON.stringify([dappUrl]));
  const query = new URLSearchParams({
    method: "openDapp",
    from: UNISAT_MOBILE_APP_NAME,
    data,
  });
  window.location.href = `https://app.unisat.cloud/request?${query.toString()}`;
  return true;
}

function withWalletTimeout<T>(promise: Promise<T>, message: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), WALLET_REQUEST_TIMEOUT_MS);
    }),
  ]);
}

function describeWalletError(cause: unknown, fallback: string) {
  let message = "";
  let code = "";
  if (cause instanceof Error) {
    message = cause.message;
    const errorCode = (cause as Error & { code?: unknown }).code;
    code = typeof errorCode === "string" || typeof errorCode === "number"
      ? ` (code ${errorCode})`
      : "";
  } else if (typeof cause === "string") {
    message = cause.trim();
  } else if (cause && typeof cause === "object") {
    const details = cause as { message?: unknown; error?: unknown; code?: unknown };
    message = typeof details.message === "string"
      ? details.message
      : typeof details.error === "string"
        ? details.error
        : "";
    code = typeof details.code === "string" || typeof details.code === "number"
      ? ` (code ${details.code})`
      : "";
  }
  if (/dust|0-fee/i.test(message)) {
    return `${message}${code}. The network relay policy rejected a transaction that contains a dust output while paying a non-zero fee. The offending output may be the inscription sent to the recipient or the wallet's change; adding BTC/FB only helps if it removes a dust change output. UniSat sendInscription exposes a fee rate but no output-value control, and a Mempool or Cloudflare API key cannot override this policy.`;
  }
  return message ? `${message}${code}` : fallback;
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
  const [mempoolFeeRate, setMempoolFeeRate] = useState<number | null>(null);
  const trackingRunRef = useRef(0);
  const autoLoadKeyRef = useRef("");

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
        address && isSupportedMainnet(chain?.enum)
          ? inscriptions.length > 0
            ? inscriptions.some(item => sameInscriptionId(item.inscriptionId, requestedId))
              ? ""
              : "This Ordinal Punks inscription is not among the inscriptions loaded from this UniSat account."
            : "Load your UniSat inscriptions first; the transfer will only use an inscription owned by this account."
          : "Connect UniSat on Bitcoin or Fractal mainnet, then load your inscriptions before transferring."
      );
      if (address && isSupportedMainnet(chain?.enum) && !busy && (!inscriptionsLoaded || !inscriptions.some(item => sameInscriptionId(item.inscriptionId, requestedId)))) {
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
    setMempoolFeeRate(null);
    autoLoadKeyRef.current = "";
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
      const nextAddress = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      setAddress(nextAddress);
      setDestination("");
      setTransferError("");
      clearOwnedInscriptions();
      if (nextAddress) {
        void provider.getChain?.().then(nextChain => {
          setChain(nextChain);
          if (isSupportedMainnet(nextChain.enum)) void loadInscriptions(false, undefined, nextAddress);
        }).catch(() => setChain(null));
      }
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
      if (openUniSatMobileWallet()) {
        setError("Opening this site inside UniSat Wallet. Approve the request, then connect from the UniSat in-app browser.");
      } else {
        setError("Install or enable the official UniSat Wallet extension, then try again.");
      }
      return;
    }
    if (!provider.getChain) {
      setError("Update UniSat Wallet to a version that supports chain detection.");
      return;
    }

    setBusy(true);
    try {
      const accounts = await withWalletTimeout(
        provider.requestAccounts(),
        "UniSat did not respond. Open the UniSat extension, approve the pending request, then try again."
      );
      const selectedAddress = accounts[0];
      if (!selectedAddress) throw new Error("UniSat did not return an account.");
      const selectedChain = await withWalletTimeout(
        provider.getChain(),
        "UniSat did not return the active network. Unlock the wallet and try again."
      );
      clearOwnedInscriptions();
      setDestination("");
      setAddress(selectedAddress);
      setChain(selectedChain);
      if (!isSupportedMainnet(selectedChain.enum)) {
        setError("Wallet connected, but select Bitcoin mainnet or Fractal Bitcoin mainnet to continue.");
      } else {
        // Do not wait for a later React effect: refresh the account immediately after connection.
        await loadInscriptions(false, undefined, selectedAddress);
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
      } else if (address) {
        // Switching to Fractal changes the wallet asset view; reload it immediately.
        await loadInscriptions(false, undefined, address);
      }
    } catch (cause) {
      setError(describeWalletError(cause, "Network switch was cancelled or failed."));
    } finally {
      setBusy(false);
    }
  };

  const loadInscriptions = async (append = false, targetId?: string, accountAddress = address) => {
    const provider = window.unisat;
    if (!provider?.getInscriptions) {
      setTransferError("Update UniSat Wallet to view inscriptions from this site.");
      return;
    }
    setBusy(true);
    setTransferError("");
    try {
      const currentChain = await window.unisat?.getChain?.();
      if (!isSupportedMainnet(currentChain?.enum)) {
        setChain(currentChain ?? null);
        clearOwnedInscriptions();
        throw new Error("Switch UniSat to Bitcoin mainnet or Fractal Bitcoin mainnet, then reload your inscriptions.");
      }
      if (accountAddress && provider.getAccounts) {
        const currentAccounts = await provider.getAccounts();
        if (!currentAccounts.includes(accountAddress)) {
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
    if (!providerAvailable || !address || !isSupportedMainnet(chain?.enum) || inscriptionsLoaded) return;
    const sessionKey = `${address}:${chain?.enum}`;
    if (autoLoadKeyRef.current === sessionKey) return;
    autoLoadKeyRef.current = sessionKey;
    void loadInscriptions(false, undefined, address);
  }, [providerAvailable, address, chain?.enum, inscriptionsLoaded]);

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

    if (!provider?.getChain || (!CUSTOM_PSBT_TRANSFER_ENABLED && !provider.sendInscription)) {
      setTransferError("Update UniSat Wallet to enable inscription transfers.");
      return;
    }
    if (!address || !isSupportedMainnet(chain?.enum)) {
      setTransferError("Connect UniSat on Bitcoin mainnet or Fractal Bitcoin mainnet before transferring.");
      return;
    }
    if (!selected || !INSCRIPTION_ID_PATTERN.test(selected.inscriptionId)) {
      setTransferError("Select an inscription loaded from your connected UniSat wallet.");
      return;
    }
    if (!recipient || recipient.length > 100) {
      setTransferError(`Enter a valid ${getMempoolConfig(chain?.enum)?.label ?? "Bitcoin"} receiving address.`);
      return;
    }
    if (!confirmed) {
      setTransferError("Review the inscription and destination, then confirm the transfer checkbox.");
      return;
    }

    setTransferBusy(true);
    try {
      const currentChain = await provider.getChain();
      const activeNetworkEnum = currentChain.enum;
      if (!activeNetworkEnum || activeNetworkEnum !== chain?.enum || !isSupportedMainnet(activeNetworkEnum)) {
        setChain(currentChain);
        throw new Error("The wallet network changed. Reload inscriptions and review the transfer on the selected mainnet.");
      }
      if (provider.getAccounts) {
        const currentAccounts = await provider.getAccounts();
        if (!currentAccounts.includes(address)) {
          clearOwnedInscriptions();
          setAddress(currentAccounts[0] ?? null);
          throw new Error("The selected wallet account changed. Reload its inscriptions and review the transfer again.");
        }
      }

      await validateMempoolAddress(activeNetworkEnum, recipient);
      const feeRate = await getRecommendedFeeRate(activeNetworkEnum);
      setMempoolFeeRate(feeRate);
      let returnedTxid: string | undefined;
      if (CUSTOM_PSBT_TRANSFER_ENABLED) {
        if (!provider.getBitcoinUtxos || !provider.getPublicKey || !provider.signPsbt || !provider.getAccounts) {
          throw new Error("This UniSat version does not expose the experimental PSBT signing methods.");
        }
        const mempool = getMempoolConfig(activeNetworkEnum);
        if (!mempool) throw new Error("No Mempool endpoint is configured for the active mainnet.");
        const { sendOrdinalInscriptionWithCustomPsbt } = await import("@/lib/custom-ordinal-transfer");
        const customResult = await sendOrdinalInscriptionWithCustomPsbt({
          provider: {
            getBitcoinUtxos: (cursor, size) => provider.getBitcoinUtxos!(cursor, size),
            getPublicKey: () => provider.getPublicKey!(),
            getAccounts: () => provider.getAccounts!(),
            getChain: () => provider.getChain!(),
            signPsbt: (psbtHex, options) => provider.signPsbt!(psbtHex, options),
          },
          mempool: { ...mempool, chain: activeNetworkEnum === BITCOIN_MAINNET ? "bitcoin" : "fractal" },
          expectedNetworkEnum: activeNetworkEnum,
          currentAddress: address,
          recipientAddress: recipient,
          selectedInscription: selected,
          ownedInscriptions: inscriptions,
          feeRateSatVb: feeRate,
          beforeBroadcast: async (expectedPublicKeyHex) => {
            const [chainBeforeBroadcast, accountsBeforeBroadcast, publicKeyBeforeBroadcast] = await Promise.all([
              provider.getChain!(),
              provider.getAccounts!(),
              provider.getPublicKey!(),
            ]);
            if (chainBeforeBroadcast.enum !== activeNetworkEnum) {
              throw new Error("UniSat's network changed during signing; the signed transaction was not broadcast.");
            }
            if (accountsBeforeBroadcast[0] !== address || !accountsBeforeBroadcast.includes(address)) {
              throw new Error("UniSat's account changed during signing; the signed transaction was not broadcast.");
            }
            if (publicKeyBeforeBroadcast.toLowerCase() !== expectedPublicKeyHex.toLowerCase()) {
              throw new Error("UniSat's public key changed during signing; the signed transaction was not broadcast.");
            }
          },
        });
        returnedTxid = customResult.txid;
      } else {
        if (!provider.sendInscription) throw new Error("UniSat does not expose sendInscription.");
        await ensureFeeBalance(provider, activeNetworkEnum, selected, feeRate);
        const result = await provider.sendInscription(recipient, selected.inscriptionId, { feeRate });
        returnedTxid = typeof result === "string" ? result : result?.txid;
      }
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

  const connectedToFractal = Boolean(address && isSupportedMainnet(chain?.enum));
  const currentNetwork = getMempoolConfig(chain?.enum);
  const selectedInscription = inscriptions.find(item => item.inscriptionId === selectedInscriptionId);

  return (
    <div className="flex flex-col gap-4 border border-[#2c323a] bg-[#14191f] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#d9d3c6]">
            <Wallet size={14} className="text-[#d99a54]" />
            {connectedToFractal ? `UniSat · ${currentNetwork?.label}` : "UniSat Wallet · Bitcoin / Fractal"}
          </p>
          <p className="mt-1 font-mono text-[10px] text-[#7f8b99]" aria-live="polite">
            {connectedToFractal
              ? `Connected: ${shortAddress(address!)}`
              : address
                ? `Connected to ${chain?.name ?? "another network"}; select Bitcoin or Fractal mainnet to continue.`
                : providerAvailable
                  ? "Connect only when you choose. No signature is requested on connection."
                  : isMobileBrowser()
                    ? "Connect opens the UniSat Wallet app on this mobile device."
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
          <p className="mt-1 font-mono text-[10px] text-[#718092]" aria-live="polite">
            {mempoolFeeRate
              ? `Mempool ${currentNetwork?.label ?? "network"} fee estimate: ${mempoolFeeRate} sat/vB. UniSat recalculates and shows the final fee before approval.`
              : `The ${currentNetwork?.label ?? "selected network"} Mempool fee estimate is fetched immediately before transfer.`}
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
              Destination address · {currentNetwork?.label ?? "Bitcoin / Fractal"}
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
