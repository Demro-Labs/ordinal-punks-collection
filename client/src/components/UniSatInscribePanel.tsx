import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, ExternalLink, FilePlus2, Files, ShieldCheck, Upload, X } from "lucide-react";
import { describeFeeSources, getRecommendedFeeEstimate, trackMempoolTransaction, validateMempoolAddress, type FeeEstimate, type MempoolReceipt } from "@/lib/mempool";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { getMobileUtxoErrorGuidance, sendNativeUniSatBitcoinPayment } from "@/lib/native-unisat-actions";
import { UniSatOwnershipProof } from "@/components/UniSatOwnershipProof";

const API_BASE = "https://fractal-ordinal-live.servostar23.workers.dev";
const MAX_FILE_BYTES = 365 * 1024;
const MAX_FILES = 1000;
type Chain = { enum?: string; name?: string };
type InscribeFile = { filename: string; size: number; type: string; dataURL?: string };
type InscribeReceipt = { orderId: string; payAddress: string; amount: number; files: InscribeFile[]; feeRate: number; paymentFeeRate?: number; feeSourceLabel: string; chain: string; walletAddress: string; createdAt: string };
type InscribeStage = "idle" | "preparing" | "awaiting-approval" | "paying" | "tracking" | "completed";
type OrderFile = { inscriptionId?: string; filename?: string; status?: string; txid?: string; inscriptionTxid?: string };
type LiveWalletData = { publicKey: string; available: number | null; confirmed: number | null; total: number | null; safeAvailableSats: number | null; asset: string; refreshedAt: string };
type InscriptionHistoryItem = { inscriptionId: string; transactionId: string; paymentTxid?: string; finalPaymentReceipt?: MempoolReceipt; filename: string; orderId: string; network: string; walletAddress: string; createdAt: string };
type PersistedMobileOrder = { receipt: InscribeReceipt; txid: string; paymentStarted?: boolean; savedAt: string };
const HISTORY_RETENTION_MONTHS = 2;
const HISTORY_PAGE_SIZE = 10;
const ACTIVE_MOBILE_ORDER_STORAGE_KEY = "ordinal-punks:active-mobile-inscribe-order:v1";
type HistorySortKey = "date" | "filename" | "inscriptionId" | "transactionId" | "orderId" | "network";

function isInscribeReceipt(value: unknown): value is InscribeReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<InscribeReceipt>;
  return typeof receipt.orderId === "string" && receipt.orderId.length > 0 && typeof receipt.payAddress === "string" && receipt.payAddress.length > 0 &&
    Number.isSafeInteger(receipt.amount) && Number(receipt.amount) > 0 && Number.isSafeInteger(receipt.feeRate) && Number(receipt.feeRate) > 0 &&
    typeof receipt.feeSourceLabel === "string" && typeof receipt.chain === "string" && typeof receipt.walletAddress === "string" && typeof receipt.createdAt === "string" &&
    Array.isArray(receipt.files) && receipt.files.every(file => Boolean(file) && typeof file === "object" && typeof (file as InscribeFile).filename === "string");
}

function readActiveMobileOrder(): PersistedMobileOrder | null {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_MOBILE_ORDER_STORAGE_KEY) ?? "null") as Partial<PersistedMobileOrder> | null;
    if (!value || !isInscribeReceipt(value.receipt) || typeof value.savedAt !== "string" || (typeof value.txid !== "string" || (value.txid !== "" && !/^[a-f0-9]{64}$/i.test(value.txid))) || (value.paymentStarted !== undefined && typeof value.paymentStarted !== "boolean")) return null;
    return { receipt: value.receipt, txid: value.txid, paymentStarted: value.paymentStarted === true, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

function saveActiveMobileOrder(receipt: InscribeReceipt, txid = "", paymentStarted = false) {
  try { localStorage.setItem(ACTIVE_MOBILE_ORDER_STORAGE_KEY, JSON.stringify({ receipt, txid, paymentStarted, savedAt: new Date().toISOString() } satisfies PersistedMobileOrder)); } catch { /* private mode or storage quota */ }
}

function clearActiveMobileOrder() {
  try { localStorage.removeItem(ACTIVE_MOBILE_ORDER_STORAGE_KEY); return true; } catch { /* private mode */ return false; }
}

function historyStorageKeyFor(network: string, walletAddress: string) { return `fractal-inscription-history:${network}:${walletAddress.toLowerCase()}`; }
function mempoolPaymentStorageKey(historyKey: string, orderId: string) { return `${historyKey}:mempool-payment:${orderId}`; }
function isMempoolReceipt(value: unknown): value is MempoolReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<MempoolReceipt>;
  return typeof receipt.txid === "string" && /^[a-f0-9]{64}$/i.test(receipt.txid) && typeof receipt.network === "string" &&
    ["checking", "pending", "confirmed", "timeout", "error"].includes(String(receipt.status)) && typeof receipt.message === "string" &&
    (receipt.blockHeight === null || typeof receipt.blockHeight === "number") && typeof receipt.explorerUrl === "string" && typeof receipt.checkedAt === "string";
}
function readSavedMempoolReceipt(historyKey: string, orderId: string) {
  try { const saved = JSON.parse(localStorage.getItem(mempoolPaymentStorageKey(historyKey, orderId)) ?? "null") as unknown; return isMempoolReceipt(saved) ? saved : undefined; }
  catch { return undefined; }
}
function mempoolPaymentReceiptLines(receipt: MempoolReceipt | undefined, paymentTxid?: string, network?: string) {
  const checkedAt = receipt?.checkedAt && Number.isFinite(Date.parse(receipt.checkedAt)) ? new Date(receipt.checkedAt).toISOString() : "Unavailable";
  const title = receipt?.status === "confirmed" ? "Final Mempool payment receipt" : "Mempool payment receipt (latest status)";
  return [title, `Payment TXID: ${receipt?.txid ?? paymentTxid ?? "Unavailable"}`, `Network: ${receipt?.network ?? network ?? "Unavailable"}`, `Status: ${receipt?.status ?? "not recorded"}`, `Message: ${receipt?.message ?? "No Mempool receipt was saved."}`, `Block height: ${receipt?.blockHeight ?? (receipt?.status === "confirmed" ? "Confirmed (height unavailable)" : "Unavailable")}`, `Mempool checked at: ${checkedAt}`, `Explorer URL: ${receipt?.explorerUrl ?? "Unavailable"}`];
}

function readAsDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Impossible de lire le fichier.")); reader.readAsDataURL(file); }); }
function formatBytes(value: number) { return `${(value / 1024).toFixed(value < 1024 ? 1 : 0)} KB`; }
function asSafeSats(value: unknown): number | null {
  const parsed = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function describeStatus(status: string) { return ({ pending: "Payment pending", paid: "Payment received", processing: "Inscription en cours", minted: "Inscription created", completed: "Inscription complete", success: "Inscription complete", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[status] ?? status; }
function fileKind(file: File) { if (file.type.startsWith("image/")) return "Image"; if (file.type.startsWith("text/")) return "Text"; if (file.type.startsWith("audio/")) return "Audio"; if (file.type.startsWith("video/")) return "Video"; if (file.type === "application/json") return "JSON"; if (file.type === "image/svg+xml") return "SVG"; if (file.type === "application/pdf") return "PDF"; return file.type || "Binary"; }
function isWalletCancellation(error: unknown) {
  const value = error as { code?: unknown } | null;
  const message = walletErrorMessage(error);
  return value?.code === 4001 || /user (rejected|denied)|cancelled by user|request rejected/i.test(message);
}

function walletErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; shortMessage?: unknown; reason?: unknown; code?: unknown };
    for (const detail of [value.message, value.shortMessage, value.reason]) {
      if (typeof detail === "string" && detail.trim()) return detail.trim();
    }
    if (typeof value.code === "string" || typeof value.code === "number") return `Erreur UniSat (${String(value.code)})`;
  }
  return "Unknown error returned by UniSat";
}


type MobileReceiptWalletCardProps = {
  address: string;
  chain: Chain | null;
  liveWallet: LiveWalletData | null;
  onRefresh: () => void;
};

function MobileReceiptWalletCard({ address, chain, liveWallet, onRefresh }: MobileReceiptWalletCardProps) {
  const networkLabel = chain?.name ?? chain?.enum ?? "Not detected";
  const liveBalance = liveWallet?.total ?? liveWallet?.available ?? liveWallet?.confirmed;
  const formatBalance = (value: number | null | undefined) => value == null ? "Unavailable" : `${value.toLocaleString("en-US")} sats`;
  return <div className="mt-3 border border-[#d99a54]/50 bg-[#151a1f] p-3 font-mono text-[10px] text-[#d9d3c6]">
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="uppercase tracking-[0.1em] text-[#f2bd63]">Live UniSat wallet detected</p>
        <p className="mt-1 text-[#9ea7b3]">{address ? "UniSat account connected" : "UniSat account not detected"}</p>
      </div>
      <button type="button" onClick={onRefresh} className="shrink-0 border border-[#3b434d] px-2 py-1 text-[9px] uppercase text-[#f2bd63]">Actualiser</button>
    </div>
    <div className="mt-3 flex items-center justify-between gap-3 border border-[#d99a54]/40 bg-[#0d1115] px-3 py-2">
      <span className="uppercase tracking-[0.08em] text-[#f2bd63]">Live UniSat balance</span>
      <strong className="text-sm text-[#f2bd63]">{formatBalance(liveBalance)}</strong>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <p className="break-all sm:col-span-2"><span className="text-[#718092]">Connected address (live):</span> {address || "Not detectede"}</p>
      <p><span className="text-[#718092]">Current UniSat network:</span> {networkLabel}</p>
      <p><span className="text-[#718092]">Available balance:</span> {formatBalance(liveWallet?.available)}</p>
      <p><span className="text-[#718092]">Confirmed balance:</span> {formatBalance(liveWallet?.confirmed)}</p>
      <p><span className="text-[#718092]">Total balance:</span> {formatBalance(liveWallet?.total)}</p>
    </div>
  </div>;
}

export function UniSatInscribePanel({ site = "punks" }: { site?: "punks" | "pokedex" } = {}) {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [fileLoadProgress, setFileLoadProgress] = useState({ completed: 0, total: 0 });
  const [stage, setStage] = useState<InscribeStage>("idle");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [receipt, setReceipt] = useState<InscribeReceipt | null>(null);
  const [txid, setTxid] = useState("");
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const [ownershipProofVersion, setOwnershipProofVersion] = useState(0);
  const [ownershipRequested, setOwnershipRequested] = useState(false);
  const [inscriptionIds, setInscriptionIds] = useState<string[]>([]);
  const [orderFiles, setOrderFiles] = useState<OrderFile[]>([]);
  const [liveWallet, setLiveWallet] = useState<LiveWalletData | null>(null);
  const [inscriptionHistory, setInscriptionHistory] = useState<InscriptionHistoryItem[]>([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<InscriptionHistoryItem | null>(null);
  const [selectedHistoryBatches, setSelectedHistoryBatches] = useState<string[]>([]);
  const [historySortKey, setHistorySortKey] = useState<HistorySortKey>("date");
  const [historySortDirection, setHistorySortDirection] = useState<"asc" | "desc">("desc");
  const [finalReceipt, setFinalReceipt] = useState<MempoolReceipt | null>(null);
  const ownershipContextKey = receipt ? JSON.stringify(["inscribe-payment", site, receipt.walletAddress, receipt.chain, receipt.orderId, receipt.payAddress, receipt.amount]) : "";
  const filePickerRef = useRef<HTMLInputElement>(null);
  const paymentReceiptRef = useRef<{ historyKey: string; orderId: string; receipt: MempoolReceipt } | null>(null);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const totalInscribed = orderFiles.filter(file => file.inscriptionId).length;
  useEffect(() => {
    if (!isMobileUniSatDevice()) return;
    setOwnershipProofKey(null);
    setOwnershipProofVersion(version => version + 1);
    setOwnershipRequested(false);
  }, [ownershipContextKey]);
  const historyGroups = useMemo(() => {
    const groups = new Map<string, InscriptionHistoryItem[]>();
    for (const item of inscriptionHistory) { const group = groups.get(item.orderId) ?? []; group.push(item); groups.set(item.orderId, group); }
    const valueFor = (item: InscriptionHistoryItem) => historySortKey === "date" ? item.createdAt : item[historySortKey];
    const compareItems = (left: InscriptionHistoryItem, right: InscriptionHistoryItem) => {
      const leftValue = valueFor(left);
      const rightValue = valueFor(right);
      const order = historySortKey === "date"
        ? new Date(leftValue).getTime() - new Date(rightValue).getTime()
        : leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
      return order * (historySortDirection === "asc" ? 1 : -1);
    };
    const result = Array.from(groups, ([orderId, items]) => ({ orderId, items: items.sort(compareItems) }));
    return result.sort((left, right) => historySortKey === "orderId"
      ? left.orderId.localeCompare(right.orderId, undefined, { numeric: true, sensitivity: "base" }) * (historySortDirection === "asc" ? 1 : -1)
      : compareItems(left.items[0], right.items[0]));
  }, [inscriptionHistory, historySortKey, historySortDirection]);
  const historyPageCount = Math.max(1, Math.ceil(historyGroups.length / HISTORY_PAGE_SIZE));
  const visibleHistoryGroups = historyGroups.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);
  const historyStorageKey = address && chain?.enum ? historyStorageKeyFor(chain.enum, address) : "";
  const saveCompletedHistory = (completedFiles: OrderFile[], activeReceipt: InscribeReceipt, paymentTxid: string) => {
    const activeHistoryKey = historyStorageKeyFor(activeReceipt.chain, activeReceipt.walletAddress);
    const inMemoryReceipt = paymentReceiptRef.current?.historyKey === activeHistoryKey && paymentReceiptRef.current.orderId === activeReceipt.orderId ? paymentReceiptRef.current.receipt : undefined;
    const finalPaymentReceipt = inMemoryReceipt ?? readSavedMempoolReceipt(activeHistoryKey, activeReceipt.orderId);
    const now = new Date().toISOString();
    const networkLabel = activeReceipt.chain === "BITCOIN_MAINNET" ? "Bitcoin" : activeReceipt.chain === "FRACTAL_BITCOIN_MAINNET" ? "Fractal Bitcoin" : activeReceipt.chain;
    const additions = completedFiles.map((file, index) => { const inscriptionId = file.inscriptionId ?? ""; const embeddedTxid = inscriptionId.match(/^([a-f0-9]{64})i\d+$/i)?.[1]; return { inscriptionId, transactionId: file.inscriptionTxid ?? file.txid ?? embeddedTxid ?? paymentTxid, paymentTxid, finalPaymentReceipt, filename: file.filename ?? activeReceipt.files[index]?.filename ?? `File ${index + 1}`, orderId: activeReceipt.orderId, network: networkLabel, walletAddress: activeReceipt.walletAddress, createdAt: now }; }).filter(item => item.inscriptionId);
    if (!additions.length) return;
    let storedHistory: InscriptionHistoryItem[] = [];
    try { const stored = JSON.parse(localStorage.getItem(activeHistoryKey) ?? "[]") as unknown; if (Array.isArray(stored)) storedHistory = stored as InscriptionHistoryItem[]; } catch { /* missing or invalid wallet history */ }
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    const merged = [...additions, ...storedHistory].filter((item, index, all) => item.createdAt && new Date(item.createdAt) >= cutoff && all.findIndex(candidate => candidate.inscriptionId === item.inscriptionId && candidate.transactionId === item.transactionId) === index);
    if (activeHistoryKey === historyStorageKey) { setInscriptionHistory(merged); setHistoryPage(0); }
    try { localStorage.setItem(activeHistoryKey, JSON.stringify(merged)); localStorage.removeItem(mempoolPaymentStorageKey(activeHistoryKey, activeReceipt.orderId)); } catch { /* private mode or storage quota */ }
  };
  const recordFinalMempoolReceipt = (activeReceipt: InscribeReceipt, paymentReceipt: MempoolReceipt) => {
    const key = historyStorageKeyFor(activeReceipt.chain, activeReceipt.walletAddress);
    const previous = paymentReceiptRef.current?.historyKey === key && paymentReceiptRef.current.orderId === activeReceipt.orderId ? paymentReceiptRef.current.receipt : readSavedMempoolReceipt(key, activeReceipt.orderId);
    const changed = !previous || previous.txid !== paymentReceipt.txid || previous.status !== paymentReceipt.status || previous.message !== paymentReceipt.message || previous.blockHeight !== paymentReceipt.blockHeight || previous.network !== paymentReceipt.network || previous.explorerUrl !== paymentReceipt.explorerUrl;
    paymentReceiptRef.current = { historyKey: key, orderId: activeReceipt.orderId, receipt: paymentReceipt };
    setFinalReceipt(paymentReceipt);
    if (!changed && paymentReceipt.status !== "confirmed") return;
    try {
      localStorage.setItem(mempoolPaymentStorageKey(key, activeReceipt.orderId), JSON.stringify(paymentReceipt));
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as InscriptionHistoryItem[];
      if (Array.isArray(stored) && stored.some(item => item.orderId === activeReceipt.orderId)) {
        const updated = stored.map(item => item.orderId === activeReceipt.orderId ? { ...item, finalPaymentReceipt: paymentReceipt } : item);
        localStorage.setItem(key, JSON.stringify(updated));
        localStorage.removeItem(mempoolPaymentStorageKey(key, activeReceipt.orderId));
      }
    } catch { /* private mode or storage quota */ }
    if (key === historyStorageKey) {
      setInscriptionHistory(current => current.map(item => item.orderId === activeReceipt.orderId ? { ...item, finalPaymentReceipt: paymentReceipt } : item));
      setSelectedHistoryItem(current => current?.orderId === activeReceipt.orderId ? { ...current, finalPaymentReceipt: paymentReceipt } : current);
    }
  };
  const refreshWallet = async () => {
    const provider = window.unisat;
    if (!provider) { setAddress(""); setChain(null); if (isMobileUniSatDevice()) setLiveWallet(null); return; }
    try {
      const [accounts, currentChain] = await Promise.all([provider.getAccounts?.(), provider.getChain?.()]);
      const activeAddress = accounts?.[0] ?? "";
      setAddress(activeAddress); setChain(currentChain ?? null);
      if (isMobileUniSatDevice() && activeAddress && currentChain?.enum) {
        void loadLiveWalletData(currentChain.enum, activeAddress);
      } else if (isMobileUniSatDevice()) setLiveWallet(null);
    } catch { setAddress(""); setChain(null); if (isMobileUniSatDevice()) setLiveWallet(null); }
  };
  const loadLiveWalletData = async (networkEnum = chain?.enum, expectedAddress = address, publicKeyHint = "") => {
    const provider = window.unisat;
    if (!provider) return null;
    if (!isMobileUniSatDevice()) {
      const [publicKeyResult, balanceResult] = await Promise.allSettled([provider.getPublicKey?.(), provider.getBalanceV2 ? provider.getBalanceV2() : provider.getBalance?.()]);
      const publicKey = publicKeyResult.status === "fulfilled" ? String(publicKeyResult.value ?? "") : "";
      const balance = balanceResult.status === "fulfilled" ? balanceResult.value as { available?: number; confirmed?: number; total?: number } | null : null;
      const available = balance?.available ?? balance?.confirmed ?? null;
      const total = balance?.total ?? available;
      const data = { publicKey, available: typeof available === "number" ? available : null, confirmed: null, total: typeof total === "number" ? total : null, safeAvailableSats: null, asset: networkEnum === "FRACTAL_BITCOIN_MAINNET" ? "FB" : "BTC", refreshedAt: new Date().toISOString() };
      setLiveWallet(data);
      return data;
    }
    const [accountsResult, chainResult, balanceV2Result, balanceResult, publicKeyResult] = await Promise.allSettled([
      provider.getAccounts ? provider.getAccounts() : Promise.resolve(undefined),
      provider.getChain ? provider.getChain() : Promise.resolve(undefined),
      provider.getBalanceV2 ? provider.getBalanceV2() : Promise.resolve(null),
      provider.getBalance ? provider.getBalance() : Promise.resolve(null),
      publicKeyHint ? Promise.resolve(publicKeyHint) : provider.getPublicKey ? provider.getPublicKey() : Promise.resolve(null),
    ]);
    if (provider.getAccounts && accountsResult.status !== "fulfilled" || provider.getChain && chainResult.status !== "fulfilled") { setLiveWallet(null); return null; }
    const activeAddress = provider.getAccounts && accountsResult.status === "fulfilled" ? accountsResult.value?.[0] ?? "" : expectedAddress;
    const activeNetwork = provider.getChain && chainResult.status === "fulfilled" ? chainResult.value?.enum : networkEnum;
    if (expectedAddress && activeAddress !== expectedAddress || networkEnum && activeNetwork && activeNetwork !== networkEnum) { setLiveWallet(null); return null; }
    const balanceV2 = balanceV2Result.status === "fulfilled" ? balanceV2Result.value as { available?: unknown; total?: unknown } | null : null;
    const balance = balanceResult.status === "fulfilled" ? balanceResult.value as { confirmed?: unknown; unconfirmed?: unknown; total?: unknown } | null : null;
    const publicKeyValue = publicKeyResult.status === "fulfilled" ? publicKeyResult.value : null;
    const publicKey = typeof publicKeyValue === "string" && publicKeyValue.trim() ? publicKeyValue.trim() : publicKeyHint;
    const confirmed = asSafeSats(balance?.confirmed);
    const unconfirmed = asSafeSats(balance?.unconfirmed);
    const fallbackTotal = asSafeSats(balance?.total) ?? (confirmed !== null && unconfirmed !== null && Number.isSafeInteger(confirmed + unconfirmed) ? confirmed + unconfirmed : null);
    const data = { publicKey, available: asSafeSats(balanceV2?.available), confirmed, total: asSafeSats(balanceV2?.total) ?? fallbackTotal, safeAvailableSats: null, asset: networkEnum === "FRACTAL_BITCOIN_MAINNET" ? "FB" : "BTC", refreshedAt: new Date().toISOString() };
    setLiveWallet(data);
    return data;
  };
  const refreshLiveWalletData = async () => {
    const provider = window.unisat;
    if (!provider) { setAddress(""); setChain(null); setLiveWallet(null); return; }
    try {
      const [accounts, currentChain] = await Promise.all([provider.getAccounts?.(), provider.getChain?.()]);
      const activeAddress = accounts?.[0] ?? "";
      setAddress(activeAddress);
      setChain(currentChain ?? null);
      if (!activeAddress || !currentChain?.enum) { setLiveWallet(null); return; }
      await loadLiveWalletData(currentChain.enum, activeAddress);
    } catch {
      setAddress("");
      setChain(null);
      setLiveWallet(null);
    }
  };

  useEffect(() => { void refreshWallet(); const listener = () => void refreshWallet(); window.unisat?.on?.("accountsChanged", listener); window.unisat?.on?.("chainChanged", listener); return () => { window.unisat?.removeListener?.("accountsChanged", listener); window.unisat?.removeListener?.("chainChanged", listener); }; }, []);
  useEffect(() => {
    if (!address || !chain?.enum) { setInscriptionHistory([]); setHistoryPage(0); setSelectedHistoryItem(null); setSelectedHistoryBatches([]); return; }
    const key = `fractal-inscription-history:${chain.enum}:${address.toLowerCase()}`;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as InscriptionHistoryItem[];
      const valid = stored.filter(item => item.createdAt && new Date(item.createdAt) >= cutoff).map(item => ({ ...item, transactionId: item.transactionId || item.inscriptionId?.match(/^([a-f0-9]{64})i\d+$/i)?.[1] || item.paymentTxid || "Unavailable", finalPaymentReceipt: isMempoolReceipt(item.finalPaymentReceipt) ? item.finalPaymentReceipt : readSavedMempoolReceipt(key, item.orderId) })).filter((item, index, all) => all.findIndex(candidate => candidate.inscriptionId === item.inscriptionId && candidate.transactionId === item.transactionId) === index);
      setInscriptionHistory(valid);
      setHistoryPage(0);
      setSelectedHistoryItem(null);
      setSelectedHistoryBatches([]);
      localStorage.setItem(key, JSON.stringify(valid));
    } catch { setInscriptionHistory([]); }
  }, [address, chain?.enum]);
  const chooseFiles = (next: File[]) => {
    const mobileDevice = isMobileUniSatDevice();
    const savedMobileOrder = mobileDevice ? readActiveMobileOrder() : null;
    if (!next.length) return;
    if (!mobileDevice && receipt) return setMessage("A receipt already exists for this batch. Do not modify the files; use this receipt payment.");
    const combined = [...files, ...next];
    if (combined.length > MAX_FILES) { setMessage(`Maximum ${MAX_FILES} fichiers par commande.`); return; }
    const oversized = combined.find(file => file.size > MAX_FILE_BYTES);
    if (oversized) { setMessage(`${oversized.name} dépasse la limite UniSat de 365 KB.`); return; }
    if (mobileDevice && (receipt || savedMobileOrder)) {
      setFiles(combined);
      const paymentMayHaveStarted = Boolean(txid || savedMobileOrder?.txid || savedMobileOrder?.paymentStarted);
      setMessage(paymentMayHaveStarted
        ? "Files added to the local queue. The current receipt/payment remains intact; resume tracking before preparing another order."
        : "Files added to the local queue. The current receipt is unchanged; verify that no payment was sent, then clear only its local copy to prepare this new batch.");
      return;
    }
    setFiles(combined); setMessage(""); setStage("idle"); setReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]);
  };
  const removeFile = (index: number) => setFiles(current => current.filter((_, currentIndex) => currentIndex !== index));
  const prepareOrder = async () => {
    const provider = window.unisat;
    const mobileUniSat = isMobileUniSatDevice();
    const saved = mobileUniSat ? readActiveMobileOrder() : null;
    if (saved) {
      return setMessage("A mobile order is saved. Choose “Review mobile receipt” before resuming; no new order was created.");
    }
    let createdReceipt: InscribeReceipt | null = null; setMessage(""); setStatus(""); setReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]);
    if (!provider?.getPublicKey) return setMessage(mobileUniSat
      ? "No compatible mobile wallet was detected. Open this page in the updated UniSat in-app browser; no order was created."
      : "UniSat must be connected and support getPublicKey.");
    if (!files.length) return setMessage("Add at least one file to inscribe.");
    setStage("preparing");
    try {
      const [accounts, currentChain] = await Promise.all([
        provider.getAccounts ? provider.getAccounts() : Promise.resolve(undefined),
        provider.getChain ? provider.getChain() : Promise.resolve(undefined),
      ]);
      const activeAddress = provider.getAccounts ? accounts?.[0] ?? "" : address;
      const activeChain = provider.getChain ? currentChain ?? null : chain;
      setAddress(activeAddress);
      setChain(activeChain);
      const activeChainEnum = activeChain?.enum;
      if (!activeAddress) { setStage("idle"); return setMessage("UniSat returned no connected account. Reconnect your address in the wallet and try again."); }
      if (activeChainEnum !== "BITCOIN_MAINNET" && activeChainEnum !== "FRACTAL_BITCOIN_MAINNET") {
        setStage("idle");
        return setMessage("Unsupported UniSat network. Select Bitcoin mainnet or Fractal Bitcoin mainnet in the wallet.");
      }
      await validateMempoolAddress(activeChainEnum, activeAddress);
      setFileLoadProgress({ completed: 0, total: files.length });
      const encodedFiles: Array<{ filename: string; dataURL: string }> = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        encodedFiles.push({ filename: file.name, dataURL: await readAsDataUrl(file) });
        setFileLoadProgress({ completed: index + 1, total: files.length });
        setMessage(`Chargement des fichiers ${index + 1} / ${files.length}…`);
      }
      const publicKey = await provider.getPublicKey();
      const feeEstimate = await getRecommendedFeeEstimate(activeChainEnum);
      const liveFeeRate = feeEstimate.feeRate;
      await loadLiveWalletData(activeChainEnum, activeAddress, publicKey);
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/api/inscribe/order`, {
          mode: "cors",
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ receiver: activeAddress, refundAddress: activeAddress, userAddress: activeAddress, userPubkey: publicKey, feeRate: liveFeeRate, outputValue: 546, chain: activeChainEnum, files: encodedFiles }),
        });
      } catch {
        throw new Error("The UniSat inscription service is unavailable. Check the network connection, then try again without closing the wallet.");
      }
      const created = await response.json() as { orderId?: string; payAddress?: string; amount?: number; feeRate?: number; feeSources?: FeeEstimate["sources"]; feeStrategy?: FeeEstimate["strategy"]; error?: string };
      if (!response.ok || !created.orderId || !created.payAddress || !Number.isSafeInteger(created.amount) || !Number.isSafeInteger(created.feeRate) || Number(created.feeRate) < 1) throw new Error(created.error || "UniSat did not create the order with a verifiable fee rate.");
      const feeSourceLabel = describeFeeSources(created.feeStrategy ?? feeEstimate.strategy, created.feeSources ?? feeEstimate.sources);
      createdReceipt = { orderId: created.orderId, payAddress: created.payAddress, amount: Number(created.amount), files: files.map(file => ({ filename: file.name, size: file.size, type: fileKind(file) })), feeRate: Number(created.feeRate), paymentFeeRate: liveFeeRate, feeSourceLabel, chain: activeChainEnum, walletAddress: activeAddress, createdAt: new Date().toISOString() };
      setReceipt(createdReceipt);
      if (mobileUniSat) saveActiveMobileOrder(createdReceipt);
      setStage("awaiting-approval");
      setMessage(`Order ${createdReceipt.orderId} is ready. Click to open UniSat payment: ${createdReceipt.amount.toLocaleString()} sats to ${createdReceipt.payAddress}. UniSat will show fees and the final transaction before approval.`);
    } catch (error) {
      if (createdReceipt) { setReceipt(createdReceipt); setStage("awaiting-approval"); setMessage(`La commande ${createdReceipt.orderId} existe déjà. Ne la recréez pas. Vous pouvez ouvrir son paiement dans UniSat après vérification. Details: ${error instanceof Error ? error.message : "erreur inconnue"}`); }
      else { setStage("idle"); setMessage(error instanceof Error ? error.message : "Unable to prepare the inscription."); }
    }
  };
  const pollOrder = async (orderId: string, paymentTxid: string, orderChain: string) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const query = new URLSearchParams({ orderId, chain: orderChain });
      const response = await fetch(`${API_BASE}/api/inscribe/order?${query}`, { cache: "no-store" });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        if (response.status < 500 && response.status !== 429) throw new Error(failure?.error || "Impossible de lire le statut live de l’inscription.");
        setMessage("Payment already sent; UniSat status is temporarily unavailable. Do not pay again. Retrying automatically…");
        await new Promise(resolve => window.setTimeout(resolve, 10000));
        continue;
      }
      const data = await response.json() as { status?: string; txid?: string; inscriptionTxid?: string; files?: OrderFile[] };
      const nextStatus = String(data.status ?? "pending"); setStatus(nextStatus);
      if (data.files) { setOrderFiles(data.files); setInscriptionIds(data.files.map(file => file.inscriptionId).filter((id): id is string => Boolean(id))); }
      if (["minted", "completed", "success"].includes(nextStatus)) {
        if (receipt) saveCompletedHistory(data.files ?? [], receipt, paymentTxid);
        if (isMobileUniSatDevice()) clearActiveMobileOrder();
        setStage("completed");
        setMessage("Toutes les inscriptions créées sont visibles dans le reçu final live et l’historique du wallet."); return;
      }
      if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(nextStatus)) throw new Error(`The UniSat order is in state ${nextStatus}.`);
      await new Promise(resolve => window.setTimeout(resolve, 10000));
    }
    setMessage("Payment was already sent, but tracking exceeded the expected time. Do not pay again; use the TXID and resume order tracking.");
  };
  const resumeOrderTracking = async () => {
    if (!receipt || !txid) return;
    setStage("tracking"); setMessage("Resuming tracking of the existing payment — no new payment will be sent.");
    try { await pollOrder(receipt.orderId, txid, receipt.chain); }
    catch (error) { setMessage(`Payment was already sent. Do not pay again. UniSat tracking: ${error instanceof Error ? error.message : "indisponible"}`); }
  };
  const handleApprovedPayment = async (paymentPromise: Promise<string>, activeReceipt: InscribeReceipt) => {
    let paymentReturned = false;
    let returnedPaymentTxid = "";
    try {
      const returnedTxid = await paymentPromise;
      paymentReturned = true;
      if (isMobileUniSatDevice()) {
        void loadLiveWalletData(activeReceipt.chain, activeReceipt.walletAddress);
        window.setTimeout(() => void loadLiveWalletData(activeReceipt.chain, activeReceipt.walletAddress), 3000);
      }
      if (!returnedTxid || !/^[a-f0-9]{64}$/i.test(returnedTxid)) throw new Error("UniSat did not retourné de TXID vérifiable. Verify l’activité du wallet avant toute nouvelle action.");
      const normalizedTxid = returnedTxid.toLowerCase();
      returnedPaymentTxid = normalizedTxid;
      setTxid(normalizedTxid);
      if (isMobileUniSatDevice()) saveActiveMobileOrder(activeReceipt, normalizedTxid);
      const initialPaymentReceipt: MempoolReceipt = { txid: normalizedTxid, network: activeReceipt.chain === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin", status: "checking", message: "Payment approved. Searching Mempool…", blockHeight: null, explorerUrl: "", checkedAt: new Date().toISOString() };
      recordFinalMempoolReceipt(activeReceipt, initialPaymentReceipt);
      setStage("tracking"); setMessage("Payment approved. Live tracking of the inscription order…");
      void trackMempoolTransaction(normalizedTxid, activeReceipt.chain, paymentReceipt => recordFinalMempoolReceipt(activeReceipt, paymentReceipt));
      await pollOrder(activeReceipt.orderId, normalizedTxid, activeReceipt.chain);
    } catch (error) {
      const canceled = isWalletCancellation(error);
      const detail = walletErrorMessage(error);
      if (paymentReturned) {
        setStage("tracking");
        setMessage(`Payment was already broadcast under TXID ${returnedPaymentTxid}. Do not pay again. Inscription tracking error: ${detail}`);
        return;
      }
      const mobileUtxoGuidance = isMobileUniSatDevice() ? getMobileUtxoErrorGuidance(error, "inscribe-payment") : null;
      if (mobileUtxoGuidance && !canceled) {
        if (mobileUtxoGuidance.definitelyNotBroadcast) {
          saveActiveMobileOrder(activeReceipt, "", false);
          setStage("awaiting-approval");
        } else {
          setStage("tracking");
        }
        setMessage(`${mobileUtxoGuidance.message} UniSat detail : ${detail}`);
        return;
      }
      if (canceled && isMobileUniSatDevice()) saveActiveMobileOrder(activeReceipt, "", false);
      const mayHaveBeenSent = paymentReturned || !canceled;
      setStage(mayHaveBeenSent ? "tracking" : "awaiting-approval");
      setMessage(mayHaveBeenSent
        ? `Payment may have been sent. Do not click again until you check UniSat activity and Mempool. No TXID was recovered. UniSat detail : ${detail}`
        : `UniSat approval was canceled. No payment was confirmed. UniSat detail : ${detail}`);
    }
  };
  const approvePayment = () => {
    const provider = window.unisat;
    if (!receipt) return setMessage("Aucune commande d’inscription n’est en attente d’approbation.");
    if (!provider?.sendBitcoin) return setMessage("This UniSat version does not provide sendBitcoin; no payment was started.");
    if (isMobileUniSatDevice() && (!ownershipContextKey || ownershipProofKey !== ownershipContextKey)) {
      if (!ownershipRequested) {
        setOwnershipRequested(true);
        setMessage("Receipt confirmed. Sign the BIP-322 ownership proof; no payment has been sent to UniSat yet.");
        return;
      }
      return setMessage("BIP-322 proof is still required. No payment was started.");
    }
    if (chain?.enum !== receipt.chain || address !== receipt.walletAddress) return setMessage("The UniSat account or network changed after the receipt was created; no payment was started.");
    const feeRate = receipt.paymentFeeRate ?? receipt.feeRate;
    if (!Number.isSafeInteger(receipt.amount) || receipt.amount <= 0 || !Number.isFinite(feeRate) || feeRate <= 0 || !receipt.payAddress) return setMessage("The receipt does not contain a valid amount, address, or fee; no payment was started.");
    setStage("paying");
    if (isMobileUniSatDevice()) { setOwnershipRequested(false); setOwnershipProofKey(null); setOwnershipProofVersion(version => version + 1); }
    setMessage(`Opening sendBitcoin in UniSat. Verify ${receipt.amount.toLocaleString()} sats to ${receipt.payAddress} and the fees displayed by the wallet before approving.`);
    if (isMobileUniSatDevice()) saveActiveMobileOrder(receipt, "", true);
    let paymentPromise: Promise<string>;
    try {
      // Invoke UniSat synchronously in the click handler so both extension and in-app wallet can show approval.
      paymentPromise = sendNativeUniSatBitcoinPayment(provider, receipt.payAddress, receipt.amount, feeRate);
    } catch (error) {
      if (isMobileUniSatDevice()) saveActiveMobileOrder(receipt, "", false);
      setStage("awaiting-approval");
      const mobileUtxoGuidance = isMobileUniSatDevice() ? getMobileUtxoErrorGuidance(error, "inscribe-payment") : null;
      setMessage(isWalletCancellation(error)
        ? `UniSat approval was canceled. No payment was confirmed. Details: ${walletErrorMessage(error)}`
        : mobileUtxoGuidance
          ? `${mobileUtxoGuidance.message} UniSat detail : ${walletErrorMessage(error)}`
          : `UniSat could not open sendBitcoin. Check wallet activity before retrying. Details: ${walletErrorMessage(error)}`);
      return;
    }
    void handleApprovedPayment(paymentPromise, receipt);
  };
  const close = () => { if (["preparing", "paying"].includes(stage)) return; setOpen(false); if (stage === "tracking") return; setMessage(""); setStatus(""); setStage("idle"); setReceipt(null); setFinalReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]); };
  const reviewSavedMobileOrder = () => {
    const saved = readActiveMobileOrder();
    if (!isMobileUniSatDevice() || !saved) return setMessage("No saved mobile receipt is available.");
    setReceipt(saved.receipt); setTxid(saved.txid); setStage(saved.txid || saved.paymentStarted ? "tracking" : "awaiting-approval");
    setMessage(saved.txid ? "Mobile receipt displayed on request. Resume tracking without restarting payment." : saved.paymentStarted ? "Receipt displayed on request. Verify UniSat activity before any other action; no second payment will be sent." : "Mobile receipt displayed on request. No payment is recorded as started.");
  };
  const clearUnpaidMobileReceipt = () => {
    const saved = readActiveMobileOrder();
    const inMemoryUnpaidReceipt = Boolean(receipt && stage === "awaiting-approval" && !txid);
    if (!isMobileUniSatDevice() || (saved && receipt && saved.receipt.orderId !== receipt.orderId) || saved?.txid || saved?.paymentStarted || txid || (!saved && !inMemoryUnpaidReceipt)) {
      setMessage("This receipt may correspond to a payment attempt. Check UniSat and resume tracking; nothing was cleared.");
      return;
    }
    if (saved && !clearActiveMobileOrder()) {
      setMessage("The saved receipt could not be cleared from this browser. No file or order was modified.");
      return;
    }
    setReceipt(null); setTxid(""); setStatus(""); setStage("idle"); setFinalReceipt(null); setInscriptionIds([]); setOrderFiles([]);
    setMessage(`Unpaid receipt cleared from this device only. The UniSat order may still exist; ${files.length ? `${files.length} fichier(s) choisi(s) conservé(s).` : "vous pouvez maintenant choisir des fichiers."}`);
  };
  const downloadSelectedHistoryBatches = () => {
    const group = historyGroups.find(item => selectedHistoryBatches.includes(item.orderId));
    if (!group) return;
    const firstItem = group.items[0];
    const paymentReceipt = readSavedMempoolReceipt(historyStorageKey, group.orderId) ?? group.items.find(item => item.finalPaymentReceipt)?.finalPaymentReceipt;
    const lines = ["Ordinal inscription batch history", `Wallet: ${address}`, `Order ID: ${group.orderId}`, `Network: ${firstItem?.network ?? chain?.name ?? chain?.enum ?? "Unknown"}`, "", ...mempoolPaymentReceiptLines(paymentReceipt, firstItem?.paymentTxid, firstItem?.network), "", "Date | Filename | Inscription ID | Transaction ID | Payment TXID | Order ID | Network", ...group.items.map(item => `${new Date(item.createdAt).toISOString()} | ${item.filename} | ${item.inscriptionId} | ${item.transactionId} | ${item.paymentTxid || "Unavailable"} | ${item.orderId} | ${item.network}`)];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `inscription-batch-${group.orderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setSelectedHistoryBatches([]);
  };
  const downloadHistoryItemTxt = (item: InscriptionHistoryItem) => {
    const paymentReceipt = readSavedMempoolReceipt(historyStorageKey, item.orderId) ?? item.finalPaymentReceipt;
    const lines = ["Fractal Bitcoin Ordinal inscription record", `Wallet: ${address}`, "", ...mempoolPaymentReceiptLines(paymentReceipt, item.paymentTxid, item.network), "", "Date | Filename | Inscription ID | Transaction ID | Payment TXID | Order ID | Network", `${new Date(item.createdAt).toISOString()} | ${item.filename} | ${item.inscriptionId} | ${item.transactionId} | ${item.paymentTxid || "Unavailable"} | ${item.orderId} | ${item.network}`];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `inscription-${item.inscriptionId}.txt`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const canApprovePayment = Boolean(receipt && (receipt.paymentFeeRate ?? receipt.feeRate) > 0 && receipt.amount > 0 && receipt.payAddress);
  const busy = ["preparing", "paying"].includes(stage);
  const mobileDevice = isMobileUniSatDevice();
  const savedMobileOrder = mobileDevice ? readActiveMobileOrder() : null;
  const canClearUnpaidMobileReceipt = Boolean(mobileDevice && !busy && !txid && (savedMobileOrder ? (!savedMobileOrder.txid && !savedMobileOrder.paymentStarted && (!receipt || savedMobileOrder.receipt.orderId === receipt.orderId)) : (receipt && stage === "awaiting-approval")));
  const fileSelectionLocked = busy || (!mobileDevice && stage === "awaiting-approval");
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63] hover:bg-[#d99a54]/10"><FilePlus2 size={13} /> Inscribe files</button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090c]/80 p-4" role="dialog" aria-modal="true" aria-labelledby="inscribe-modal-title"><div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border border-[#3b434d] bg-[#14191f] p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Fractal Bitcoin Ordinals · UniSat approved</p><h2 id="inscribe-modal-title" className="mt-2 font-display text-2xl text-[#f3efe5]">Inscribe files dashboard</h2></div><button type="button" onClick={close} className="p-2 text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Close"><X size={18} /></button></div>
      <p className="mt-2 font-mono text-[10px] leading-5 text-[#7f8b99]">Images, text, HTML, JSON, SVG, audio, video, PDF, and binary files are accepted. Each file must stay within the UniSat 365 KB limit.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-4"><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Files</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{files.length} / {MAX_FILES}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Total size</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{formatBytes(totalBytes)}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Network</p><p className="mt-1 truncate font-mono text-xs text-[#f2bd63]">{chain?.name ?? chain?.enum}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Live status</p><p className="mt-1 font-mono text-xs text-[#f2bd63]">{status ? describeStatus(status) : "Ready"}</p></div></div>
{mobileDevice && savedMobileOrder && !receipt && <div className="mt-4 border border-[#e0b45f]/50 bg-[#e0b45f]/5 p-3 font-mono text-[10px] leading-5 text-[#e0b45f]" role="status"><p>A saved mobile receipt exists. It will not open automatically. Review it to resume the order; if no payment was sent, you may clear only the local copy.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={reviewSavedMobileOrder} className="border border-[#e0b45f]/60 px-3 py-2 underline">Review mobile receipt</button>{canClearUnpaidMobileReceipt && <button type="button" onClick={clearUnpaidMobileReceipt} className="border border-[#e0b45f]/60 px-3 py-2 underline">I verified that no payment was sent — clear local receipt</button>}</div></div>}
{canClearUnpaidMobileReceipt && receipt && <div className="mt-4 border border-[#e0b45f]/50 bg-[#e0b45f]/5 p-3 font-mono text-[10px] leading-5 text-[#e0b45f]"><p>Confirm that no payment was sent before adding new files. This clears the receipt from this device; it does not cancel the pending UniSat order.</p><button type="button" onClick={clearUnpaidMobileReceipt} className="mt-2 border border-[#e0b45f]/60 px-3 py-2 underline">I verified that no payment was sent — clear local receipt</button></div>}
<label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFiles(Array.from(event.dataTransfer.files ?? [])); }} className={`${mobileDevice ? "relative " : ""}mt-5 flex cursor-pointer flex-col items-center justify-center border border-dashed border-[#d99a54]/70 bg-[#10151a] px-5 py-8 text-center hover:bg-[#d99a54]/5`}><Upload size={22} className="text-[#d99a54]" /><span className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#d9d3c6]">{mobileDevice ? "Tap here to choose files" : "Drop or add files to inscribe"}</span><span className="mt-2 font-mono text-[10px] text-[#718092]">Maximum {MAX_FILES} files · 365 KB per file · multiple selection</span><input ref={filePickerRef} type="file" multiple accept="*/*" className={mobileDevice ? "absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0" : "sr-only"} disabled={fileSelectionLocked} onChange={event => { const selected = Array.from(event.currentTarget.files ?? []); chooseFiles(selected); if (mobileDevice) event.currentTarget.value = ""; }} /></label>
      {fileLoadProgress.total > 0 && stage === "preparing" && <div className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3" role="status" aria-live="polite"><div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase text-[#f2bd63]"><span>Chargement des fichiers</span><span>{fileLoadProgress.completed} / {fileLoadProgress.total}</span></div><div className="mt-2 h-1.5 overflow-hidden bg-[#2c323a]"><div className="h-full bg-[#d99a54] transition-[width] duration-150" style={{ width: `${Math.round((fileLoadProgress.completed / fileLoadProgress.total) * 100)}%` }} /></div></div>}
      {files.length > 0 && <div className="mt-4 overflow-hidden border border-[#3b434d] bg-[#10151a]"><div className="flex items-center justify-between border-b border-[#3b434d] px-3 py-2"><span className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#d9d3c6]"><Files size={13} /> File queue</span><button type="button" disabled={busy || Boolean(receipt)} onClick={() => setFiles([])} className="font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Vider</button></div><div className="max-h-48 overflow-y-auto">{files.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center justify-between gap-3 border-b border-[#2c323a] px-3 py-2 last:border-b-0"><div className="min-w-0"><p className="truncate font-mono text-[10px] text-[#d9d3c6]">{index + 1}. {file.name}</p><p className="font-mono text-[9px] text-[#718092]">{fileKind(file)} · {formatBytes(file.size)}</p></div><button type="button" disabled={busy || Boolean(receipt)} onClick={() => removeFile(index)} className="shrink-0 font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Retirer</button></div>)}</div></div>}
      <p className="mt-4 border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]">Dynamic fee rate · 30-minute target · server consensus uses the maximum of Mempool and UniSat recommendations. If estimators are unavailable, no stale manual value is used. UniSat always shows the final cost before signing.</p>
      {(receipt || busy || stage === "completed") && <div className="mt-5 border border-[#d99a54]/60 bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]"><ShieldCheck size={14} /> Pre-order receipt and wallet approval</div>{receipt && isMobileUniSatDevice() && <MobileReceiptWalletCard address={address} chain={chain} liveWallet={liveWallet} onRefresh={() => { void refreshLiveWalletData(); }} />}{receipt && <div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><div className="border border-[#d99a54]/40 bg-[#151a1f] p-3 sm:col-span-2"><p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><Activity size={12} /> Live UniSat data · synchronized before receipt</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><p className="break-all"><span className="text-[#718092]">Address:</span> {address}</p><p><span className="text-[#718092]">Network:</span> {chain?.name ?? chain?.enum}</p><p><span className="text-[#718092]">Available balance:</span> {liveWallet?.available != null ? `${liveWallet.available.toLocaleString()} ${liveWallet.asset}` : "Unavailable"}</p><p><span className="text-[#718092]">Total balance:</span> {liveWallet?.total != null ? `${liveWallet.total.toLocaleString()} ${liveWallet.asset}` : "Unavailable"}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Public key:</span> {liveWallet?.publicKey || "Unavailable"}</p><p><span className="text-[#718092]">Synchronized:</span> {liveWallet ? new Date(liveWallet.refreshedAt).toLocaleTimeString() : "Unavailable"}</p></div></div><p><span className="text-[#718092]">Files:</span> {receipt.files.length} · {formatBytes(receipt.files.reduce((sum, file) => sum + file.size, 0))}</p><p><span className="text-[#718092]">Amount:</span> {receipt.amount.toLocaleString()} sats</p><p><span className="text-[#718092]">Network:</span> {chain?.name ?? chain?.enum}</p><p><span className="text-[#718092]">Fee rate:</span> {receipt.feeRate} sat/vB</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Receiver :</span> {address}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Order ID :</span> {receipt.orderId}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Payment address:</span> {receipt.payAddress}</p>{<div className="border border-[#d99a54]/40 bg-[#151a1f] p-3 sm:col-span-2"><p className="uppercase tracking-[0.1em] text-[#f2bd63]">Native UniSat payment · review before approval</p><p className="mt-1">Exact amount: {receipt.amount.toLocaleString()} sats · requested fee rate: {receipt.paymentFeeRate ?? receipt.feeRate} sat/vB</p><p>UniSat builds and broadcasts the transaction; verify the address, amount, and fees in its confirmation window.</p></div>}{txid && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Payment TXID:</span> {txid}</p>}</div>}</div>}
      {mobileDevice && receipt && stage === "awaiting-approval" && ownershipRequested && <UniSatOwnershipProof key={`${ownershipContextKey}:${ownershipProofVersion}`} site={site} address={receipt.walletAddress} network={receipt.chain} provider={window.unisat} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />}
      {finalReceipt && <div className="mt-4 border border-[#d99a54]/70 bg-[#10151a] p-4 font-mono text-[10px] leading-5" aria-label="Live final receipt"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">Live final receipt · Mempool payment confirmation</p><p><span className="text-[#718092]">Status:</span> {finalReceipt.message}</p><p><span className="text-[#718092]">Network:</span> {finalReceipt.network}</p><p className="break-all"><span className="text-[#718092]">Payment TXID:</span> {finalReceipt.txid}</p>{finalReceipt.blockHeight !== null && <p><span className="text-[#718092]">Block:</span> {finalReceipt.blockHeight}</p>}<p><span className="text-[#718092]">Verified:</span> {new Date(finalReceipt.checkedAt).toLocaleString()}</p>{finalReceipt.explorerUrl && <a className="inline-flex items-center gap-1 text-[#d99a54] underline" href={finalReceipt.explorerUrl} target="_blank" rel="noreferrer">Open in Mempool <ExternalLink size={11} /></a>}</div>}
      {orderFiles.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><Activity size={14} /> Live results · {totalInscribed} / {orderFiles.length} created</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{orderFiles.map((file, index) => <div key={`${file.inscriptionId ?? file.filename ?? index}`} className="border border-[#2c323a] p-2 font-mono text-[9px]"><p className="truncate text-[#d9d3c6]">{file.filename ?? `File ${index + 1}`}</p><p className="mt-1 break-all text-[#718092]">{file.inscriptionId ?? describeStatus(file.status ?? status)}</p></div>)}</div></div>}
      {inscriptionHistory.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><CheckCircle2 size={14} /> Wallet history · retained for 2 months</div><div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 font-mono text-[9px] uppercase text-[#9ea7b3]">Sort by<select value={historySortKey} onChange={event => setHistorySortKey(event.target.value as HistorySortKey)} className="border border-[#3b434d] bg-[#10151a] px-2 py-1 text-[#d9d3c6]"><option value="date">Date</option><option value="filename">Filename</option><option value="inscriptionId">Inscription ID</option><option value="transactionId">Transaction ID</option><option value="orderId">Order ID</option><option value="network">Network</option></select></label><button type="button" onClick={() => setHistorySortDirection(direction => direction === "asc" ? "desc" : "asc")} className="border border-[#3b434d] px-2 py-1 font-mono text-[9px] uppercase text-[#d9d3c6]">{historySortDirection === "asc" ? "Ascending ↑" : "Descending ↓"}</button><button type="button" disabled={!selectedHistoryBatches.length} onClick={downloadSelectedHistoryBatches} className="border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#d99a54] disabled:opacity-40">Download selected batch · separate TXT</button><button type="button" onClick={() => { setInscriptionHistory([]); setHistoryPage(0); setSelectedHistoryItem(null); setSelectedHistoryBatches([]); if (historyStorageKey) localStorage.removeItem(historyStorageKey); }} className="font-mono text-[9px] uppercase text-[#a45e54]">Clear this history</button></div></div><div className="mt-3 max-h-72 overflow-x-auto overflow-y-auto border border-[#2c323a]"><div className="min-w-[1080px] font-mono text-[9px]"><div className="grid grid-cols-[150px_minmax(180px,1fr)_minmax(260px,1.5fr)_minmax(260px,1.5fr)_minmax(180px,1fr)_150px] border-b border-[#3b434d] bg-[#151a1f] px-3 py-2 uppercase tracking-[0.08em] text-[#f2bd63]"><span>Date</span><span>Filename</span><span>Inscription ID</span><span>Transaction ID</span><span>Order ID</span><span>Network</span></div>{visibleHistoryGroups.map(group => <section key={`batch-${group.orderId}`} className="border-b border-[#3b434d] last:border-b-0"><div className="sticky left-0 flex flex-wrap items-center gap-3 border-b border-[#2c323a] bg-[#151a1f] px-3 py-2 text-[9px] uppercase tracking-[0.08em] text-[#f2bd63]"><label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedHistoryBatches.includes(group.orderId)} onChange={event => setSelectedHistoryBatches(event.target.checked ? [group.orderId] : [])} aria-label={`Select batch ${group.orderId}`} /><span>Select this batch · {group.items.length} transaction(s)</span></label><span className="break-all normal-case">Order ID: {group.orderId}</span></div>{group.items.map(item => <button type="button" key={`${item.inscriptionId}-${item.transactionId}`} onClick={() => setSelectedHistoryItem(item)} className={`grid w-full grid-cols-[150px_minmax(180px,1fr)_minmax(260px,1.5fr)_minmax(260px,1.5fr)_minmax(180px,1fr)_150px] border-b border-[#2c323a] px-3 py-2 text-left last:border-b-0 hover:bg-[#d99a54]/10 ${selectedHistoryItem?.inscriptionId === item.inscriptionId && selectedHistoryItem?.transactionId === item.transactionId ? "bg-[#d99a54]/10" : ""}`} aria-label={`Open transaction ${item.transactionId}`}><span className="text-[#718092]">{new Date(item.createdAt).toLocaleString()}</span><span className="truncate pr-3 text-[#d9d3c6]" title={item.filename}>{item.filename}</span><span className="break-all pr-3 text-[#718092]">{item.inscriptionId}</span><span className="break-all pr-3 text-[#718092]">{item.transactionId}</span><span className="break-all pr-3 text-[#718092]">{item.orderId}</span><span className="truncate text-[#718092]" title={item.network}>{item.network}</span></button>)}</section>)}</div></div>{selectedHistoryItem && <div className="mt-3 border border-[#d99a54]/60 bg-[#151a1f] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#f2bd63]">Selected transaction · details</p><div className="flex gap-3"><button type="button" onClick={() => downloadHistoryItemTxt(selectedHistoryItem)} className="font-mono text-[9px] uppercase text-[#d99a54]">Download this transaction</button><button type="button" onClick={() => setSelectedHistoryItem(null)} className="font-mono text-[9px] uppercase text-[#718092]">Close details</button></div></div><div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><p><span className="text-[#718092]">Date :</span> {new Date(selectedHistoryItem.createdAt).toLocaleString()}</p><p className="break-all"><span className="text-[#718092]">Filename :</span> {selectedHistoryItem.filename}</p><p className="break-all"><span className="text-[#718092]">Inscription ID :</span> {selectedHistoryItem.inscriptionId}</p><p className="break-all"><span className="text-[#718092]">Transaction ID :</span> {selectedHistoryItem.transactionId}</p><p className="break-all"><span className="text-[#718092]">Payment TXID:</span> {selectedHistoryItem.paymentTxid || "Unavailable"}</p><p className="break-all"><span className="text-[#718092]">Order ID :</span> {selectedHistoryItem.orderId}</p><p><span className="text-[#718092]">Network :</span> {selectedHistoryItem.network}</p></div></div>}<div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#2c323a] pt-3"><span className="font-mono text-[9px] text-[#718092]">Page {historyPage + 1} / {historyPageCount} · {historyGroups.length} lot(s) · {inscriptionHistory.length} transaction(s)</span><div className="flex gap-2"><button type="button" onClick={() => setHistoryPage(page => Math.max(0, page - 1))} disabled={historyPage === 0} className="border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">Previous</button><button type="button" onClick={() => setHistoryPage(page => Math.min(historyPageCount - 1, page + 1))} disabled={historyPage >= historyPageCount - 1} className="border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">Next</button></div></div></div>}

      {message && <p className="mt-3 break-words font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">{message}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={close} disabled={busy} className="border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] disabled:opacity-40">Close</button>{!receipt && <button type="button" onClick={() => void prepareOrder()} disabled={!files.length || busy} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">{stage === "preparing" ? "Preparing…" : "Prepare receipt"}</button>}{receipt && stage === "awaiting-approval" && canApprovePayment && <button type="button" onClick={() => void approvePayment()} disabled={busy || (mobileDevice && ownershipRequested && ownershipProofKey !== ownershipContextKey)} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">{mobileDevice && ownershipRequested ? (ownershipProofKey === ownershipContextKey ? "Approve in UniSat" : "Sign ownership before payment") : mobileDevice ? "Approve in UniSat" : "Pay with UniSat sendBitcoin"}</button>}{receipt && stage === "tracking" && txid && <button type="button" onClick={() => void resumeOrderTracking()} className="border border-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63]">Resume tracking — do not pay again</button>}</div>
      {receipt && <a className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] text-[#d99a54] underline" href={`https://uniscan.cc/${chain?.enum === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : "bitcoin"}/address/${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">View wallet activity on UniScan <ExternalLink size={11} /></a>}
    </div></div>}
  </>;
}
