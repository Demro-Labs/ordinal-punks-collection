import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Wallet } from "lucide-react";
import { fetchLiveInscription, type LiveInscription } from "@/lib/live";
import { describeFeeSources, getRecommendedFeeEstimate } from "@/lib/mempool";
import {
  ensureNativeInscriptionFeeBalance,
  getMobileUtxoErrorGuidance,
  sendNativeUniSatInscription,
} from "@/lib/native-unisat-actions";
import type { OrdinalTransferPlan } from "@/lib/ordinal-transfer-psbt";
import { getUniSatInscriptionUrl, isTransferOutcomeUnclear } from "@/lib/transfer-safety";
import { shouldShowDustRelayGuidance } from "@/lib/wallet-error";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { UniSatFbSendPanel } from "@/components/UniSatFbSendPanel";
import { UniSatRunesSendPanel } from "@/components/UniSatRunesSendPanel";
import { UniSatWalletAuth } from "@/components/UniSatWalletAuth";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";
import { UniSatMobileOpenDappLink } from "@/components/UniSatMobileOpenDappLink";

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
  contentType?: string;
  outputValue?: string | number;
  offset?: string | number;
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
  sendBitcoin?: (address: string, satoshis: number, options?: { feeRate?: number }) => Promise<string | { txid?: string }>;
  sendInscription?: (address: string, inscriptionId: string, options?: { feeRate?: number }) => Promise<{ txid?: string }>;
  getPublicKey?: () => Promise<string>;
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
  signPsbt?: (psbtHex: string, options?: {
    autoFinalized?: boolean;
    toSignInputs?: Array<{ index: number; address?: string; publicKey?: string; useTweakedSigner?: boolean }>;
  }) => Promise<string>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type PsbtReviewState = {
  plan: OrdinalTransferPlan;
  recipientAddress: string;
  inscriptionId: string;
  networkLabel: string;
  feeSourceLabel: string;
};
type PsbtReviewResolver = {
  resolve: (result: boolean | string) => void;
  reject: (cause: unknown) => void;
};
type MobileNativeTransferReady = {
  contextKey: string;
  address: string;
  networkEnum: string;
  recipient: string;
  selected: UniSatInscription;
  feeRate: number;
  liveBefore: LiveInscription | null;
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
type TransferReceipt = { txid: string; network: string; status: string; message: string; blockHeight: number | null; explorerUrl: string; checkedAt: string; liveBefore?: LiveInscription | null; liveAfter?: LiveInscription | null };

function getMempoolConfig(networkEnum?: string) {
  return networkEnum ? MEMPOOL_ENDPOINTS[networkEnum] : undefined;
}

function isSupportedMainnet(networkEnum?: string) {
  return Boolean(getMempoolConfig(networkEnum));
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
const TRANSFER_OUTCOME_UNCLEAR_SESSION_KEY = "ordinal-punks:transfer-outcome-unclear";
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
const FRACTAL_STATIC_BASE = "https://fractal-static.unisat.space";
function absoluteInscriptionUrl(value: string | undefined) {
  if (!value) return "";
  if (value.startsWith("data:") || value.startsWith("blob:") || /^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${FRACTAL_STATIC_BASE}${value}`;
  return "";
}
function inscriptionImageCandidates(item: UniSatInscription, localImage?: string) {
  return [
    localImage ?? "",
    `${FRACTAL_STATIC_BASE}/content/${item.inscriptionId}`,
    absoluteInscriptionUrl(item.preview),
    absoluteInscriptionUrl(item.content),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}
function InscriptionPreview({ item, localImage }: { item: UniSatInscription; localImage?: string }) {
  const candidates = inscriptionImageCandidates(item, localImage);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const source = candidates[candidateIndex];
  if (!source) return <div className="flex h-full items-center justify-center px-3 text-center font-mono text-[9px] uppercase text-[#718092]">Image preview unavailable</div>;
  return <img src={source} alt={`Preview ${item.inscriptionId}`} className="h-full w-full object-contain" loading="lazy" onError={() => setCandidateIndex(index => index + 1)} />;
}

const WALLET_REQUEST_TIMEOUT_MS = 30_000;
const UNISAT_MOBILE_APP_NAME = "Ordinal Punks";
const UNISAT_MOBILE_CONTEXT_PARAM = "unisatMobile";

function isMobileBrowser() {
  return isMobileUniSatDevice();
}

function isUniSatMobileContext() {
  return new URLSearchParams(window.location.search).get(UNISAT_MOBILE_CONTEXT_PARAM) === "1"
    || Boolean(window.unisat);
}

function openUniSatMobileWallet() {
  if (!isMobileBrowser()) return false;
  // UniSat's mobile connect deeplink returns to a custom app scheme, which
  // Safari/Chrome cannot receive. The official openDapp flow loads this site
  // inside UniSat's in-app browser where window.unisat is injected.
  const dappUrl = new URL(window.location.href);
  dappUrl.searchParams.set(UNISAT_MOBILE_CONTEXT_PARAM, "1");
  const data = btoa(JSON.stringify([dappUrl.toString()]));
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
  if (message.startsWith("UNISAT_PSBT_SIGN_FAILED:")) {
    const detail = message.slice("UNISAT_PSBT_SIGN_FAILED:".length).trim();
    return `UniSat failed during signPsbt: ${detail}. The site did not submit a transaction to Fractal Mempool. Check UniSat activity before retrying; if no transfer appears, update UniSat Wallet and try again from the in-app browser.`;
  }
  if (/toAddress/i.test(message) && /undefined/i.test(message)) {
    return `${message}${code}. UniSat Mobile returned an incomplete native transfer response. Do not retry until you check UniSat activity and the selected network's Mempool for a possible broadcast. Update UniSat Wallet and review the destination and final approval screen.`;
  }
  if (shouldShowDustRelayGuidance(message)) {
    return `${message}${code}. Dust is a network relay policy: raising the fee rate alone does not fix an output below the relay threshold. The native UniSat wallet constructs outputs and shows the final transaction for review; the app validates the recipient address and checks Mempool after broadcast. Adding BTC/FB helps only if it removes a dust change output. An API key cannot override relay policy.`;
  }
  return message ? `${message}${code}` : fallback;
}

export function UniSatWalletConnect({ site = "punks" }: { site?: "punks" | "pokedex" } = {}) {
  const [providerAvailable, setProviderAvailable] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [chain, setChain] = useState<UniSatChain | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingInscriptions, setLoadingInscriptions] = useState(false);
  const [error, setError] = useState("");
  const [inscriptions, setInscriptions] = useState<UniSatInscription[]>([]);
  const [inscriptionsLoaded, setInscriptionsLoaded] = useState(false);
  const [inscriptionTotal, setInscriptionTotal] = useState(0);
  const [inscriptionCursor, setInscriptionCursor] = useState(0);
  const [selectedInscriptionId, setSelectedInscriptionId] = useState("");
  const [destination, setDestination] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const [ownershipProofVersion, setOwnershipProofVersion] = useState(0);
  const [mobileNativeTransferReady, setMobileNativeTransferReady] = useState<MobileNativeTransferReady | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [psbtReview, setPsbtReview] = useState<PsbtReviewState | null>(null);
  const [psbtSigning, setPsbtSigning] = useState(false);
  const psbtReviewResolverRef = useRef<PsbtReviewResolver | null>(null);
  const psbtReviewSignPsbtRef = useRef<((plan: OrdinalTransferPlan) => Promise<string>) | null>(null);
  const [transferError, setTransferError] = useState("");
  const [transferOutcomeUnclear, setTransferOutcomeUnclear] = useState(() => {
    try {
      return typeof window !== "undefined" && window.sessionStorage.getItem(TRANSFER_OUTCOME_UNCLEAR_SESSION_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [transferOutcomeChecked, setTransferOutcomeChecked] = useState(false);
  const [txid, setTxid] = useState("");
  const [mempoolStatus, setMempoolStatus] = useState<MempoolTrackingStatus>("idle");
  const [mempoolMessage, setMempoolMessage] = useState("");
  const [mempoolNetwork, setMempoolNetwork] = useState("");
  const [mempoolBlockHeight, setMempoolBlockHeight] = useState<number | null>(null);
  const [mempoolExplorerUrl, setMempoolExplorerUrl] = useState("");
  const [mempoolFeeRate, setMempoolFeeRate] = useState<number | null>(null);
  const [feeSourceLabel, setFeeSourceLabel] = useState("");
  const [finalReceipt, setFinalReceipt] = useState<TransferReceipt | null>(null);
  const [transferLiveData, setTransferLiveData] = useState<LiveInscription | null>(null);
  const [transferLiveLoading, setTransferLiveLoading] = useState(false);
  const [transferLiveError, setTransferLiveError] = useState("");
  const trackingRunRef = useRef(0);
  const inscriptionLoadRunRef = useRef(0);
  const inscriptionLoadControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    const pending = psbtReviewResolverRef.current;
    psbtReviewResolverRef.current = null;
    psbtReviewSignPsbtRef.current = null;
    pending?.resolve(false);
  }, []);
  const [localInscriptionImages, setLocalInscriptionImages] = useState<Record<string, string>>({});
  const [walletInscriptionsPage, setWalletInscriptionsPage] = useState(0);
  const [inscriptionSearch, setInscriptionSearch] = useState("");
  const [walletDisplayMode, setWalletDisplayMode] = useState<"mosaic" | "compact" | "list">("mosaic");
  const destinationInputRef = useRef<HTMLInputElement>(null);
  const [walletDashboard, setWalletDashboard] = useState<{
    confirmed: number | null; unconfirmed: number | null; total: number | null;
    available: number | null; unavailable: number | null; publicKey: string | null;
    utxoCount: number; utxoSats: number; refreshedAt: string;
  } | null>(null);
  const ownershipContextKey = selectedInscriptionId && destination.trim()
    ? JSON.stringify(["ordinal-transfer", site, address, chain?.enum, selectedInscriptionId, destination.trim()])
    : "";
  const mobileNativeReadyForContext = mobileNativeTransferReady?.contextKey === ownershipContextKey ? mobileNativeTransferReady : null;
  useEffect(() => {
    if (!isMobileUniSatDevice()) return;
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    setMobileNativeTransferReady(null);
  }, [ownershipContextKey]);
  useEffect(() => {
    if (!isMobileUniSatDevice()) return;
    if (!ownershipProofKey) setMobileNativeTransferReady(null);
  }, [ownershipProofKey]);

  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}assets/ordinal-punks/collection-data.json`, { cache: "force-cache" })
      .then(response => response.ok ? response.json() as Promise<Array<{ id?: string; fileName?: string }>> : [])
      .then(records => {
        if (!active) return;
        const images: Record<string, string> = {};
        for (const record of records) {
          if (record.id && record.fileName) images[record.id.toLowerCase()] = `${import.meta.env.BASE_URL}assets/ordinal-punks/images/${encodeURIComponent(record.fileName)}`;
        }
        setLocalInscriptionImages(images);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const resetMempoolTracking = () => {
    trackingRunRef.current += 1;
    setMempoolStatus("idle");
    setMempoolMessage("");
    setMempoolNetwork("");
    setMempoolBlockHeight(null);
    setMempoolExplorerUrl("");
  };

  const refreshWalletDashboard = async () => {
    const provider = window.unisat;
    if (!provider || !address) return;
    const results = await Promise.allSettled([
      provider.getBalance ? provider.getBalance() : Promise.resolve(null),
      provider.getBalanceV2 ? provider.getBalanceV2() : Promise.resolve(null),
      provider.getPublicKey ? provider.getPublicKey() : Promise.resolve(null),
      provider.getBitcoinUtxos ? provider.getBitcoinUtxos(0, 100) : Promise.resolve(null),
    ]);
    const balance = results[0].status === "fulfilled" ? results[0].value : null;
    const balanceV2 = results[1].status === "fulfilled" ? results[1].value : null;
    const publicKey = results[2].status === "fulfilled" && typeof results[2].value === "string" ? results[2].value : null;
    const raw = results[3].status === "fulfilled" ? results[3].value : null;
    const utxos: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "list" in raw && Array.isArray(raw.list) ? raw.list : [];
    const utxoSats = utxos.reduce<number>((sum, item) => {
      if (!item || typeof item !== "object") return sum;
      const value = Number((item as { value?: unknown; satoshis?: unknown; amount?: unknown }).value ?? (item as { satoshis?: unknown }).satoshis ?? (item as { amount?: unknown }).amount ?? 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
    setWalletDashboard({
      confirmed: balance ? Number(balance.confirmed ?? 0) : null,
      unconfirmed: balance ? Number(balance.unconfirmed ?? 0) : null,
      total: balance ? Number(balance.total ?? 0) : null,
      available: balanceV2 ? Number(balanceV2.available ?? 0) : null,
      unavailable: balanceV2 ? Number(balanceV2.unavailable ?? 0) : null,
      publicKey, utxoCount: utxos.length, utxoSats, refreshedAt: new Date().toISOString(),
    });
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

  const stopLoadingInscriptions = () => {
    inscriptionLoadRunRef.current += 1;
    inscriptionLoadControllerRef.current?.abort();
    inscriptionLoadControllerRef.current = null;
    setLoadingInscriptions(false);
    setBusy(false);
  };
  const disconnectWallet = async () => {
    stopLoadingInscriptions();
    const provider = window.unisat as (typeof window.unisat & { disconnect?: () => Promise<void> }) | undefined;
    try { await provider?.disconnect?.(); } catch { /* local session still clears */ }
    setAddress(null);
    setChain(null);
    setWalletDashboard(null);
    setDestination("");
    setError("");
    setTransferError("");
    clearOwnedInscriptions();
  };
  const clearOwnedInscriptions = () => {
    stopLoadingInscriptions();
    setWalletDashboard(null);
    setMempoolFeeRate(null);
    setInscriptions([]);
    setInscriptionsLoaded(false);
    setInscriptionTotal(0);
    setInscriptionCursor(0);
    setWalletInscriptionsPage(0);
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

  const loadInscriptions = async (append = false, targetId?: string, accountAddress = address) => {
    const provider = window.unisat;
    if (!provider?.getInscriptions) {
      setTransferError("Update UniSat Wallet to view inscriptions from this site.");
      return;
    }
    const loadRun = ++inscriptionLoadRunRef.current;
    inscriptionLoadControllerRef.current?.abort();
    const controller = new AbortController();
    inscriptionLoadControllerRef.current = controller;
    setLoadingInscriptions(true);
    setBusy(true);
    setTransferError("");
    try {
      const currentChain = await window.unisat?.getChain?.();
      if (controller.signal.aborted || loadRun !== inscriptionLoadRunRef.current) return;
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
        if (controller.signal.aborted || loadRun !== inscriptionLoadRunRef.current) return;
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
      if (!controller.signal.aborted && loadRun === inscriptionLoadRunRef.current) {
        setTransferError(describeWalletError(cause, "Could not load inscriptions from UniSat."));
      }
    } finally {
      if (loadRun === inscriptionLoadRunRef.current) {
        inscriptionLoadControllerRef.current = null;
        setLoadingInscriptions(false);
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!address || !isSupportedMainnet(chain?.enum)) { setWalletDashboard(null); return; }
    void refreshWalletDashboard();
    const timer = window.setInterval(() => void refreshWalletDashboard(), 15_000);
    return () => window.clearInterval(timer);
  }, [address, chain?.enum, inscriptions.length, inscriptionTotal]);

  const refreshConfirmedLiveData = async (transactionId: string, inscriptionId: string, networkEnum: string, run: number) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (run !== trackingRunRef.current) return;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const liveAfter = await fetchLiveInscription(inscriptionId, controller.signal, networkEnum, true);
        if (run !== trackingRunRef.current) return;
        setFinalReceipt(current => current && current.txid === transactionId
          ? { ...current, status: "confirmed", message: "Transaction confirmed on-chain. Données live actualisées.", checkedAt: new Date().toISOString(), liveAfter }
          : current);
        return;
      } catch {
        // Keep Mempool confirmation authoritative while the optional UniSat indexer is retried.
      } finally {
        window.clearTimeout(timeout);
      }
      if (attempt < 4) await new Promise(resolve => window.setTimeout(resolve, 5_000));
    }
    if (run !== trackingRunRef.current) return;
    setFinalReceipt(current => current && current.txid === transactionId
      ? { ...current, status: "confirmed", message: "Transaction confirmed on-chain. Les données UniSat live restent indisponibles; la confirmation Mempool est conservée.", checkedAt: new Date().toISOString() }
      : current);
  };

  const trackTransaction = async (transactionId: string, networkEnum?: string, liveBefore?: LiveInscription | null) => {
    const config = MEMPOOL_ENDPOINTS[networkEnum ?? FRACTAL_MAINNET] ?? MEMPOOL_ENDPOINTS[FRACTAL_MAINNET];
    const run = ++trackingRunRef.current;
    setMempoolStatus("checking");
    setMempoolMessage("Checking the transaction in Mempool…");
    setMempoolNetwork(config.label);
    setMempoolBlockHeight(null);
    setMempoolExplorerUrl(`${config.explorer}${encodeURIComponent(transactionId)}`);
    setFinalReceipt({ txid: transactionId, network: config.label, status: "checking", message: "Searching for the transaction in Mempool…", blockHeight: null, explorerUrl: `${config.explorer}${encodeURIComponent(transactionId)}`, checkedAt: new Date().toISOString(), liveBefore });

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
            setFinalReceipt(current => current ? { ...current, status: "confirmed", message: liveBefore ? "Transaction confirmed on-chain. Synchronisation des données UniSat en cours…" : "Transaction confirmed on-chain.", blockHeight: typeof status.block_height === "number" ? status.block_height : null, checkedAt: new Date().toISOString() } : current);
            if (liveBefore) void refreshConfirmedLiveData(transactionId, liveBefore.inscriptionId, networkEnum ?? FRACTAL_MAINNET, run);
            return;
          }
          setMempoolStatus("pending");
          setMempoolMessage("Transaction is visible in the mempool and is waiting for confirmation.");
          setFinalReceipt(current => current ? { ...current, status: "pending", message: "Transaction visible dans le mempool, en attente de confirmation.", checkedAt: new Date().toISOString() } : current);
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
        setFinalReceipt(current => current ? { ...current, status: "error", message: "Mempool is temporarily unavailable; retrying automatically.", checkedAt: new Date().toISOString() } : current);
      } finally {
        window.clearTimeout(timeout);
      }
      await new Promise(resolve => window.setTimeout(resolve, 10_000));
    }
    if (run === trackingRunRef.current) {
      setMempoolStatus("timeout");
      setMempoolMessage("No confirmation received after 30 minutes. Check the transaction in Mempool.");
      setFinalReceipt(current => current ? { ...current, status: "timeout", message: "No confirmation after 30 minutes.", checkedAt: new Date().toISOString() } : current);
    }
  };

  const resolvePsbtReview = (result: boolean | string) => {
    const pending = psbtReviewResolverRef.current;
    psbtReviewResolverRef.current = null;
    psbtReviewSignPsbtRef.current = null;
    setPsbtReview(null);
    pending?.resolve(result);
  };

  const rejectPsbtReview = (cause: unknown) => {
    const pending = psbtReviewResolverRef.current;
    psbtReviewResolverRef.current = null;
    psbtReviewSignPsbtRef.current = null;
    setPsbtReview(null);
    pending?.reject(cause);
  };

  const requestPsbtReview = (review: PsbtReviewState) => new Promise<boolean | string>((resolve, reject) => {
    psbtReviewResolverRef.current = { resolve, reject };
    setPsbtReview(review);
  });

  const approvePsbtReview = () => {
    const review = psbtReview;
    const signPsbt = psbtReviewSignPsbtRef.current;
    if (!review || !signPsbt || !psbtReviewResolverRef.current) return;
    if (isMobileUniSatDevice() && (!ownershipContextKey || ownershipProofKey !== ownershipContextKey)) {
      const cause = new Error("The wallet ownership check is missing or no longer matches the transfer. No PSBT was signed.");
      setTransferError(cause.message);
      rejectPsbtReview(cause);
      return;
    }
    setPsbtSigning(true);
    if (isMobileUniSatDevice()) {
      setOwnershipProofKey(null);
      setOwnershipProofVersion(version => version + 1);
      setMobileNativeTransferReady(null);
    }
    try {
      // Invoke the UniSat bridge synchronously from this explicit user click.
      const signing = signPsbt(review.plan);
      psbtReviewSignPsbtRef.current = null;
      setPsbtReview(null);
      void signing
        .then(signedPsbtHex => resolvePsbtReview(signedPsbtHex))
        .catch(cause => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          rejectPsbtReview(new Error(`UNISAT_PSBT_SIGN_FAILED: ${detail}`));
        })
        .finally(() => setPsbtSigning(false));
    } catch (cause) {
      setPsbtSigning(false);
      const detail = cause instanceof Error ? cause.message : String(cause);
      rejectPsbtReview(new Error(`UNISAT_PSBT_SIGN_FAILED: ${detail}`));
    }
  };

  const sendSelectedInscription = async () => {
    if (transferOutcomeUnclear) {
      setTransferError("A previous UniSat transfer response had an uncertain outcome. Check UniSat activity and the selected network's mempool before authorizing another transfer.");
      return;
    }
    const provider = window.unisat;
    const recipient = destination.trim();
    const selected = inscriptions.find(item => item.inscriptionId === selectedInscriptionId);
    setTransferError("");
    setTxid("");
    setFinalReceipt(null);

    if (isMobileBrowser() && !isUniSatMobileContext()) {
      setTransferError("Open this page in UniSat's in-app browser before transferring. No transfer request was sent.");
      return;
    }
    if (!provider?.getChain) {
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
    const useNativeInscription = Boolean(provider.sendInscription) && !(isMobileUniSatDevice() && chain?.enum === FRACTAL_MAINNET);
    const useVerifiedPsbt =
      isSupportedMainnet(chain?.enum) &&
      !useNativeInscription;
    if (!isSupportedMainnet(chain?.enum)) {
      setTransferError("This UniSat version exposes neither sendInscription nor all verified PSBT methods required for this network. Update UniSat; no transfer was signed or broadcast.");
      return;
    }
    if (useVerifiedPsbt && (!provider.getBitcoinUtxos || !provider.getPublicKey || !provider.getAccounts || !provider.signPsbt)) {
      setTransferError("This UniSat version exposes neither sendInscription nor all verified PSBT methods required for this network. Update UniSat; no transfer was signed or broadcast.");
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
    if (isMobileUniSatDevice() && (!ownershipContextKey || ownershipProofKey !== ownershipContextKey)) {
      setTransferError("Complete the wallet ownership check shown below the receipt first. No transaction was opened.");
      return;
    }

    if (isMobileUniSatDevice()) setMobileNativeTransferReady(null);
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

      const liveBefore = transferLiveData ?? await fetchLiveInscription(selected.inscriptionId, undefined, activeNetworkEnum);
      setTransferLiveData(liveBefore);
      await validateMempoolAddress(activeNetworkEnum, recipient);
      const feeEstimate = await getRecommendedFeeEstimate(activeNetworkEnum);
      const feeRate = feeEstimate.feeRate;
      setFeeSourceLabel(describeFeeSources(feeEstimate.strategy, feeEstimate.sources));
      setMempoolFeeRate(feeRate);
      let returnedTxid: string | undefined;
      if (useNativeInscription) {
        if (isMobileUniSatDevice()) await ensureNativeInscriptionFeeBalance(activeNetworkEnum, address, { location: selected.location }, feeRate);
        if (isMobileUniSatDevice()) {
          setMobileNativeTransferReady({ contextKey: ownershipContextKey, address, networkEnum: activeNetworkEnum, recipient, selected, feeRate, liveBefore });
          setTransferError("Pre-check complete. Tap again to open the separate UniSat transaction approval.");
          return;
        }
        returnedTxid = await sendNativeUniSatInscription(provider, recipient, selected.inscriptionId, feeRate);
      } else if (useVerifiedPsbt) {
        const mempool = getMempoolConfig(activeNetworkEnum);
        if (!mempool) throw new Error("The selected network Mempool is not configured; no transaction was signed or broadcast.");
        const psbtProvider = provider as Required<Pick<UniSatProvider, "getChain" | "getAccounts" | "getPublicKey" | "getBitcoinUtxos" | "signPsbt">>;
        const { sendOrdinalInscriptionWithCustomPsbt } = await import("@/lib/custom-ordinal-transfer");
        const requestSignature = psbtProvider.signPsbt.bind(provider);
        psbtReviewSignPsbtRef.current = plan => requestSignature(plan.psbtHex, {
          autoFinalized: false,
          toSignInputs: plan.inputs.map((input, index) => ({
            index,
            address,
            publicKey: plan.publicKeyHex,
            ...(input.spendType === "taproot" ? { useTweakedSigner: true } : {}),
          })),
        });
        const currentFeeSourceLabel = describeFeeSources(feeEstimate.strategy, feeEstimate.sources);
        const result = await sendOrdinalInscriptionWithCustomPsbt({
          provider: {
            getBitcoinUtxos: psbtProvider.getBitcoinUtxos.bind(provider),
            getPublicKey: psbtProvider.getPublicKey.bind(provider),
            getAccounts: psbtProvider.getAccounts.bind(provider),
            getChain: psbtProvider.getChain.bind(provider),
            signPsbt: psbtProvider.signPsbt.bind(provider),
          },
          mempool: { api: mempool.api, label: mempool.label, chain: activeNetworkEnum === BITCOIN_MAINNET ? "bitcoin" : "fractal" },
          expectedNetworkEnum: activeNetworkEnum,
          currentAddress: address,
          recipientAddress: recipient,
          selectedInscription: { inscriptionId: selected.inscriptionId, location: selected.location },
          ownedInscriptions: inscriptions.map(item => ({ inscriptionId: item.inscriptionId, location: item.location })),
          feeRateSatVb: feeRate,
          beforeSign: plan => requestPsbtReview({
            plan,
            recipientAddress: recipient,
            inscriptionId: selected.inscriptionId,
            networkLabel: mempool.label,
            feeSourceLabel: currentFeeSourceLabel,
          }),
          beforeBroadcast: async publicKeyHex => {
            const [latestChain, latestAccounts, latestPublicKey] = await Promise.all([
              psbtProvider.getChain(),
              psbtProvider.getAccounts(),
              psbtProvider.getPublicKey(),
            ]);
            if (latestChain.enum !== activeNetworkEnum || !latestAccounts.includes(address) || latestPublicKey.toLowerCase() !== publicKeyHex.toLowerCase()) {
              throw new Error("The UniSat account, key or network changed before broadcast. The signed transaction was not submitted.");
            }
          },
        });
        returnedTxid = result.txid;
      } else {
        throw new Error("No supported UniSat inscription-transfer method is available; no transfer was sent.");
      }
      if (!returnedTxid || !/^[a-f0-9]{64}$/i.test(returnedTxid)) {
        throw new Error("The transfer did not return a valid transaction ID. Check UniSat and Mempool before retrying.");
      }
      setTxid(returnedTxid);
      if (isMobileUniSatDevice()) {
        void refreshWalletDashboard();
        window.setTimeout(() => void refreshWalletDashboard(), 3000);
      }
      void trackTransaction(returnedTxid, currentChain.enum, liveBefore);
      setInscriptions(previous => previous.filter(item => item.inscriptionId !== selected.inscriptionId));
      setInscriptionTotal(previous => Math.max(0, previous - 1));
      setSelectedInscriptionId("");
      setConfirmed(false);
      setDestination("");
    } catch (cause) {
      const mobileUtxoGuidance = isMobileUniSatDevice() ? getMobileUtxoErrorGuidance(cause, "ordinal-transfer") : null;
      const message = mobileUtxoGuidance?.message ?? describeWalletError(cause, "Transfer was cancelled or failed in UniSat.");
      const signingFailedBeforeSiteBroadcast = cause instanceof Error && cause.message.includes("UNISAT_PSBT_SIGN_FAILED:");
      if (!signingFailedBeforeSiteBroadcast && !mobileUtxoGuidance?.definitelyNotBroadcast && (isTransferOutcomeUnclear(cause) || isTransferOutcomeUnclear(message))) {
        setTransferOutcomeUnclear(true);
        setTransferOutcomeChecked(false);
        try {
          window.sessionStorage.setItem(TRANSFER_OUTCOME_UNCLEAR_SESSION_KEY, "1");
        } catch {
          // The in-memory lock remains active if session storage is unavailable.
        }
      }
      setTransferError(message);
    } finally {
      psbtReviewSignPsbtRef.current = null;
      setPsbtSigning(false);
      setTransferBusy(false);
    }
  };

  const openMobileNativeTransfer = () => {
    const ready = mobileNativeReadyForContext;
    const provider = window.unisat;
    if (!isMobileUniSatDevice() || !ready || !provider?.sendInscription || ready.address !== address || ready.networkEnum !== chain?.enum) {
      setTransferError("The mobile transfer must be pre-checked with the current account. Prepare it again.");
      setMobileNativeTransferReady(null);
      return;
    }
    if (ownershipProofKey !== ready.contextKey || ready.contextKey !== ownershipContextKey) {
      setTransferError("The wallet ownership check no longer matches this transfer. Complete a new check before continuing.");
      setMobileNativeTransferReady(null);
      return;
    }

    setTransferError("");
    setTxid("");
    setTransferBusy(true);
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    setMobileNativeTransferReady(null);
    let transferPromise: Promise<string>;
    try {
      // sendNativeUniSatInscription calls sendInscription before its first await,
      // preserving UniSat Mobile's user-gesture requirement on this explicit tap.
      transferPromise = sendNativeUniSatInscription(provider, ready.recipient, ready.selected.inscriptionId, ready.feeRate);
    } catch (cause) {
      setTransferBusy(false);
      const mobileUtxoGuidance = getMobileUtxoErrorGuidance(cause, "ordinal-transfer");
      setTransferError(mobileUtxoGuidance?.message ?? describeWalletError(cause, "Transfer was cancelled or failed in UniSat."));
      return;
    }
    void transferPromise
      .then(returnedTxid => {
        if (!/^[a-f0-9]{64}$/i.test(returnedTxid)) throw new Error("The transfer did not return a valid transaction ID. Check UniSat and Mempool before retrying.");
        setTxid(returnedTxid);
        void refreshWalletDashboard();
        window.setTimeout(() => void refreshWalletDashboard(), 3000);
        void trackTransaction(returnedTxid, ready.networkEnum, ready.liveBefore);
        setInscriptions(previous => previous.filter(item => item.inscriptionId !== ready.selected.inscriptionId));
        setInscriptionTotal(previous => Math.max(0, previous - 1));
        setSelectedInscriptionId("");
        setConfirmed(false);
        setDestination("");
      })
      .catch(cause => {
        const mobileUtxoGuidance = getMobileUtxoErrorGuidance(cause, "ordinal-transfer");
        const message = mobileUtxoGuidance?.message ?? describeWalletError(cause, "Transfer was cancelled or failed in UniSat.");
        if (!mobileUtxoGuidance?.definitelyNotBroadcast && (isTransferOutcomeUnclear(cause) || isTransferOutcomeUnclear(message))) {
          setTransferOutcomeUnclear(true);
          setTransferOutcomeChecked(false);
          try { window.sessionStorage.setItem(TRANSFER_OUTCOME_UNCLEAR_SESSION_KEY, "1"); } catch { /* in-memory lock remains active */ }
        }
        setTransferError(message);
      })
      .finally(() => setTransferBusy(false));
  };

  const connectedToFractal = Boolean(address && isSupportedMainnet(chain?.enum));
  const currentNetwork = getMempoolConfig(chain?.enum);
  const nativeInscriptionTransfer = Boolean(window.unisat?.sendInscription) && !(isMobileUniSatDevice() && chain?.enum === FRACTAL_MAINNET);
  const verifiedOrdinalTransfer =
    isSupportedMainnet(chain?.enum) &&
    !nativeInscriptionTransfer;
  const mobilePsbtTransferUnavailable =
    isMobileUniSatDevice() && connectedToFractal && !nativeInscriptionTransfer &&
    (!window.unisat?.getBitcoinUtxos || !window.unisat?.getPublicKey || !window.unisat?.getAccounts || !window.unisat?.signPsbt);
  const walletPageSize = 10;
  const normalizedInscriptionSearch = inscriptionSearch.trim().toLowerCase();
  const filteredInscriptions = normalizedInscriptionSearch
    ? inscriptions.filter(item => [item.inscriptionId, item.inscriptionNumber != null ? String(item.inscriptionNumber) : "", item.location ?? ""]
      .some(value => value.toLowerCase().includes(normalizedInscriptionSearch)))
    : inscriptions;
  const walletPageCount = Math.max(1, Math.ceil(filteredInscriptions.length / walletPageSize));
  const walletPageItems = filteredInscriptions.slice(walletInscriptionsPage * walletPageSize, walletInscriptionsPage * walletPageSize + walletPageSize);
  const inscriptionSearchMatch = filteredInscriptions[0];
  const inscriptionSearchUniScanUrl = inscriptionSearchMatch
    ? `https://uniscan.cc/${chain?.enum === FRACTAL_MAINNET ? "fractal" : "bitcoin"}/inscription/${encodeURIComponent(inscriptionSearchMatch.inscriptionId)}`
    : "#";
  const walletGalleryClassName = walletDisplayMode === "list"
    ? "mt-4 grid grid-cols-1 gap-3"
    : walletDisplayMode === "compact"
      ? "mt-4 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2"
      : "mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5";
  const walletPreviewClassName = walletDisplayMode === "list"
    ? "aspect-[5/1] overflow-hidden border border-[#2c323a] bg-[#14191f] sm:aspect-[7/1]"
    : "aspect-square overflow-hidden border border-[#2c323a] bg-[#14191f]";
  useEffect(() => {
    if (!selectedInscriptionId) return;
    const selectedIndex = inscriptions.findIndex(item => sameInscriptionId(item.inscriptionId, selectedInscriptionId));
    if (selectedIndex >= 0) setWalletInscriptionsPage(Math.floor(selectedIndex / walletPageSize));
  }, [selectedInscriptionId, inscriptions]);
  const selectInscriptionForTransfer = (inscriptionId: string) => {
    setSelectedInscriptionId(inscriptionId);
    setConfirmed(false);
    setTxid("");
    resetMempoolTracking();
    setTransferError("Enter a receiving address to generate the live pre-confirmation receipt.");
    window.setTimeout(() => {
      document.getElementById("wallet-transfer-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      destinationInputRef.current?.focus();
    }, 80);
  };
  const selectedInscription = inscriptions.find(item => item.inscriptionId === selectedInscriptionId);

  useEffect(() => {
    if (!selectedInscriptionId) { setTransferLiveData(null); setTransferLiveError(""); return; }
    let active = true;
    setTransferLiveLoading(true); setTransferLiveError("");
    void fetchLiveInscription(selectedInscriptionId, undefined, chain?.enum ?? FRACTAL_MAINNET).then(data => { if (active) setTransferLiveData(data); }).catch(error => { if (active) setTransferLiveError(error instanceof Error ? error.message : "Live UniSat data unavailable."); }).finally(() => { if (active) setTransferLiveLoading(false); });
    return () => { active = false; };
  }, [selectedInscriptionId, chain?.enum]);
  const uniScanUrl = chain?.enum === FRACTAL_MAINNET
    ? `https://uniscan.cc/fractal/address/${encodeURIComponent(address ?? "")}`
    : `https://uniscan.cc/bitcoin/address/${encodeURIComponent(address ?? "")}`;
  const formatSats = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Unavailable" : `${Math.round(value).toLocaleString()} sats`;

  return (
    <div id="unisat-wallet-panel" className="unisat-wallet-panel flex flex-col gap-4 border border-[#2c323a] bg-[#14191f] p-4">
      <nav className="mobile-transaction-nav sticky top-0 z-30 -mx-4 -mt-4 mb-1 flex gap-2 overflow-x-auto border-b border-[#2c323a] bg-[#14191f]/95 px-3 py-2 backdrop-blur sm:hidden" aria-label="UniSat transaction shortcuts">
        <a href="#unisat-wallet-panel" className="inline-flex min-h-11 shrink-0 items-center justify-center border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6]">Wallet</a>
        {connectedToFractal && <a href={inscriptions.length > 0 ? "#wallet-transfer-form" : "#unisat-wallet-panel"} className="inline-flex min-h-11 shrink-0 items-center justify-center border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6]">Ordinals</a>}
        {connectedToFractal && <a href="#fb-send-title" className="inline-flex min-h-11 shrink-0 items-center justify-center border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6]">Send FB</a>}
        {connectedToFractal && <a href="#runes-send-title" className="inline-flex min-h-11 shrink-0 items-center justify-center border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[0.08em] text-[#d9d3c6]">Runes</a>}
        <a href="#inscribe-start" className="inline-flex min-h-11 shrink-0 items-center justify-center border border-[#d99a54] px-3 font-mono text-[9px] uppercase tracking-[0.08em] text-[#f2bd63]">Inscribe</a>
      </nav>
      {psbtReview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="fractal-psbt-review-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto border border-[#d99a54] bg-[#14191f] p-5 shadow-2xl">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Final transaction review</p>
            <h2 id="fractal-psbt-review-title" className="mt-2 font-display text-2xl text-[#f3efe5]">Confirm transaction before signing</h2>
            <div className="mt-4 space-y-2 border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
              <p><span className="text-[#718092]">Network:</span> {psbtReview.networkLabel}</p>
              <p className="break-all"><span className="text-[#718092]">Recipient:</span> {psbtReview.recipientAddress}</p>
              <p className="break-all"><span className="text-[#718092]">Inscription:</span> {psbtReview.inscriptionId}</p>
              <p><span className="text-[#718092]">Recipient output:</span> {formatSats(psbtReview.plan.recipientOutputSats)}</p>
              <p><span className="text-[#718092]">Wallet change:</span> {formatSats(psbtReview.plan.changeOutputSats)}</p>
              <p><span className="text-[#718092]">Total fee:</span> {formatSats(psbtReview.plan.feeSats)}</p>
              <p><span className="text-[#718092]">Fee rate:</span> {psbtReview.feeSourceLabel}: {psbtReview.plan.feeRateSatVb} sat/vB · estimated {psbtReview.plan.estimatedVsize} vB</p>
              <p><span className="text-[#718092]">RBF:</span> opt-in signaled; this site has no replacement or fee-bump control.</p>
            </div>
            <p className="mt-3 font-mono text-[10px] leading-5 text-[#e0b45f]">The Cloudflare Worker supplies protocol-checked fee UTXOs. UniSat signs only after your approval; the signed transaction is verified locally, then submitted to the selected network Mempool for validation and broadcast. Do not approve if any detail differs.</p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" disabled={psbtSigning} onClick={() => resolvePsbtReview(false)} className="border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#d9d3c6] hover:border-[#a45e54] disabled:opacity-50">Cancel — do not sign</button>
              <button type="button" disabled={psbtSigning} onClick={approvePsbtReview} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-50">{psbtSigning ? "Waiting for UniSat…" : "Approve in UniSat"}</button>
            </div>
          </div>
        </div>
      )}
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
                disabled={busy || transferBusy || loadingInscriptions}
                className="border border-[#d99a54] bg-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-50"
              >
                {loadingInscriptions ? "Loading wallet…" : "Load my inscriptions"}
              </button>
              {loadingInscriptions && (
                <button type="button" onClick={stopLoadingInscriptions} disabled={transferBusy} className="border border-[#a45e54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#e08b7d] hover:bg-[#a45e54]/10 disabled:opacity-50">
                  Stop loading
                </button>
              )}
              <button
                type="button"
                onClick={() => void disconnectWallet()}
                disabled={transferBusy}
                className="border border-[#3b434d] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#d9d3c6] hover:border-[#d99a54] disabled:opacity-50"
              >
                Disconnect UniSat
              </button>
              <button
                type="button"
                onClick={() => void disconnectWallet()}
                disabled={transferBusy}
                className="border border-[#a45e54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#e08b7d] hover:bg-[#a45e54]/10 disabled:opacity-50"
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

      {connectedToFractal && (
        <div className="border-y border-[#d99a54]/50 bg-[#d99a54]/5 p-3 font-mono text-[10px] leading-5 text-[#e0b45f]" role="note">
          <p className="uppercase tracking-[0.12em]">{nativeInscriptionTransfer ? "UniSat native sendInscription" : "Verified UniSat PSBT transfer"}</p>
          <p className="mt-1">{nativeInscriptionTransfer ? "UniSat constructs, reviews and broadcasts the ordinal transfer after its native approval; verify the recipient, inscription and fees in the wallet." : "The site validates the recipient, asset-safe fee UTXOs, exact outputs and fees before opening UniSat. UniSat reviews and signs the PSBT; Mempool validates and broadcasts it."}</p>
        </div>
      )}
      {transferOutcomeUnclear && (
        <div className="border border-[#a45e54]/70 bg-[#a45e54]/10 p-3 font-mono text-[10px] leading-5 text-[#e08b7d]" role="alert">
          <p className="uppercase tracking-[0.12em]">Previous transfer outcome is unknown</p>
          <p className="mt-1">Do not submit another request yet. Check UniSat activity and Mempool for {currentNetwork?.label ?? "the selected network"}. If a transaction is visible or confirmed, do not unlock another attempt.</p>
          <label className="mt-2 flex cursor-pointer items-start gap-2 text-[#d9d3c6]">
            <input type="checkbox" checked={transferOutcomeChecked} onChange={event => setTransferOutcomeChecked(event.target.checked)} className="mt-0.5 accent-[#d99a54]" />
            <span>I checked UniSat activity and the selected network’s Mempool; no transaction from the previous attempt is pending or confirmed.</span>
          </label>
          <button type="button" disabled={!transferOutcomeChecked} onClick={() => { try { window.sessionStorage.removeItem(TRANSFER_OUTCOME_UNCLEAR_SESSION_KEY); } catch { /* The in-memory lock can still be cleared after the explicit check. */ } setTransferOutcomeUnclear(false); setTransferOutcomeChecked(false); setConfirmed(false); setTransferError(""); }} className="mt-2 border border-[#a45e54] px-3 py-2 uppercase tracking-[0.08em] text-[#f3efe5] disabled:cursor-not-allowed disabled:opacity-40">Unlock a new attempt after verification</button>
        </div>
      )}

      {connectedToFractal && (
        <section className="border-t border-[#2c323a] pt-4" aria-labelledby="wallet-dashboard-title">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Live wallet data</p><h2 id="wallet-dashboard-title" className="mt-1 font-display text-xl text-[#f3efe5]">Wallet dashboard</h2></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void refreshWalletDashboard()} disabled={busy} className="inline-flex items-center gap-1 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#9ea7b3] hover:border-[#d99a54] disabled:opacity-40"><RefreshCw size={12} /> Refresh live data</button><a href={uniScanUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] hover:bg-[#d99a54]/10">Open UniScan <ExternalLink size={12} /></a></div></div>
          <div className="mt-3 grid grid-cols-2 gap-px border border-[#2c323a] bg-[#2c323a] sm:grid-cols-3 lg:grid-cols-6"><div className="bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Network</p><p className="mt-2 font-mono text-[10px] text-[#f2bd63]">{currentNetwork?.label}</p></div><div className="bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">FB total</p><p className="mt-2 font-mono text-[10px] text-[#f2bd63]">{formatSats(walletDashboard?.total)}</p></div><div className="bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Available</p><p className="mt-2 font-mono text-[10px] text-[#70c7a0]">{formatSats(walletDashboard?.available)}</p></div><div className="bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Inscriptions</p><p className="mt-2 font-mono text-[10px] text-[#f2bd63]">{inscriptions.length} / {inscriptionTotal}</p></div><div className="bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">UTXOs</p><p className="mt-2 font-mono text-[10px] text-[#f2bd63]">{walletDashboard?.utxoCount ?? "—"}</p></div><div className="bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">UTXO value</p><p className="mt-2 font-mono text-[10px] text-[#f2bd63]">{formatSats(walletDashboard?.utxoSats)}</p></div></div>
          <div className="mt-3 grid gap-2 border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px] text-[#9ea7b3] sm:grid-cols-2"><p className="break-all sm:col-span-2"><span className="text-[#718092]">Connected address:</span> {address}</p><p><span className="text-[#718092]">Confirmed:</span> {formatSats(walletDashboard?.confirmed)}</p><p><span className="text-[#718092]">Unconfirmed:</span> {formatSats(walletDashboard?.unconfirmed)}</p><p><span className="text-[#718092]">Unavailable:</span> {formatSats(walletDashboard?.unavailable)}</p><p><span className="text-[#718092]">Last refresh:</span> {walletDashboard ? new Date(walletDashboard.refreshedAt).toLocaleTimeString() : "Loading…"}</p>{walletDashboard?.publicKey && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Public key:</span> {walletDashboard.publicKey}</p>}</div>
        </section>
      )}
      {connectedToFractal && (
        <UniSatWalletAuth key={`${address ?? ""}:${chain?.enum ?? ""}`} site="punks" address={address ?? ""} network={chain?.enum ?? ""} provider={window.unisat} />
      )}
      {connectedToFractal && (
        <UniSatFbSendPanel provider={window.unisat} address={address ?? ""} chain={chain} onWalletRefresh={() => { void refreshWalletDashboard(); }} onSwitchToFractal={() => { void switchToFractal(); }} walletBusy={busy} site={site} />
      )}
      {connectedToFractal && (
        <UniSatRunesSendPanel site={site} address={address ?? ""} chain={chain} onWalletRefresh={() => { void refreshWalletDashboard(); }} />
      )}
      {connectedToFractal && inscriptions.length > 0 && (
        <section className="border-t border-[#2c323a] pt-4" aria-labelledby="wallet-gallery-title">
          <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Live wallet collection</p><h2 id="wallet-gallery-title" className="mt-1 font-display text-xl text-[#f3efe5]">My inscriptions</h2><p className="mt-1 font-mono text-[10px] text-[#718092]">Live data from the connected UniSat wallet · 10 per page</p></div><div className="flex w-full flex-wrap items-center gap-2 sm:w-auto"><div className="flex items-center border border-[#30363d] bg-[#151a1f] p-1"><button type="button" onClick={() => setWalletDisplayMode("mosaic")} className={`px-2 py-1 font-mono text-[9px] uppercase transition-colors ${walletDisplayMode === "mosaic" ? "bg-[#454d56] text-[#f0f2f4]" : "text-[#7e8994] hover:bg-[#30363d]"}`}>Mosaic</button><button type="button" onClick={() => setWalletDisplayMode("compact")} className={`px-2 py-1 font-mono text-[9px] uppercase transition-colors ${walletDisplayMode === "compact" ? "bg-[#30363d] text-[#d9d3c6]" : "text-[#7e8994] hover:bg-[#30363d]"}`}>Compact</button><button type="button" onClick={() => setWalletDisplayMode("list")} className={`px-2 py-1 font-mono text-[9px] uppercase transition-colors ${walletDisplayMode === "list" ? "bg-[#20262d] text-[#d9d3c6]" : "text-[#7e8994] hover:bg-[#30363d]"}`}>List</button></div><label className="sr-only" htmlFor="wallet-inscription-search">Search inscriptions</label><input id="wallet-inscription-search" value={inscriptionSearch} onChange={event => { setInscriptionSearch(event.target.value); setWalletInscriptionsPage(0); }} placeholder="Search ID, number or location" className="min-h-10 min-w-[220px] flex-1 border border-[#3b434d] bg-[#0f1317] px-3 py-2 font-mono text-[10px] text-[#d9d3c6] outline-none placeholder:text-[#66717e] focus:border-[#d99a54] sm:flex-none" /><a href={inscriptionSearchUniScanUrl} target={inscriptionSearchMatch ? "_blank" : undefined} rel={inscriptionSearchMatch ? "noreferrer" : undefined} onClick={event => { if (!inscriptionSearchMatch) event.preventDefault(); }} className={`inline-flex min-h-10 items-center border px-3 py-2 font-mono text-[9px] uppercase tracking-[0.08em] transition-colors ${inscriptionSearchMatch ? "border-[#d99a54] text-[#f2bd63] hover:bg-[#d99a54]/10" : "border-[#30363d] text-[#59636f]"}`}>Open result in UniScan</a><span className="bg-[#20262d] px-2 py-2 font-mono text-[10px] text-[#9aa3ad]">Page {walletInscriptionsPage + 1} / {walletPageCount}</span></div></div>
          <div className={walletGalleryClassName}>{walletPageItems.map(item => { const isSelected = sameInscriptionId(item.inscriptionId, selectedInscriptionId); return <article key={item.inscriptionId} className={`min-w-0 border bg-[#10151a] ${walletDisplayMode === "compact" ? "p-2" : "p-3"} ${isSelected ? "border-[#d99a54]" : "border-[#2c323a]"}`}><div className={walletPreviewClassName}><InscriptionPreview item={item} localImage={localInscriptionImages[item.inscriptionId.toLowerCase()]} /></div><p className="mt-3 truncate font-mono text-[10px] text-[#f2bd63]">{item.inscriptionNumber != null ? `#${item.inscriptionNumber}` : "Inscription"}</p><p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#d9d3c6]">{item.inscriptionId}</p><p className="mt-1 break-all font-mono text-[9px] leading-4 text-[#718092]">{item.location ?? "Location unavailable"}</p><div className="mt-3 grid grid-cols-1 gap-2 border-t border-[#2c323a] pt-3"><button type="button" onClick={() => selectInscriptionForTransfer(item.inscriptionId)} disabled={busy || transferBusy} className={`h-9 rounded-sm border-2 w-full justify-center px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] shadow-[0_0_0_1px_rgba(217,154,84,0.12)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isSelected ? "border-[#f2bd63] bg-[#d99a54] text-[#0b0d10]" : "border-[#d99a54] bg-[#d99a54]/10 text-[#f2bd63] hover:bg-[#d99a54]/25"}`}>Transfer</button><a href={getUniSatInscriptionUrl(chain?.enum, item.inscriptionId) ?? "#"} target="_blank" rel="noreferrer" className="inline-flex h-9 w-full justify-center items-center border border-[#3b434d] px-3 py-2 font-mono text-[10px] uppercase text-[#9ea7b3] transition-colors hover:border-[#d99a54] hover:text-[#f2bd63]">Live details</a></div></article>; })}</div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2"><button type="button" onClick={() => setWalletInscriptionsPage(page => Math.max(0, page - 1))} disabled={walletInscriptionsPage === 0} className="border border-[#3b4343] bg-[#30363d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] transition-colors hover:bg-[#3b4343] disabled:cursor-not-allowed disabled:bg-[#20262d] disabled:text-[#59636f]">Previous</button><span className="bg-[#20262d] px-3 py-2 font-mono text-[10px] text-[#9aa3ad]">{walletPageItems.length} shown · {filteredInscriptions.length} match · {inscriptions.length} total loaded</span><button type="button" onClick={() => setWalletInscriptionsPage(page => Math.min(walletPageCount - 1, page + 1))} disabled={walletInscriptionsPage >= walletPageCount - 1} className="border border-[#454d56] bg-[#454d56] px-3 py-2 font-mono text-[9px] uppercase text-[#f0f2f4] transition-colors hover:bg-[#515b66] disabled:cursor-not-allowed disabled:bg-[#20262d] disabled:text-[#59636f]">Next</button></div>
        </section>
      )}
      {connectedToFractal && inscriptions.length > 0 && (
        <section id="wallet-transfer-form" className="scroll-mt-20 border-t border-[#2c323a] pt-4" aria-labelledby="ordinal-transfer-title">
          <h3 id="ordinal-transfer-title" className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#d9d3c6]">
            On-chain Ordinal transfer · peer to peer
          </h3>
          <p className="mt-1 font-mono text-[10px] leading-5 text-[#7f8b99]">
            Choose an inscription you own and enter a receiving address for this transfer. UniSat will show its transaction and network fee before you sign.
          </p>
          <p className="mt-1 font-mono text-[10px] text-[#718092]" aria-live="polite">
            {mempoolFeeRate
              ? `${feeSourceLabel || "Live fee estimate"}: ${mempoolFeeRate} sat/vB. UniSat shows the final fee before approval.`
              : `Live fee estimate for ${currentNetwork?.label ?? "the selected network"} is fetched immediately before transfer.`}
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
                ref={destinationInputRef}
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
              <div className="mt-3 border border-[#d99a54]/60 bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]" aria-label="Transfer pre-confirmation receipt"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">Live pre-confirmation receipt</p><p><span className="text-[#718092]">Network:</span> {currentNetwork?.label}</p><p className="break-all"><span className="text-[#718092]">Wallet:</span> {address}</p>{isMobileBrowser() && <div className="mt-2 border-t border-[#2c323a] pt-2"><p className="uppercase text-[#f2bd63]">Live connected wallet data</p><p><span className="text-[#718092]">Available:</span> {formatSats(walletDashboard?.available)}</p><p><span className="text-[#718092]">Confirmed:</span> {formatSats(walletDashboard?.confirmed)}</p><p><span className="text-[#718092]">Total:</span> {formatSats(walletDashboard?.total)}</p><p><span className="text-[#718092]">Unavailable:</span> {formatSats(walletDashboard?.unavailable)}</p><p><span className="text-[#718092]">UTXOs:</span> {walletDashboard?.utxoCount ?? "Unavailable"} · {formatSats(walletDashboard?.utxoSats)}</p><p><span className="text-[#718092]">Wallet refresh:</span> {walletDashboard ? new Date(walletDashboard.refreshedAt).toLocaleTimeString() : "Loading…"}</p>{walletDashboard?.publicKey && <p className="break-all"><span className="text-[#718092]">Public key:</span> {walletDashboard.publicKey}</p>}</div>}<p className="break-all"><span className="text-[#718092]">Inscription:</span> {selectedInscription.inscriptionId}</p><p className="break-all"><span className="text-[#718092]">Location:</span> {selectedInscription.location ?? "Not provided by UniSat"}</p><p className="break-all"><span className="text-[#718092]">Recipient:</span> {destination.trim()}</p><p><span className="text-[#718092]">Fee estimate:</span> {mempoolFeeRate ? `${feeSourceLabel || "Live fee source"}: ${mempoolFeeRate} sat/vB · refreshed before signing` : "Live fee source estimate refreshed immediately before wallet approval"}</p>{transferLiveLoading && <p><span className="text-[#718092]">Live inscription data:</span> synchronizing…</p>}{transferLiveData && <><p><span className="text-[#718092]">Current owner:</span> {transferLiveData.owner ?? "Unavailable"}</p><p><span className="text-[#718092]">Listing:</span> {transferLiveData.listing.listed ? "Listed" : "Not listed"}</p><p><span className="text-[#718092]">Live refresh:</span> {new Date(transferLiveData.refreshedAt).toLocaleString()}</p></>}{transferLiveError && <p className="text-[#e08b7d]"><span className="text-[#718092]">Live data:</span> {transferLiveError}</p>}<p className="mt-1 text-[#a45e54]">{nativeInscriptionTransfer ? "UniSat sendInscription constructs and broadcasts the ordinal transfer after its native approval; verify the recipient and inscription in the wallet." : "Cloudflare provides protocol-checked fee UTXOs; the site reviews the exact transaction, UniSat signs after approval, and the selected network Mempool validates and broadcasts it."}</p></div>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-[#d9d3c6]">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={event => setConfirmed(event.target.checked)}
                  className="mt-0.5 accent-[#d99a54]"
                />
                <span>I checked this inscription and destination. I understand the on-chain transfer cannot be reversed.</span>
              </label>
              {isMobileUniSatDevice() && confirmed && selectedInscription && destination.trim() && address && isSupportedMainnet(chain?.enum) && <UniSatOwnershipProof key={`${ownershipContextKey}:${ownershipProofVersion}`} site={site} address={address} network={chain?.enum ?? ""} provider={window.unisat} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />}
              {mobileNativeReadyForContext && <p className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#70c7a0]" role="status">Pre-check complete. Wallet ownership check is valid. Tap again to open UniSat transaction confirmation.</p>}
              {isMobileBrowser() && (!isUniSatMobileContext() || !providerAvailable) && (
                <button
                  type="button"
                  onClick={() => openUniSatMobileWallet()}
                  className="mt-3 border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#d9d3c6] hover:border-[#d99a54]"
                >
                  Open this page in UniSat
                </button>
              )}
              <button
                type="button"
                onClick={() => mobileNativeReadyForContext ? openMobileNativeTransfer() : void sendSelectedInscription()}
                disabled={
                  transferOutcomeUnclear ||
                  mobilePsbtTransferUnavailable ||
                  (isMobileBrowser() &&
                    (!isUniSatMobileContext() || !providerAvailable)) ||
                  !confirmed ||
                  (isMobileUniSatDevice() &&
                    ownershipProofKey !== ownershipContextKey) ||
                  transferBusy ||
                  busy ||
                  transferLiveLoading
                }
                className="mt-3 border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {transferOutcomeUnclear ? "Transfer status unknown — verify first" : isMobileBrowser() && (!isUniSatMobileContext() || !providerAvailable) ? "Open in UniSat first" : transferBusy ? verifiedOrdinalTransfer ? "Preparing verified transfer…" : "Preparing transfer…" : mobileNativeReadyForContext ? "Approve in UniSat" : verifiedOrdinalTransfer ? "Prepare verified transfer" : isMobileUniSatDevice() ? "Prepare transfer" : "Review transfer in UniSat"}
              </button>
              {mobilePsbtTransferUnavailable ? (
                <p
                  className="mt-2 font-mono text-[10px] leading-5 text-[#e0b45f]"
                  role="note"
                >
                  This UniSat mobile version lacks the verified PSBT methods required for an Ordinal transfer. Update UniSat; signing remains disabled until `getBitcoinUtxos`, `getPublicKey`, `getAccounts`, and `signPsbt` are available.
                </p>
              ) : (
                connectedToFractal && (
                  <p
                    className="mt-2 font-mono text-[10px] leading-5 text-[#e0b45f]"
                    role="note"
                  >
                    {nativeInscriptionTransfer
                      ? "UniSat sendInscription builds, reviews and broadcasts the ordinal transfer after wallet approval; the site tracks its TXID."
                      : "Cloudflare supplies protocol-checked fee UTXOs; the site reviews the exact transaction, UniSat signs after approval, and the selected network Mempool validates and broadcasts it."}
                  </p>
                )
              )}
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
          <UniSatMobileOpenDappLink site={site} walletMethodAvailable={nativeInscriptionTransfer ? typeof window.unisat?.sendInscription === "function" : Boolean(window.unisat?.getBitcoinUtxos && window.unisat?.getPublicKey && window.unisat?.getAccounts && window.unisat?.signPsbt)} methodLabel={nativeInscriptionTransfer ? "sendInscription" : "verified PSBT signing"} />{transferError && <p className="mt-3 font-mono text-[10px] text-[#e08b7d]" role="alert">{transferError}</p>}
          {txid && (
            <>
              <p className="mt-3 break-all font-mono text-[10px] text-[#70c7a0]" role="status">
                UniSat returned transaction ID: {txid}.
              </p>
              {finalReceipt && <div className="mt-4 border border-[#d99a54]/70 bg-[#10151a] p-4 font-mono text-[10px] leading-5" aria-label="Live final receipt du transfert"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">Live final receipt · transfer</p><p><span className="text-[#718092]">Status:</span> {finalReceipt.message}</p><p><span className="text-[#718092]">Network:</span> {finalReceipt.network}</p><p className="break-all"><span className="text-[#718092]">TXID:</span> {finalReceipt.txid}</p>{finalReceipt.blockHeight !== null && <p><span className="text-[#718092]">Block:</span> {finalReceipt.blockHeight}</p>}<p><span className="text-[#718092]">Verified:</span> {new Date(finalReceipt.checkedAt).toLocaleString()}</p>{finalReceipt.liveBefore && <div className="mt-2 border-t border-[#2c323a] pt-2"><p className="uppercase text-[#f2bd63]">Live data before confirmation</p><p className="break-all"><span className="text-[#718092]">Owner :</span> {finalReceipt.liveBefore.owner ?? "Unavailable"}</p><p><span className="text-[#718092]">Listing :</span> {finalReceipt.liveBefore.listing.listed ? "Listed" : "Not listed"}</p><p><span className="text-[#718092]">Refreshed:</span> {new Date(finalReceipt.liveBefore.refreshedAt).toLocaleString()}</p></div>}{finalReceipt.liveAfter && <div className="mt-2 border-t border-[#2c323a] pt-2"><p className="uppercase text-[#f2bd63]">Live data after confirmation</p><p className="break-all"><span className="text-[#718092]">Owner :</span> {finalReceipt.liveAfter.owner ?? "Unavailable"}</p><p><span className="text-[#718092]">Listing :</span> {finalReceipt.liveAfter.listing.listed ? "Listed" : "Not listed"}</p><p><span className="text-[#718092]">Refreshed:</span> {new Date(finalReceipt.liveAfter.refreshedAt).toLocaleString()}</p></div>}<a className="mt-1 inline-flex items-center gap-1 text-[#d99a54] underline" href={finalReceipt.explorerUrl} target="_blank" rel="noreferrer">Open in Mempool <ExternalLink size={11} /></a></div>}
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
