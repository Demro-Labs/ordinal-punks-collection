import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, ExternalLink, FilePlus2, Files, ShieldCheck, Upload, X } from "lucide-react";
import { getRecommendedFeeRate, trackMempoolTransaction, type MempoolReceipt } from "@/lib/mempool";

const API_BASE = "https://fractal-ordinal-live.servostar23.workers.dev";
const MAX_FILE_BYTES = 365 * 1024;
const MAX_FILES = 100;
type Chain = { enum?: string; name?: string };
type InscribeFile = { filename: string; size: number; type: string; dataURL?: string };
type InscribeReceipt = { orderId: string; payAddress: string; amount: number; files: InscribeFile[]; feeRate: number; chain: string; createdAt: string };
type InscribeStage = "idle" | "preparing" | "awaiting-approval" | "paying" | "tracking" | "completed";
type OrderFile = { inscriptionId?: string; filename?: string; status?: string; txid?: string; inscriptionTxid?: string };
type LiveWalletData = { publicKey: string; available: number | null; total: number | null; asset: string; refreshedAt: string };
type InscriptionHistoryItem = { inscriptionId: string; transactionId: string; paymentTxid?: string; filename: string; orderId: string; network: string; walletAddress: string; createdAt: string };
const HISTORY_RETENTION_MONTHS = 2;
const HISTORY_PAGE_SIZE = 10;
type HistorySortKey = "date" | "filename" | "inscriptionId" | "transactionId" | "orderId" | "network";

function readAsDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Impossible de lire le fichier.")); reader.readAsDataURL(file); }); }
function formatBytes(value: number) { return `${(value / 1024).toFixed(value < 1024 ? 1 : 0)} KB`; }
function describeStatus(status: string) { return ({ pending: "En attente du paiement", paid: "Paiement reçu", processing: "Inscription en cours", minted: "Inscription créée", completed: "Inscription terminée", success: "Inscription terminée", failed: "Échec", cancelled: "Annulée" } as Record<string, string>)[status] ?? status; }
function fileKind(file: File) { if (file.type.startsWith("image/")) return "Image"; if (file.type.startsWith("text/")) return "Texte"; if (file.type.startsWith("audio/")) return "Audio"; if (file.type.startsWith("video/")) return "Vidéo"; if (file.type === "application/json") return "JSON"; if (file.type === "image/svg+xml") return "SVG"; if (file.type === "application/pdf") return "PDF"; return file.type || "Binaire"; }
function isWalletCancellation(error: unknown) {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = String(value?.message ?? error ?? "");
  return value?.code === 4001 || /user (rejected|denied)|cancelled by user|request rejected/i.test(message);
}


export function UniSatInscribePanel({ verificationAction }: { verificationAction: "ordinal-punks" | "pokedex" }) {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [feeRate, setFeeRate] = useState("5");
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
  const supported = chain?.enum === "BITCOIN_MAINNET" || chain?.enum === "FRACTAL_BITCOIN_MAINNET";
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
  const historyStorageKey = address && chain?.enum ? `fractal-inscription-history:${chain.enum}:${address.toLowerCase()}` : "";
  const saveCompletedHistory = (completedFiles: OrderFile[], activeReceipt: InscribeReceipt, paymentTxid: string) => {
    if (!historyStorageKey) return;
    const now = new Date().toISOString();
    const additions = completedFiles.map((file, index) => { const inscriptionId = file.inscriptionId ?? ""; const embeddedTxid = inscriptionId.match(/^([a-f0-9]{64})i\d+$/i)?.[1]; return { inscriptionId, transactionId: file.inscriptionTxid ?? file.txid ?? embeddedTxid ?? paymentTxid, paymentTxid, filename: file.filename ?? activeReceipt.files[index]?.filename ?? `Fichier ${index + 1}`, orderId: activeReceipt.orderId, network: chain?.name ?? chain?.enum ?? "Fractal Bitcoin", walletAddress: address, createdAt: now }; }).filter(item => item.inscriptionId);
    if (!additions.length) return;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    const merged = [...additions, ...inscriptionHistory].filter((item, index, all) => item.createdAt && new Date(item.createdAt) >= cutoff && all.findIndex(candidate => candidate.inscriptionId === item.inscriptionId && candidate.transactionId === item.transactionId) === index);
    setInscriptionHistory(merged);
    setHistoryPage(0);
    try { localStorage.setItem(historyStorageKey, JSON.stringify(merged)); } catch { /* private mode or storage quota */ }
  };
  const refreshWallet = async () => { try { const [accounts, currentChain] = await Promise.all([window.unisat?.getAccounts?.(), window.unisat?.getChain?.()]); setAddress(accounts?.[0] ?? ""); setChain(currentChain ?? null); } catch { setAddress(""); setChain(null); } };
  const loadLiveWalletData = async () => {
    const provider = window.unisat;
    if (!provider) return null;
    const publicKeyResult = await Promise.allSettled([provider.getPublicKey?.()]);
    const balanceResult = await Promise.allSettled([provider.getBalanceV2 ? provider.getBalanceV2() : provider.getBalance?.()]);
    const publicKey = publicKeyResult[0]?.status === "fulfilled" ? String(publicKeyResult[0].value ?? "") : "";
    const balance = balanceResult[0]?.status === "fulfilled" ? balanceResult[0].value as { available?: number; confirmed?: number; total?: number } : null;
    const available = balance?.available ?? balance?.confirmed ?? null;
    const total = balance?.total ?? available;
    const data = { publicKey, available: typeof available === "number" ? available : null, total: typeof total === "number" ? total : null, asset: chain?.enum === "FRACTAL_BITCOIN_MAINNET" ? "FB" : "BTC", refreshedAt: new Date().toISOString() };
    setLiveWallet(data);
    return data;
  };
  useEffect(() => { void refreshWallet(); const listener = () => void refreshWallet(); window.unisat?.on?.("accountsChanged", listener); window.unisat?.on?.("chainChanged", listener); return () => { window.unisat?.removeListener?.("accountsChanged", listener); window.unisat?.removeListener?.("chainChanged", listener); }; }, []);
  useEffect(() => {
    if (!address || !chain?.enum) { setInscriptionHistory([]); setHistoryPage(0); setSelectedHistoryItem(null); setSelectedHistoryBatches([]); return; }
    const key = `fractal-inscription-history:${chain.enum}:${address.toLowerCase()}`;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as InscriptionHistoryItem[];
      const valid = stored.filter(item => item.createdAt && new Date(item.createdAt) >= cutoff).map(item => ({ ...item, transactionId: item.transactionId || item.inscriptionId?.match(/^([a-f0-9]{64})i\d+$/i)?.[1] || item.paymentTxid || "Unavailable" })).filter((item, index, all) => all.findIndex(candidate => candidate.inscriptionId === item.inscriptionId && candidate.transactionId === item.transactionId) === index);
      setInscriptionHistory(valid);
      setHistoryPage(0);
      setSelectedHistoryItem(null);
      setSelectedHistoryBatches([]);
      localStorage.setItem(key, JSON.stringify(valid));
    } catch { setInscriptionHistory([]); }
  }, [address, chain?.enum]);
  const chooseFiles = (next: File[]) => {
    if (!next.length) return;
    const combined = [...files, ...next];
    if (combined.length > MAX_FILES) { setMessage(`Maximum ${MAX_FILES} fichiers par commande.`); return; }
    const oversized = combined.find(file => file.size > MAX_FILE_BYTES);
    if (oversized) { setMessage(`${oversized.name} dépasse la limite UniSat de 365 KB.`); return; }
    setFiles(combined); setMessage(""); setStage("idle"); setReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]);
  };
  const removeFile = (index: number) => setFiles(current => current.filter((_, currentIndex) => currentIndex !== index));
  const prepareOrder = async () => {
    const provider = window.unisat; setMessage(""); setStatus(""); setReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]);
    if (!provider?.getPublicKey) return setMessage("UniSat doit être connecté et compatible avec getPublicKey.");
    if (!address || !supported || !chain?.enum) return setMessage("Connectez UniSat sur Bitcoin mainnet ou Fractal Bitcoin mainnet.");
    if (!files.length) return setMessage("Ajoutez au moins un fichier à inscrire.");
    const parsedFeeRate = Number(feeRate); if (!Number.isInteger(parsedFeeRate) || parsedFeeRate < 1 || parsedFeeRate > 10000) return setMessage("Le fee rate doit être un entier entre 1 et 10 000 sat/vB.");
    setStage("preparing");
    try {
      const [encodedFiles, publicKey] = await Promise.all([Promise.all(files.map(async file => ({ filename: file.name, dataURL: await readAsDataUrl(file) }))), provider.getPublicKey()]);
      const liveFeeRate = await getRecommendedFeeRate(chain.enum).catch(() => parsedFeeRate);
      await loadLiveWalletData();
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/api/inscribe/order`, { mode: "cors", method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: publicKey, feeRate: liveFeeRate, outputValue: 546, chain: chain.enum, files: encodedFiles }) });
      } catch {
        throw new Error("Le service d’inscription UniSat est inaccessible. Vérifiez la connexion réseau, puis réessayez sans fermer le wallet.");
      }
      const created = await response.json() as { orderId?: string; payAddress?: string; amount?: number; error?: string };
      if (!response.ok || !created.orderId || !created.payAddress || !Number.isSafeInteger(created.amount)) throw new Error(created.error || "UniSat n’a pas créé la commande.");
      setReceipt({ orderId: created.orderId, payAddress: created.payAddress, amount: Number(created.amount), files: files.map(file => ({ filename: file.name, size: file.size, type: fileKind(file) })), feeRate: liveFeeRate, chain: chain.enum, createdAt: new Date().toISOString() }); setStage("awaiting-approval"); setMessage("Reçu batch préparé. Vérifiez le réseau, le montant et les frais, puis approuvez le paiement dans UniSat.");
    } catch (error) { setStage("idle"); setMessage(error instanceof Error ? error.message : "Impossible de préparer l’inscription."); }
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
        setStage("completed");
        setFinalReceipt(current => current ? { ...current, status: "confirmed", message: `Inscription terminée : ${data.files?.filter(file => file.inscriptionId).length ?? 0} inscription(s) créée(s).`, checkedAt: new Date().toISOString() } : current);
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
  const approvePayment = async () => {
    const provider = window.unisat;
    if (!receipt || !provider?.sendBitcoin || !provider.getChain) return setMessage("UniSat ne permet pas l’approbation du paiement depuis ce navigateur.");
    setStage("paying"); setMessage("Vérification du réseau de la commande avant d’ouvrir l’approbation UniSat…");
    let paymentCallStarted = false;
    let paymentReturned = false;
    try {
      const currentChain = await provider.getChain();
      if (currentChain.enum !== receipt.chain) throw new Error("Le réseau du wallet a changé depuis la création du reçu. Revenez au réseau indiqué sur le reçu; aucun paiement n’a été envoyé.");
      paymentCallStarted = true;
      setMessage("UniSat va afficher le montant et les frais finaux avant signature.");
      const payment = await provider.sendBitcoin(receipt.payAddress, receipt.amount, { feeRate: receipt.feeRate });
      paymentReturned = true;
      const returnedTxid = typeof payment === "string" ? payment : payment?.txid;
      if (!returnedTxid || !/^[a-f0-9]{64}$/i.test(returnedTxid)) throw new Error("UniSat n’a pas retourné de TXID vérifiable. Vérifiez l’activité du wallet avant toute nouvelle action.");
      setTxid(returnedTxid);
      setFinalReceipt({ txid: returnedTxid, network: receipt.chain, status: "checking", message: "Paiement approuvé. Recherche dans Mempool…", blockHeight: null, explorerUrl: "", checkedAt: new Date().toISOString() });
      setStage("tracking"); setMessage("Paiement approuvé. Suivi live de la commande d’inscription…");
      void trackMempoolTransaction(returnedTxid, receipt.chain, setFinalReceipt);
      await pollOrder(receipt.orderId, returnedTxid, receipt.chain);
    } catch (error) {
      const canceled = isWalletCancellation(error);
      const mayHaveBeenSent = paymentReturned;
      setStage(mayHaveBeenSent ? "tracking" : "awaiting-approval");
      setMessage(mayHaveBeenSent
        ? `Le paiement peut déjà avoir été transmis. Ne l’envoyez pas une seconde fois. Vérifiez UniSat; le reçu reste disponible pour reprendre le suivi. ${error instanceof Error ? error.message : "Erreur de suivi."}`
        : (error instanceof Error ? `${error.message} Aucun TXID n’a été reçu; la commande reste en attente d’approbation.` : "UniSat n’a pas confirmé l’approbation. Aucun TXID n’a été reçu; la commande reste en attente d’approbation."));
    }
  };
  const close = () => { if (["preparing", "paying"].includes(stage)) return; setOpen(false); if (stage === "tracking") return; setMessage(""); setStatus(""); setStage("idle"); setReceipt(null); setFinalReceipt(null); setTxid(""); setInscriptionIds([]); setOrderFiles([]); };
  const downloadSelectedHistoryBatches = () => {
    const group = historyGroups.find(item => selectedHistoryBatches.includes(item.orderId));
    if (!group) return;
    const lines = ["Ordinal inscription batch history", `Wallet: ${address}`, `Order ID: ${group.orderId}`, `Network: ${group.items[0]?.network ?? chain?.name ?? chain?.enum ?? "Unknown"}`, "", "Date | Filename | Inscription ID | Transaction ID | Payment TXID | Order ID | Network", ...group.items.map(item => `${new Date(item.createdAt).toISOString()} | ${item.filename} | ${item.inscriptionId} | ${item.transactionId} | ${item.paymentTxid || "Unavailable"} | ${item.orderId} | ${item.network}`)];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `inscription-batch-${group.orderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setSelectedHistoryBatches([]);
  };
  const downloadHistoryItemTxt = (item: InscriptionHistoryItem) => {
    const lines = ["Fractal Bitcoin Ordinal inscription record", `Wallet: ${address}`, "", "Date | Filename | Inscription ID | Transaction ID | Payment TXID | Order ID | Network", `${new Date(item.createdAt).toISOString()} | ${item.filename} | ${item.inscriptionId} | ${item.transactionId} | ${item.paymentTxid || "Unavailable"} | ${item.orderId} | ${item.network}`];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `inscription-${item.inscriptionId}.txt`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const busy = ["preparing", "paying"].includes(stage);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63] hover:bg-[#d99a54]/10"><FilePlus2 size={13} /> Inscribe files</button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090c]/80 p-4" role="dialog" aria-modal="true" aria-labelledby="inscribe-modal-title"><div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border border-[#3b434d] bg-[#14191f] p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Fractal Bitcoin Ordinals · UniSat approved</p><h2 id="inscribe-modal-title" className="mt-2 font-display text-2xl text-[#f3efe5]">Inscribe files dashboard</h2></div><button type="button" onClick={close} className="p-2 text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Fermer"><X size={18} /></button></div>
      <p className="mt-2 font-mono text-[10px] leading-5 text-[#7f8b99]">Images, texte, HTML, JSON, SVG, audio, vidéo, PDF et fichiers binaires sont acceptés. Chaque fichier respecte la limite UniSat de 365 KB.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-4"><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Fichiers</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{files.length} / {MAX_FILES}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Taille totale</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{formatBytes(totalBytes)}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Réseau</p><p className="mt-1 truncate font-mono text-xs text-[#f2bd63]">{chain?.name ?? chain?.enum}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Statut live</p><p className="mt-1 font-mono text-xs text-[#f2bd63]">{status ? describeStatus(status) : "Prêt"}</p></div></div>
      <label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFiles(Array.from(event.dataTransfer.files ?? [])); }} className="mt-5 flex cursor-pointer flex-col items-center justify-center border border-dashed border-[#d99a54]/70 bg-[#10151a] px-5 py-8 text-center hover:bg-[#d99a54]/5"><Upload size={22} className="text-[#d99a54]" /><span className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#d9d3c6]">Déplacer ou ajouter les fichiers à minter</span><span className="mt-2 font-mono text-[10px] text-[#718092]">Maximum {MAX_FILES} fichiers · 365 KB par fichier · sélection multiple</span><input type="file" multiple accept="*/*" className="sr-only" disabled={busy || stage === "awaiting-approval"} onChange={event => chooseFiles(Array.from(event.target.files ?? []))} /></label>
      {files.length > 0 && <div className="mt-4 overflow-hidden border border-[#3b434d] bg-[#10151a]"><div className="flex items-center justify-between border-b border-[#3b434d] px-3 py-2"><span className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#d9d3c6]"><Files size={13} /> File queue</span><button type="button" disabled={busy} onClick={() => setFiles([])} className="font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Vider</button></div><div className="max-h-48 overflow-y-auto">{files.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center justify-between gap-3 border-b border-[#2c323a] px-3 py-2 last:border-b-0"><div className="min-w-0"><p className="truncate font-mono text-[10px] text-[#d9d3c6]">{index + 1}. {file.name}</p><p className="font-mono text-[9px] text-[#718092]">{fileKind(file)} · {formatBytes(file.size)}</p></div><button type="button" disabled={busy} onClick={() => removeFile(index)} className="shrink-0 font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Retirer</button></div>)}</div></div>}
      <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">Fee rate (sat/vB)<input value={feeRate} onChange={event => setFeeRate(event.target.value)} disabled={busy || stage === "awaiting-approval"} inputMode="numeric" className="mt-2 block w-full border border-[#3b434d] bg-[#10151a] px-3 py-2 font-mono text-xs text-[#f3efe5]" /></label>
      {(receipt || busy || stage === "completed") && <div className="mt-5 border border-[#d99a54]/60 bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]"><ShieldCheck size={14} /> Reçu de précommande et approbation wallet</div>{receipt && <div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><div className="border border-[#d99a54]/40 bg-[#151a1f] p-3 sm:col-span-2"><p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><Activity size={12} /> Données live UniSat · synchronisées avant le reçu</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><p className="break-all"><span className="text-[#718092]">Adresse :</span> {address}</p><p><span className="text-[#718092]">Réseau :</span> {chain?.name ?? chain?.enum}</p><p><span className="text-[#718092]">Solde disponible :</span> {liveWallet?.available != null ? `${liveWallet.available.toLocaleString()} ${liveWallet.asset}` : "Indisponible"}</p><p><span className="text-[#718092]">Solde total :</span> {liveWallet?.total != null ? `${liveWallet.total.toLocaleString()} ${liveWallet.asset}` : "Indisponible"}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Clé publique :</span> {liveWallet?.publicKey || "Indisponible"}</p><p><span className="text-[#718092]">Synchronisé :</span> {liveWallet ? new Date(liveWallet.refreshedAt).toLocaleTimeString() : "Indisponible"}</p></div></div><p><span className="text-[#718092]">Fichiers :</span> {receipt.files.length} · {formatBytes(receipt.files.reduce((sum, file) => sum + file.size, 0))}</p><p><span className="text-[#718092]">Montant :</span> {receipt.amount.toLocaleString()} sats</p><p><span className="text-[#718092]">Réseau :</span> {chain?.name ?? chain?.enum}</p><p><span className="text-[#718092]">Fee rate :</span> {receipt.feeRate} sat/vB</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Receiver :</span> {address}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Order ID :</span> {receipt.orderId}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Adresse paiement :</span> {receipt.payAddress}</p>{txid && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Payment TXID :</span> {txid}</p>}</div>}</div>}
      {finalReceipt && <div className="mt-4 border border-[#d99a54]/70 bg-[#10151a] p-4 font-mono text-[10px] leading-5" aria-label="Reçu final live"><p className="uppercase tracking-[0.12em] text-[#f2bd63]">Reçu final live · inscription</p><p><span className="text-[#718092]">Statut :</span> {finalReceipt.message}</p><p><span className="text-[#718092]">Réseau :</span> {finalReceipt.network}</p><p className="break-all"><span className="text-[#718092]">TXID :</span> {finalReceipt.txid}</p>{finalReceipt.blockHeight !== null && <p><span className="text-[#718092]">Bloc :</span> {finalReceipt.blockHeight}</p>}<p><span className="text-[#718092]">Vérifié :</span> {new Date(finalReceipt.checkedAt).toLocaleString()}</p>{finalReceipt.explorerUrl && <a className="inline-flex items-center gap-1 text-[#d99a54] underline" href={finalReceipt.explorerUrl} target="_blank" rel="noreferrer">Ouvrir dans Mempool <ExternalLink size={11} /></a>}</div>}
      {orderFiles.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><Activity size={14} /> Résultats live · {totalInscribed} / {orderFiles.length} créés</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{orderFiles.map((file, index) => <div key={`${file.inscriptionId ?? file.filename ?? index}`} className="border border-[#2c323a] p-2 font-mono text-[9px]"><p className="truncate text-[#d9d3c6]">{file.filename ?? `Fichier ${index + 1}`}</p><p className="mt-1 break-all text-[#718092]">{file.inscriptionId ?? describeStatus(file.status ?? status)}</p></div>)}</div></div>}
      {inscriptionHistory.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><CheckCircle2 size={14} /> Historique du wallet · conservation 2 mois</div><div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 font-mono text-[9px] uppercase text-[#9ea7b3]">Trier par<select value={historySortKey} onChange={event => setHistorySortKey(event.target.value as HistorySortKey)} className="border border-[#3b434d] bg-[#10151a] px-2 py-1 text-[#d9d3c6]"><option value="date">Date</option><option value="filename">Filename</option><option value="inscriptionId">Inscription ID</option><option value="transactionId">Transaction ID</option><option value="orderId">Order ID</option><option value="network">Network</option></select></label><button type="button" onClick={() => setHistorySortDirection(direction => direction === "asc" ? "desc" : "asc")} className="border border-[#3b434d] px-2 py-1 font-mono text-[9px] uppercase text-[#d9d3c6]">{historySortDirection === "asc" ? "Croissant ↑" : "Décroissant ↓"}</button><button type="button" disabled={!selectedHistoryBatches.length} onClick={downloadSelectedHistoryBatches} className="border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#d99a54] disabled:opacity-40">Télécharger le lot coché · TXT séparé</button><button type="button" onClick={() => { setInscriptionHistory([]); setHistoryPage(0); setSelectedHistoryItem(null); setSelectedHistoryBatches([]); if (historyStorageKey) localStorage.removeItem(historyStorageKey); }} className="font-mono text-[9px] uppercase text-[#a45e54]">Effacer cet historique</button></div></div><div className="mt-3 max-h-72 overflow-x-auto overflow-y-auto border border-[#2c323a]"><div className="min-w-[1080px] font-mono text-[9px]"><div className="grid grid-cols-[150px_minmax(180px,1fr)_minmax(260px,1.5fr)_minmax(260px,1.5fr)_minmax(180px,1fr)_150px] border-b border-[#3b434d] bg-[#151a1f] px-3 py-2 uppercase tracking-[0.08em] text-[#f2bd63]"><span>Date</span><span>Filename</span><span>Inscription ID</span><span>Transaction ID</span><span>Order ID</span><span>Network</span></div>{visibleHistoryGroups.map(group => <section key={`batch-${group.orderId}`} className="border-b border-[#3b434d] last:border-b-0"><div className="sticky left-0 flex flex-wrap items-center gap-3 border-b border-[#2c323a] bg-[#151a1f] px-3 py-2 text-[9px] uppercase tracking-[0.08em] text-[#f2bd63]"><label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedHistoryBatches.includes(group.orderId)} onChange={event => setSelectedHistoryBatches(event.target.checked ? [group.orderId] : [])} aria-label={`Sélectionner le lot ${group.orderId}`} /><span>Sélectionner ce lot · {group.items.length} transaction(s)</span></label><span className="break-all normal-case">Order ID: {group.orderId}</span></div>{group.items.map(item => <button type="button" key={`${item.inscriptionId}-${item.transactionId}`} onClick={() => setSelectedHistoryItem(item)} className={`grid w-full grid-cols-[150px_minmax(180px,1fr)_minmax(260px,1.5fr)_minmax(260px,1.5fr)_minmax(180px,1fr)_150px] border-b border-[#2c323a] px-3 py-2 text-left last:border-b-0 hover:bg-[#d99a54]/10 ${selectedHistoryItem?.inscriptionId === item.inscriptionId && selectedHistoryItem?.transactionId === item.transactionId ? "bg-[#d99a54]/10" : ""}`} aria-label={`Ouvrir la transaction ${item.transactionId}`}><span className="text-[#718092]">{new Date(item.createdAt).toLocaleString()}</span><span className="truncate pr-3 text-[#d9d3c6]" title={item.filename}>{item.filename}</span><span className="break-all pr-3 text-[#718092]">{item.inscriptionId}</span><span className="break-all pr-3 text-[#718092]">{item.transactionId}</span><span className="break-all pr-3 text-[#718092]">{item.orderId}</span><span className="truncate text-[#718092]" title={item.network}>{item.network}</span></button>)}</section>)}</div></div>{selectedHistoryItem && <div className="mt-3 border border-[#d99a54]/60 bg-[#151a1f] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#f2bd63]">Transaction sélectionnée · détail</p><div className="flex gap-3"><button type="button" onClick={() => downloadHistoryItemTxt(selectedHistoryItem)} className="font-mono text-[9px] uppercase text-[#d99a54]">Télécharger cette transaction</button><button type="button" onClick={() => setSelectedHistoryItem(null)} className="font-mono text-[9px] uppercase text-[#718092]">Fermer le détail</button></div></div><div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><p><span className="text-[#718092]">Date :</span> {new Date(selectedHistoryItem.createdAt).toLocaleString()}</p><p className="break-all"><span className="text-[#718092]">Filename :</span> {selectedHistoryItem.filename}</p><p className="break-all"><span className="text-[#718092]">Inscription ID :</span> {selectedHistoryItem.inscriptionId}</p><p className="break-all"><span className="text-[#718092]">Transaction ID :</span> {selectedHistoryItem.transactionId}</p><p className="break-all"><span className="text-[#718092]">Payment TXID :</span> {selectedHistoryItem.paymentTxid || "Indisponible"}</p><p className="break-all"><span className="text-[#718092]">Order ID :</span> {selectedHistoryItem.orderId}</p><p><span className="text-[#718092]">Network :</span> {selectedHistoryItem.network}</p></div></div>}<div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#2c323a] pt-3"><span className="font-mono text-[9px] text-[#718092]">Page {historyPage + 1} / {historyPageCount} · {historyGroups.length} lot(s) · {inscriptionHistory.length} transaction(s)</span><div className="flex gap-2"><button type="button" onClick={() => setHistoryPage(page => Math.max(0, page - 1))} disabled={historyPage === 0} className="border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">Précédent</button><button type="button" onClick={() => setHistoryPage(page => Math.min(historyPageCount - 1, page + 1))} disabled={historyPage >= historyPageCount - 1} className="border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">Suivant</button></div></div></div>}
      {message && <p className="mt-3 break-words font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">{message}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={close} disabled={busy} className="border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] disabled:opacity-40">Fermer</button>{!receipt && <button type="button" onClick={() => void prepareOrder()} disabled={!files.length || busy} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">{stage === "preparing" ? "Préparation…" : "Préparer le reçu"}</button>}{receipt && stage === "awaiting-approval" && <button type="button" onClick={() => void approvePayment()} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10]">Approuver dans UniSat</button>}{receipt && stage === "tracking" && txid && <button type="button" onClick={() => void resumeOrderTracking()} className="border border-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63]">Reprendre le suivi — sans repayer</button>}</div>
      {receipt && <a className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] text-[#d99a54] underline" href={`https://uniscan.cc/${chain?.enum === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : "bitcoin"}/address/${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">Voir l’activité du wallet sur UniScan <ExternalLink size={11} /></a>}
    </div></div>}
  </>;
}
