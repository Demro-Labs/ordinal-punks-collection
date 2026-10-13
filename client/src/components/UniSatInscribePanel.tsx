import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, ExternalLink, FilePlus2, Files, ShieldCheck, Upload, X } from "lucide-react";
import { describeFeeSources, getRecommendedFeeEstimate, trackMempoolTransaction, validateMempoolAddress, type FeeEstimate, type MempoolReceipt } from "@/lib/mempool";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { sendNativeUniSatBitcoinPayment } from "@/lib/native-unisat-actions";

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
function describeStatus(status: string) { return ({ pending: "En attente du paiement", paid: "Paiement reçu", processing: "Inscription en cours", minted: "Inscription créée", completed: "Inscription terminée", success: "Inscription terminée", failed: "Échec", cancelled: "Annulée" } as Record<string, string>)[status] ?? status; }
function fileKind(file: File) { if (file.type.startsWith("image/")) return "Image"; if (file.type.startsWith("text/")) return "Texte"; if (file.type.startsWith("audio/")) return "Audio"; if (file.type.startsWith("video/")) return "Vidéo"; if (file.type === "application/json") return "JSON"; if (file.type === "image/svg+xml") return "SVG"; if (file.type === "application/pdf") return "PDF"; return file.type || "Binaire"; }
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
  return "Erreur inconnue retournée par UniSat";
}


type MobileReceiptWalletCardProps = {
  address: string;
  chain: Chain | null;
  liveWallet: LiveWalletData | null;
  onRefresh: () => void;
};

function MobileReceiptWalletCard({ address, chain, liveWallet, onRefresh }: MobileReceiptWalletCardProps) {
  const networkLabel = chain?.name ?? chain?.enum ?? "Non détecté";
  const liveBalance = liveWallet?.total ?? liveWallet?.available ?? liveWallet?.confirmed;
  const formatBalance = (value: number | null | undefined) => value == null ? "Indisponible" : `${value.toLocaleString("fr-FR")} sats`;
  return <div className="mt-3 border border-[#d99a54]/50 bg-[#151a1f] p-3 font-mono text-[10px] text-[#d9d3c6]">
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="uppercase tracking-[0.1em] text-[#f2bd63]">Wallet UniSat détecté en direct</p>
        <p className="mt-1 text-[#9ea7b3]">{address ? "Compte UniSat connecté" : "Compte UniSat non détecté"}</p>
      </div>
      <button type="button" onClick={onRefresh} className="shrink-0 border border-[#3b434d] px-2 py-1 text-[9px] uppercase text-[#f2bd63]">Actualiser</button>
    </div>
    <div className="mt-3 flex items-center justify-between gap-3 border border-[#d99a54]/40 bg-[#0d1115] px-3 py-2">
      <span className="uppercase tracking-[0.08em] text-[#f2bd63]">Solde live UniSat</span>
      <strong className="text-sm text-[#f2bd63]">{formatBalance(liveBalance)}</strong>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <p className="break-all sm:col-span-2"><span className="text-[#718092]">Adresse connectée (live) :</span> {address || "Non détectée"}</p>
      <p><span className="text-[#718092]">Réseau UniSat actuel :</span> {networkLabel}</p>
      <p><span className="text-[#718092]">Solde disponible :</span> {formatBalance(liveWallet?.available)}</p>
      <p><span className="text-[#718092]">Solde confirmé :</span> {formatBalance(liveWallet?.confirmed)}</p>
      <p><span className="text-[#718092]">Solde total :</span> {formatBalance(liveWallet?.total)}</p>
    </div>
  </div>;
}

export function UniSatInscribePanel() {
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
  const filePickerRef = useRef<HTMLInputElement>(null);
  const paymentReceiptRef = useRef<{ historyKey: string; orderId: string; receipt: MempoolReceipt } | null>(null);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const totalInscribed = orderFiles.filter(file => file.inscriptionId).length;
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
    const additions = completedFiles.map((file, index) => { const inscriptionId = file.inscriptionId ?? ""; const embeddedTxid = inscriptionId.match(/^([a-f0-9]{64})i\d+$/i)?.[1]; return { inscriptionId, transactionId: file.inscriptionTxid ?? file.txid ?? embeddedTxid ?? paymentTxid, paymentTxid, finalPaymentReceipt, filename: file.filename ?? activeReceipt.files[index]?.filename ?? `Fichier ${index + 1}`, orderId: activeReceipt.orderId, network: networkLabel, walletAddress: activeReceipt.walletAddress, createdAt: now }; }).filter(item => item.inscriptionId);
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
    if (receipt) return setMessage("Un reçu existe déjà pour ce lot. Ne modifiez pas les fichiers; utilisez le paiement de ce reçu.");
    if (isMobileUniSatDevice() && readActiveMobileOrder()) return setMessage("Une commande mobile est sauvegardée. Examinez-la ou effacez son reçu non payé avant d’ajouter des fichiers.");
    if (!next.length) return;
    const combined = [...files, ...next];
    if (combined.length > MAX_FILES) { setMessage(`Maximum ${MAX_FILES} fichiers par commande.`); return; }
    const oversized = combined.find(file => file.size > MAX_FILE_BYTES);
    if (oversized) { setMessage(`${oversized.name} dépasse la limite UniSat de 365 KB.`); return; }
    setFiles(combined); setMessage(""); setStage("idle"); setReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]);
  };
  const removeFile = (index: number) => setFiles(current => current.filter((_, currentIndex) => currentIndex !== index));
  const prepareOrder = async () => {
    const provider = window.unisat;
    const mobileUniSat = isMobileUniSatDevice();
    const saved = mobileUniSat ? readActiveMobileOrder() : null;
    if (saved) {
      return setMessage("Une commande mobile est sauvegardée. Choisissez « Examiner le reçu mobile » avant toute reprise; aucune nouvelle commande n’a été créée.");
    }
    let createdReceipt: InscribeReceipt | null = null; setMessage(""); setStatus(""); setReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]);
    if (!provider?.getPublicKey) return setMessage(mobileUniSat
      ? "Aucun wallet mobile compatible n’est détecté. Ouvrez cette page dans le navigateur intégré UniSat à jour; aucune commande n’a été créée."
      : "UniSat doit être connecté et compatible avec getPublicKey.");
    if (!files.length) return setMessage("Ajoutez au moins un fichier à inscrire.");
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
      if (!activeAddress) { setStage("idle"); return setMessage("UniSat ne renvoie aucun compte connecté. Reconnectez votre adresse dans le wallet puis réessayez."); }
      if (activeChainEnum !== "BITCOIN_MAINNET" && activeChainEnum !== "FRACTAL_BITCOIN_MAINNET") {
        setStage("idle");
        return setMessage("Réseau UniSat non pris en charge. Sélectionnez Bitcoin mainnet ou Fractal Bitcoin mainnet dans le wallet.");
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
        throw new Error("Le service d’inscription UniSat est inaccessible. Vérifiez la connexion réseau, puis réessayez sans fermer le wallet.");
      }
      const created = await response.json() as { orderId?: string; payAddress?: string; amount?: number; feeRate?: number; feeSources?: FeeEstimate["sources"]; feeStrategy?: FeeEstimate["strategy"]; error?: string };
      if (!response.ok || !created.orderId || !created.payAddress || !Number.isSafeInteger(created.amount) || !Number.isSafeInteger(created.feeRate) || Number(created.feeRate) < 1) throw new Error(created.error || "UniSat n’a pas créé la commande avec un fee rate vérifiable.");
      const feeSourceLabel = describeFeeSources(created.feeStrategy ?? feeEstimate.strategy, created.feeSources ?? feeEstimate.sources);
      createdReceipt = { orderId: created.orderId, payAddress: created.payAddress, amount: Number(created.amount), files: files.map(file => ({ filename: file.name, size: file.size, type: fileKind(file) })), feeRate: Number(created.feeRate), paymentFeeRate: liveFeeRate, feeSourceLabel, chain: activeChainEnum, walletAddress: activeAddress, createdAt: new Date().toISOString() };
      setReceipt(createdReceipt);
      if (mobileUniSat) saveActiveMobileOrder(createdReceipt);
      setStage("awaiting-approval");
      setMessage(`Commande ${createdReceipt.orderId} prête. Cliquez pour ouvrir le paiement UniSat : ${createdReceipt.amount.toLocaleString()} sats vers ${createdReceipt.payAddress}. UniSat affichera les frais et la transaction finale avant votre approbation.`);
    } catch (error) {
      if (createdReceipt) { setReceipt(createdReceipt); setStage("awaiting-approval"); setMessage(`La commande ${createdReceipt.orderId} existe déjà. Ne la recréez pas. Vous pouvez ouvrir son paiement dans UniSat après vérification. Détail : ${error instanceof Error ? error.message : "erreur inconnue"}`); }
      else { setStage("idle"); setMessage(error instanceof Error ? error.message : "Impossible de préparer l’inscription."); }
    }
  };
  const pollOrder = async (orderId: string, paymentTxid: string, orderChain: string) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const query = new URLSearchParams({ orderId, chain: orderChain });
      const response = await fetch(`${API_BASE}/api/inscribe/order?${query}`, { cache: "no-store" });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        if (response.status < 500 && response.status !== 429) throw new Error(failure?.error || "Impossible de lire le statut live de l’inscription.");
        setMessage("Paiement déjà transmis; le statut UniSat est temporairement indisponible. Ne payez pas une seconde fois. Nouvelle tentative automatique…");
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
      if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(nextStatus)) throw new Error(`La commande UniSat est dans l’état ${nextStatus}.`);
      await new Promise(resolve => window.setTimeout(resolve, 10000));
    }
    setMessage("Le paiement a déjà été transmis, mais le suivi dépasse le délai prévu. Ne repayez pas; utilisez le TXID et reprenez le suivi de la commande.");
  };
  const resumeOrderTracking = async () => {
    if (!receipt || !txid) return;
    setStage("tracking"); setMessage("Reprise du suivi du paiement existant — aucun nouveau paiement ne sera envoyé.");
    try { await pollOrder(receipt.orderId, txid, receipt.chain); }
    catch (error) { setMessage(`Le paiement est déjà transmis. Ne repayez pas. Suivi UniSat : ${error instanceof Error ? error.message : "indisponible"}`); }
  };
  const handleApprovedPayment = async (paymentPromise: Promise<string>, activeReceipt: InscribeReceipt) => {
    let paymentReturned = false;
    let returnedPaymentTxid = "";
    try {
      const returnedTxid = await paymentPromise;
      paymentReturned = true;
      if (!returnedTxid || !/^[a-f0-9]{64}$/i.test(returnedTxid)) throw new Error("UniSat n’a pas retourné de TXID vérifiable. Vérifiez l’activité du wallet avant toute nouvelle action.");
      const normalizedTxid = returnedTxid.toLowerCase();
      returnedPaymentTxid = normalizedTxid;
      setTxid(normalizedTxid);
      if (isMobileUniSatDevice()) saveActiveMobileOrder(activeReceipt, normalizedTxid);
      const initialPaymentReceipt: MempoolReceipt = { txid: normalizedTxid, network: activeReceipt.chain === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin", status: "checking", message: "Paiement approuvé. Recherche dans Mempool…", blockHeight: null, explorerUrl: "", checkedAt: new Date().toISOString() };
      recordFinalMempoolReceipt(activeReceipt, initialPaymentReceipt);
      setStage("tracking"); setMessage("Paiement approuvé. Suivi live de la commande d’inscription…");
      void trackMempoolTransaction(normalizedTxid, activeReceipt.chain, paymentReceipt => recordFinalMempoolReceipt(activeReceipt, paymentReceipt));
      await pollOrder(activeReceipt.orderId, normalizedTxid, activeReceipt.chain);
    } catch (error) {
      const canceled = isWalletCancellation(error);
      const detail = walletErrorMessage(error);
      if (paymentReturned) {
        setStage("tracking");
        setMessage(`Le paiement a déjà été diffusé sous le TXID ${returnedPaymentTxid}. Ne payez pas une seconde fois. Erreur du suivi de l’inscription : ${detail}`);
        return;
      }
      if (canceled && isMobileUniSatDevice()) saveActiveMobileOrder(activeReceipt, "", false);
      const mayHaveBeenSent = paymentReturned || !canceled;
      setStage(mayHaveBeenSent ? "tracking" : "awaiting-approval");
      setMessage(mayHaveBeenSent
        ? `Le paiement a peut-être été transmis. Ne cliquez pas à nouveau avant d’avoir vérifié l’activité UniSat et Mempool. Aucun TXID n’a été récupéré. Détail UniSat : ${detail}`
        : `Approbation annulée dans UniSat. Aucun paiement n’a été confirmé. Détail UniSat : ${detail}`);
    }
  };
  const approvePayment = () => {
    const provider = window.unisat;
    if (!receipt) return setMessage("Aucune commande d’inscription n’est en attente d’approbation.");
    if (!provider?.sendBitcoin) return setMessage("Cette version d’UniSat ne fournit pas sendBitcoin; aucun paiement n’a été lancé.");
    if (chain?.enum !== receipt.chain || address !== receipt.walletAddress) return setMessage("Le compte ou réseau UniSat a changé depuis la création du reçu; aucun paiement n’a été lancé.");
    const feeRate = receipt.paymentFeeRate ?? receipt.feeRate;
    if (!Number.isSafeInteger(receipt.amount) || receipt.amount <= 0 || !Number.isFinite(feeRate) || feeRate <= 0 || !receipt.payAddress) return setMessage("Le reçu ne contient pas de montant, d’adresse ou de frais valides; aucun paiement n’a été lancé.");
    setStage("paying");
    setMessage(`Ouverture de sendBitcoin dans UniSat. Vérifiez ${receipt.amount.toLocaleString()} sats vers ${receipt.payAddress} ainsi que les frais affichés par le wallet avant d’approuver.`);
    if (isMobileUniSatDevice()) saveActiveMobileOrder(receipt, "", true);
    let paymentPromise: Promise<string>;
    try {
      // Invoke UniSat synchronously in the click handler so both extension and in-app wallet can show approval.
      paymentPromise = sendNativeUniSatBitcoinPayment(provider, receipt.payAddress, receipt.amount, feeRate);
    } catch (error) {
      if (isMobileUniSatDevice()) saveActiveMobileOrder(receipt, "", false);
      setStage("awaiting-approval");
      setMessage(isWalletCancellation(error)
        ? `Approbation annulée dans UniSat. Aucun paiement n’a été confirmé. Détail : ${walletErrorMessage(error)}`
        : `UniSat n’a pas pu ouvrir sendBitcoin. Vérifiez l’activité du wallet avant de réessayer. Détail : ${walletErrorMessage(error)}`);
      return;
    }
    void handleApprovedPayment(paymentPromise, receipt);
  };
  const close = () => { if (["preparing", "paying"].includes(stage)) return; setOpen(false); if (stage === "tracking") return; setMessage(""); setStatus(""); setStage("idle"); setReceipt(null); setFinalReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]); };
  const reviewSavedMobileOrder = () => {
    const saved = readActiveMobileOrder();
    if (!isMobileUniSatDevice() || !saved) return setMessage("Aucun reçu mobile sauvegardé n’est disponible.");
    setReceipt(saved.receipt); setTxid(saved.txid); setStage(saved.txid || saved.paymentStarted ? "tracking" : "awaiting-approval");
    setMessage(saved.txid ? "Reçu mobile affiché à votre demande. Reprenez le suivi sans relancer le paiement." : saved.paymentStarted ? "Reçu affiché à votre demande. Vérifiez l’activité UniSat avant toute autre action; aucun second paiement ne sera lancé." : "Reçu mobile affiché à votre demande. Aucun paiement n’est enregistré comme commencé.");
  };
  const clearUnpaidMobileReceipt = () => {
    const saved = readActiveMobileOrder();
    if (!isMobileUniSatDevice() || !saved || (receipt && saved.receipt.orderId !== receipt.orderId) || saved.txid || saved.paymentStarted || txid) {
      setMessage("This receipt may have a payment attempt. Check UniSat and resume tracking; it was not cleared.");
      return;
    }
    if (!clearActiveMobileOrder()) {
      setMessage("The saved receipt could not be cleared from this browser. No files or order data were changed.");
      return;
    }
    setFiles([]); setFileLoadProgress({ completed: 0, total: 0 }); setReceipt(null); setTxid(""); setStatus(""); setStage("idle"); setFinalReceipt(null); setInscriptionIds([]); setOrderFiles([]);
    setMessage("The unpaid receipt was cleared on this device only. The pending UniSat order may still exist; you can now select files.");
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
  const canClearUnpaidMobileReceipt = Boolean(mobileDevice && savedMobileOrder && (!receipt || savedMobileOrder.receipt.orderId === receipt.orderId) && !savedMobileOrder.txid && !savedMobileOrder.paymentStarted && !txid && !busy);
  const fileSelectionLocked = busy || stage === "awaiting-approval" || Boolean(mobileDevice && savedMobileOrder);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63] hover:bg-[#d99a54]/10"><FilePlus2 size={13} /> Inscribe files</button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090c]/80 p-4" role="dialog" aria-modal="true" aria-labelledby="inscribe-modal-title"><div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border border-[#3b434d] bg-[#14191f] p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Fractal Bitcoin Ordinals · UniSat approved</p><h2 id="inscribe-modal-title" className="mt-2 font-display text-2xl text-[#f3efe5]">Inscribe files dashboard</h2></div><button type="button" onClick={close} className="p-2 text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Fermer"><X size={18} /></button></div>
      <p className="mt-2 font-mono text-[10px] leading-5 text-[#7f8b99]">Images, texte, HTML, JSON, SVG, audio, vidéo, PDF et fichiers binaires sont acceptés. Chaque fichier respecte la limite UniSat de 365 KB.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-4"><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Fichiers</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{files.length} / {MAX_FILES}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Taille totale</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{formatBytes(totalBytes)}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Réseau</p><p className="mt-1 truncate font-mono text-xs text-[#f2bd63]">{chain?.name ?? chain?.enum}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Statut live</p><p className="mt-1 font-mono text-xs text-[#f2bd63]">{status ? describeStatus(status) : "Prêt"}</p></div></div>
{mobileDevice && savedMobileOrder && !receipt && <div className="mt-4 border border-[#e0b45f]/50 bg-[#e0b45f]/5 p-3 font-mono text-[10px] leading-5 text-[#e0b45f]" role="status"><p>Un reçu mobile sauvegardé existe. Il ne s’ouvrira pas automatiquement. Examinez-le pour reprendre la commande; si aucun paiement n’a été envoyé, vous pouvez effacer uniquement la copie locale.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={reviewSavedMobileOrder} className="border border-[#e0b45f]/60 px-3 py-2 underline">Examiner le reçu mobile</button>{canClearUnpaidMobileReceipt && <button type="button" onClick={clearUnpaidMobileReceipt} className="border border-[#e0b45f]/60 px-3 py-2 underline">J’ai vérifié : aucun paiement envoyé — effacer le reçu local</button>}</div></div>}
{canClearUnpaidMobileReceipt && receipt && <div className="mt-4 border border-[#e0b45f]/50 bg-[#e0b45f]/5 p-3 font-mono text-[10px] leading-5 text-[#e0b45f]"><p>Confirmez qu’aucun paiement n’a été envoyé avant de libérer l’ajout de fichiers. Cette action efface le reçu de cet appareil; elle n’annule pas la commande UniSat en attente.</p><button type="button" onClick={clearUnpaidMobileReceipt} className="mt-2 border border-[#e0b45f]/60 px-3 py-2 underline">J’ai vérifié : aucun paiement envoyé — effacer le reçu local</button></div>}
{mobileDevice && <button type="button" onClick={() => filePickerRef.current?.click()} disabled={fileSelectionLocked} className="mt-5 w-full border border-[#d99a54]/70 bg-[#10151a] px-5 py-4 font-mono text-[11px] uppercase tracking-[0.1em] text-[#d9d3c6] disabled:cursor-not-allowed disabled:opacity-40">Choisir ou ajouter des fichiers depuis le téléphone</button>}
<label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFiles(Array.from(event.dataTransfer.files ?? [])); }} className="mt-5 flex cursor-pointer flex-col items-center justify-center border border-dashed border-[#d99a54]/70 bg-[#10151a] px-5 py-8 text-center hover:bg-[#d99a54]/5"><Upload size={22} className="text-[#d99a54]" /><span className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#d9d3c6]">Déplacer ou ajouter les fichiers à minter</span><span className="mt-2 font-mono text-[10px] text-[#718092]">Maximum {MAX_FILES} fichiers · 365 KB par fichier · sélection multiple</span><input ref={filePickerRef} type="file" multiple accept="*/*" className="sr-only" disabled={fileSelectionLocked} onChange={event => { chooseFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} /></label>
      {fileLoadProgress.total > 0 && stage === "preparing" && <div className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3" role="status" aria-live="polite"><div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase text-[#f2bd63]"><span>Chargement des fichiers</span><span>{fileLoadProgress.completed} / {fileLoadProgress.total}</span></div><div className="mt-2 h-1.5 overflow-hidden bg-[#2c323a]"><div className="h-full bg-[#d99a54] transition-[width] duration-150" style={{ width: `${Math.round((fileLoadProgress.completed / fileLoadProgress.total) * 100)}%` }} /></div></div>}
      {files.length > 0 && <div className="mt-4 overflow-hidden border border-[#3b434d] bg-[#10151a]"><div className="flex items-center justify-between border-b border-[#3b434d] px-3 py-2"><span className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#d9d3c6]"><Files size={13} /> File queue</span><button type="button" disabled={busy || Boolean(receipt)} onClick={() => setFiles([])} className="font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Vider</button></div><div className="max-h-48 overflow-y-auto">{files.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center justify-between gap-3 border-b border-[#2c323a] px-3 py-2 last:border-b-0"><div className="min-w-0"><p className="truncate font-mono text-[10px] text-[#d9d3c6]">{index + 1}. {file.name}</p><p className="font-mono text-[9px] text-[#718092]">{fileKind(file)} · {formatBytes(file.size)}</p></div><button type="button" disabled={busy || Boolean(receipt)} onClick={() => removeFile(index)} className="shrink-0 font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Retirer</button></div>)}</div></div>}
      <p className="mt-4 border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px] leading-5 text-[#9ea7b3]">Fee rate dynamique · cible 30 min · consensus côté serveur = maximum des recommandations Mempool et UniSat. Si les estimateurs sont indisponibles, aucune valeur manuelle ancienne n’est utilisée. UniSat affiche toujours le coût final avant votre signature.</p>
      {(receipt || busy || stage === "completed") && <div className="mt-5 border border-[#d99a54]/60 bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]"><ShieldCheck size={14} /> Reçu de précommande et approbation wallet</div>{receipt && isMobileUniSatDevice() && <MobileReceiptWalletCard address={address} chain={chain} liveWallet={liveWallet} onRefresh={() => { void refreshLiveWalletData(); }} />}{receipt && <div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><div className="border border-[#d99a54]/40 bg-[#151a1f] p-3 sm:col-span-2"><p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><Activity size={12} /> Données live UniSat · synchronisées avant le reçu</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><p className="break-all"><span className="text-[#718092]">Adresse :</span> {address}</p><p><span className="text-[#718092]">Réseau :</span> {chain?.name ?? chain?.enum}</p><p><span className="text-[#718092]">Solde disponible :</span> {liveWallet?.available != null ? `${liveWallet.available.toLocaleString()} ${liveWallet.asset}` : "Indisponible"}</p><p><span className="text-[#718092]">Solde total :</span> {liveWallet?.total != null ? `${liveWallet.total.toLocaleString()} ${liveWallet.asset}` : "Indisponible"}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Clé publique :</span> {liveWallet?.publicKey || "Indisponible"}</p><p><span className="text-[#718092]">Synchronisé :</span> {liveWallet ? new Date(liveWallet.refreshedAt).toLocaleTimeString() : "Indisponible"}</p></div></div><p><span className="text-[#718092]">Fichiers :</span> {receipt.files.length} · {formatBytes(receipt.files.reduce((sum, file) => sum + file.size, 0))}</p><p><span className="text-[#718092]">Montant :</span> {receipt.amount.toLocaleString()} sats</p><p><span className="text-[#718092]">Réseau :</span> {chain?.name ?? chain?.enum}</p><p><span className="text-[#718092]">Fee rate :</span> {receipt.feeRate} sat/vB</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Receiver :</span> {address}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Order ID :</span> {receipt.orderId}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Adresse paiement :</span> {receipt.payAddress}</p>{<div className="border border-[#d99a54]/40 bg-[#151a1f] p-3 sm:col-span-2"><p className="uppercase tracking-[0.1em] text-[#f2bd63]">Paiement natif UniSat · revue avant approbation</p><p className="mt-1">Montant exact : {receipt.amount.toLocaleString()} sats · taux de frais demandé : {receipt.paymentFeeRate ?? receipt.feeRate} sat/vB</p><p>UniSat construit et diffuse la transaction; vérifiez l’adresse, le montant et les frais dans sa fenêtre de confirmation.</p></div>}{txid && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Payment TXID :</span> {txid}</p>}</div>}</div>}
      {finalReceipt && <div className="mt-4 border border-[#d99a54]/70 bg-[#10151a] p-4 font-mono text-[10px] leading-5" aria-label="Reçu final live"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">Reçu final live · confirmation du paiement Mempool</p><p><span className="text-[#718092]">Statut :</span> {finalReceipt.message}</p><p><span className="text-[#718092]">Réseau :</span> {finalReceipt.network}</p><p className="break-all"><span className="text-[#718092]">Payment TXID :</span> {finalReceipt.txid}</p>{finalReceipt.blockHeight !== null && <p><span className="text-[#718092]">Bloc :</span> {finalReceipt.blockHeight}</p>}<p><span className="text-[#718092]">Vérifié :</span> {new Date(finalReceipt.checkedAt).toLocaleString()}</p>{finalReceipt.explorerUrl && <a className="inline-flex items-center gap-1 text-[#d99a54] underline" href={finalReceipt.explorerUrl} target="_blank" rel="noreferrer">Ouvrir dans Mempool <ExternalLink size={11} /></a>}</div>}
      {orderFiles.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><Activity size={14} /> Résultats live · {totalInscribed} / {orderFiles.length} créés</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{orderFiles.map((file, index) => <div key={`${file.inscriptionId ?? file.filename ?? index}`} className="border border-[#2c323a] p-2 font-mono text-[9px]"><p className="truncate text-[#d9d3c6]">{file.filename ?? `Fichier ${index + 1}`}</p><p className="mt-1 break-all text-[#718092]">{file.inscriptionId ?? describeStatus(file.status ?? status)}</p></div>)}</div></div>}
      {inscriptionHistory.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><CheckCircle2 size={14} /> Historique du wallet · conservation 2 mois</div><div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 font-mono text-[9px] uppercase text-[#9ea7b3]">Trier par<select value={historySortKey} onChange={event => setHistorySortKey(event.target.value as HistorySortKey)} className="border border-[#3b434d] bg-[#10151a] px-2 py-1 text-[#d9d3c6]"><option value="date">Date</option><option value="filename">Filename</option><option value="inscriptionId">Inscription ID</option><option value="transactionId">Transaction ID</option><option value="orderId">Order ID</option><option value="network">Network</option></select></label><button type="button" onClick={() => setHistorySortDirection(direction => direction === "asc" ? "desc" : "asc")} className="border border-[#3b434d] px-2 py-1 font-mono text-[9px] uppercase text-[#d9d3c6]">{historySortDirection === "asc" ? "Croissant ↑" : "Décroissant ↓"}</button><button type="button" disabled={!selectedHistoryBatches.length} onClick={downloadSelectedHistoryBatches} className="border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#d99a54] disabled:opacity-40">Télécharger le lot coché · TXT séparé</button><button type="button" onClick={() => { setInscriptionHistory([]); setHistoryPage(0); setSelectedHistoryItem(null); setSelectedHistoryBatches([]); if (historyStorageKey) localStorage.removeItem(historyStorageKey); }} className="font-mono text-[9px] uppercase text-[#a45e54]">Effacer cet historique</button></div></div><div className="mt-3 max-h-72 overflow-x-auto overflow-y-auto border border-[#2c323a]"><div className="min-w-[1080px] font-mono text-[9px]"><div className="grid grid-cols-[150px_minmax(180px,1fr)_minmax(260px,1.5fr)_minmax(260px,1.5fr)_minmax(180px,1fr)_150px] border-b border-[#3b434d] bg-[#151a1f] px-3 py-2 uppercase tracking-[0.08em] text-[#f2bd63]"><span>Date</span><span>Filename</span><span>Inscription ID</span><span>Transaction ID</span><span>Order ID</span><span>Network</span></div>{visibleHistoryGroups.map(group => <section key={`batch-${group.orderId}`} className="border-b border-[#3b434d] last:border-b-0"><div className="sticky left-0 flex flex-wrap items-center gap-3 border-b border-[#2c323a] bg-[#151a1f] px-3 py-2 text-[9px] uppercase tracking-[0.08em] text-[#f2bd63]"><label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedHistoryBatches.includes(group.orderId)} onChange={event => setSelectedHistoryBatches(event.target.checked ? [group.orderId] : [])} aria-label={`Sélectionner le lot ${group.orderId}`} /><span>Sélectionner ce lot · {group.items.length} transaction(s)</span></label><span className="break-all normal-case">Order ID: {group.orderId}</span></div>{group.items.map(item => <button type="button" key={`${item.inscriptionId}-${item.transactionId}`} onClick={() => setSelectedHistoryItem(item)} className={`grid w-full grid-cols-[150px_minmax(180px,1fr)_minmax(260px,1.5fr)_minmax(260px,1.5fr)_minmax(180px,1fr)_150px] border-b border-[#2c323a] px-3 py-2 text-left last:border-b-0 hover:bg-[#d99a54]/10 ${selectedHistoryItem?.inscriptionId === item.inscriptionId && selectedHistoryItem?.transactionId === item.transactionId ? "bg-[#d99a54]/10" : ""}`} aria-label={`Ouvrir la transaction ${item.transactionId}`}><span className="text-[#718092]">{new Date(item.createdAt).toLocaleString()}</span><span className="truncate pr-3 text-[#d9d3c6]" title={item.filename}>{item.filename}</span><span className="break-all pr-3 text-[#718092]">{item.inscriptionId}</span><span className="break-all pr-3 text-[#718092]">{item.transactionId}</span><span className="break-all pr-3 text-[#718092]">{item.orderId}</span><span className="truncate text-[#718092]" title={item.network}>{item.network}</span></button>)}</section>)}</div></div>{selectedHistoryItem && <div className="mt-3 border border-[#d99a54]/60 bg-[#151a1f] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#f2bd63]">Transaction sélectionnée · détail</p><div className="flex gap-3"><button type="button" onClick={() => downloadHistoryItemTxt(selectedHistoryItem)} className="font-mono text-[9px] uppercase text-[#d99a54]">Télécharger cette transaction</button><button type="button" onClick={() => setSelectedHistoryItem(null)} className="font-mono text-[9px] uppercase text-[#718092]">Fermer le détail</button></div></div><div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><p><span className="text-[#718092]">Date :</span> {new Date(selectedHistoryItem.createdAt).toLocaleString()}</p><p className="break-all"><span className="text-[#718092]">Filename :</span> {selectedHistoryItem.filename}</p><p className="break-all"><span className="text-[#718092]">Inscription ID :</span> {selectedHistoryItem.inscriptionId}</p><p className="break-all"><span className="text-[#718092]">Transaction ID :</span> {selectedHistoryItem.transactionId}</p><p className="break-all"><span className="text-[#718092]">Payment TXID :</span> {selectedHistoryItem.paymentTxid || "Indisponible"}</p><p className="break-all"><span className="text-[#718092]">Order ID :</span> {selectedHistoryItem.orderId}</p><p><span className="text-[#718092]">Network :</span> {selectedHistoryItem.network}</p></div></div>}<div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#2c323a] pt-3"><span className="font-mono text-[9px] text-[#718092]">Page {historyPage + 1} / {historyPageCount} · {historyGroups.length} lot(s) · {inscriptionHistory.length} transaction(s)</span><div className="flex gap-2"><button type="button" onClick={() => setHistoryPage(page => Math.max(0, page - 1))} disabled={historyPage === 0} className="border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">Précédent</button><button type="button" onClick={() => setHistoryPage(page => Math.min(historyPageCount - 1, page + 1))} disabled={historyPage >= historyPageCount - 1} className="border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">Suivant</button></div></div></div>}

      {message && <p className="mt-3 break-words font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">{message}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={close} disabled={busy} className="border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] disabled:opacity-40">Fermer</button>{!receipt && <button type="button" onClick={() => void prepareOrder()} disabled={!files.length || busy} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">{stage === "preparing" ? "Préparation…" : "Préparer le reçu"}</button>}{receipt && stage === "awaiting-approval" && canApprovePayment && <button type="button" onClick={() => void approvePayment()} disabled={busy} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">Payer avec UniSat sendBitcoin</button>}{receipt && stage === "tracking" && txid && <button type="button" onClick={() => void resumeOrderTracking()} className="border border-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63]">Reprendre le suivi — sans repayer</button>}</div>
      {receipt && <a className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] text-[#d99a54] underline" href={`https://uniscan.cc/${chain?.enum === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : "bitcoin"}/address/${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">Voir l’activité du wallet sur UniScan <ExternalLink size={11} /></a>}
    </div></div>}
  </>;
}
