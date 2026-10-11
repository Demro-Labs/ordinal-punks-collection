import { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, ExternalLink, FilePlus2, Files, ShieldCheck, Upload, X } from "lucide-react";

const API_BASE = "https://fractal-ordinal-live.servostar23.workers.dev";
const MAX_FILE_BYTES = 365 * 1024;
const MAX_FILES = 100;
type Chain = { enum?: string; name?: string };
type InscribeFile = { filename: string; size: number; type: string; dataURL?: string };
type InscribeReceipt = { orderId: string; payAddress: string; amount: number; files: InscribeFile[]; feeRate: number; createdAt: string };
type InscribeStage = "idle" | "preparing" | "awaiting-approval" | "paying" | "tracking" | "completed";
type OrderFile = { inscriptionId?: string; filename?: string; status?: string };
type LiveWalletData = { publicKey: string; available: number | null; total: number | null; asset: string; refreshedAt: string };
type InscriptionHistoryItem = { inscriptionId: string; filename: string; orderId: string; network: string; walletAddress: string; createdAt: string };
const HISTORY_RETENTION_MONTHS = 2;

function readAsDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Impossible de lire le fichier.")); reader.readAsDataURL(file); }); }
function formatBytes(value: number) { return `${(value / 1024).toFixed(value < 1024 ? 1 : 0)} KB`; }
function describeStatus(status: string) { return ({ pending: "En attente du paiement", paid: "Paiement reçu", processing: "Inscription en cours", minted: "Inscription créée", completed: "Inscription terminée", success: "Inscription terminée", failed: "Échec", cancelled: "Annulée" } as Record<string, string>)[status] ?? status; }
function fileKind(file: File) { if (file.type.startsWith("image/")) return "Image"; if (file.type.startsWith("text/")) return "Texte"; if (file.type.startsWith("audio/")) return "Audio"; if (file.type.startsWith("video/")) return "Vidéo"; if (file.type === "application/json") return "JSON"; if (file.type === "image/svg+xml") return "SVG"; if (file.type === "application/pdf") return "PDF"; return file.type || "Binaire"; }

export function UniSatInscribePanel() {
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
  const supported = chain?.enum === "BITCOIN_MAINNET" || chain?.enum === "FRACTAL_BITCOIN_MAINNET";
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const totalInscribed = orderFiles.filter(file => file.inscriptionId).length;
  const historyStorageKey = address && chain?.enum ? `fractal-inscription-history:${chain.enum}:${address.toLowerCase()}` : "";
  const saveCompletedHistory = (completedFiles: OrderFile[], activeReceipt: InscribeReceipt) => {
    if (!historyStorageKey) return;
    const now = new Date().toISOString();
    const additions = completedFiles.map((file, index) => ({ inscriptionId: file.inscriptionId ?? "", filename: file.filename ?? activeReceipt.files[index]?.filename ?? `Fichier ${index + 1}`, orderId: activeReceipt.orderId, network: chain?.name ?? chain?.enum ?? "Fractal Bitcoin", walletAddress: address, createdAt: now })).filter(item => item.inscriptionId);
    if (!additions.length) return;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    const merged = [...additions, ...inscriptionHistory].filter((item, index, all) => item.createdAt && new Date(item.createdAt) >= cutoff && all.findIndex(candidate => candidate.inscriptionId === item.inscriptionId) === index);
    setInscriptionHistory(merged);
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
    if (!address || !chain?.enum) { setInscriptionHistory([]); return; }
    const key = `fractal-inscription-history:${chain.enum}:${address.toLowerCase()}`;
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - HISTORY_RETENTION_MONTHS);
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as InscriptionHistoryItem[];
      const valid = stored.filter(item => item.createdAt && new Date(item.createdAt) >= cutoff);
      setInscriptionHistory(valid);
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
    if (!address || !supported) return setMessage("Connectez UniSat sur Bitcoin mainnet ou Fractal Bitcoin mainnet.");
    if (!files.length) return setMessage("Ajoutez au moins un fichier à inscrire.");
    const parsedFeeRate = Number(feeRate); if (!Number.isInteger(parsedFeeRate) || parsedFeeRate < 1 || parsedFeeRate > 10000) return setMessage("Le fee rate doit être un entier entre 1 et 10 000 sat/vB.");
    setStage("preparing");
    try {
      const [encodedFiles, publicKey] = await Promise.all([Promise.all(files.map(async file => ({ filename: file.name, dataURL: await readAsDataUrl(file) }))), provider.getPublicKey()]);
      await loadLiveWalletData();
      const response = await fetch(`${API_BASE}/api/inscribe/order`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: publicKey, feeRate: parsedFeeRate, outputValue: 546, files: encodedFiles, ...(encodedFiles.length === 1 ? { file: encodedFiles[0] } : {}) }) });
      const created = await response.json() as { orderId?: string; payAddress?: string; amount?: number; error?: string };
      if (!response.ok || !created.orderId || !created.payAddress || !Number.isSafeInteger(created.amount)) throw new Error(created.error || "UniSat n’a pas créé la commande.");
      setReceipt({ orderId: created.orderId, payAddress: created.payAddress, amount: Number(created.amount), files: files.map(file => ({ filename: file.name, size: file.size, type: fileKind(file) })), feeRate: parsedFeeRate, createdAt: new Date().toISOString() }); setStage("awaiting-approval"); setMessage("Reçu batch préparé. Vérifiez toutes les informations, puis approuvez le paiement dans UniSat.");
    } catch (error) { setStage("idle"); setMessage(error instanceof Error ? error.message : "Impossible de préparer l’inscription."); }
  };
  const pollOrder = async (orderId: string) => { for (let attempt = 0; attempt < 90; attempt += 1) { const response = await fetch(`${API_BASE}/api/inscribe/order?orderId=${encodeURIComponent(orderId)}`, { cache: "no-store" }); if (!response.ok) throw new Error("Impossible de lire le statut live de l’inscription."); const data = await response.json() as { status?: string; files?: OrderFile[] }; const nextStatus = String(data.status ?? "pending"); setStatus(nextStatus); if (data.files) { setOrderFiles(data.files); setInscriptionIds(data.files.map(file => file.inscriptionId).filter((id): id is string => Boolean(id))); } if (["minted", "completed", "success"].includes(nextStatus)) { if (receipt) saveCompletedHistory(data.files ?? [], receipt); setStage("completed"); setMessage("Toutes les inscriptions créées sont visibles dans le reçu live et l’historique du wallet."); return; } if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(nextStatus)) throw new Error(`La commande UniSat est dans l’état ${nextStatus}.`); await new Promise(resolve => window.setTimeout(resolve, 10000)); } setMessage("Commande créée ; le suivi live continue sur UniSat."); };
  const approvePayment = async () => { if (!receipt || !window.unisat?.sendBitcoin) return setMessage("UniSat ne permet pas l’approbation du paiement depuis ce navigateur."); setStage("paying"); setMessage("UniSat va afficher le montant et les frais finaux avant signature."); try { const payment = await window.unisat.sendBitcoin(receipt.payAddress, receipt.amount, { feeRate: receipt.feeRate }); const returnedTxid = typeof payment === "string" ? payment : payment?.txid; if (!returnedTxid) throw new Error("UniSat n’a pas retourné de transaction de paiement."); setTxid(returnedTxid); setStage("tracking"); setMessage("Paiement approuvé. Suivi live de la commande d’inscription…"); await pollOrder(receipt.orderId); } catch (error) { setStage("awaiting-approval"); setMessage(error instanceof Error ? error.message : "Le paiement a été annulé dans UniSat."); } };
  const close = () => { if (!["preparing", "paying", "tracking"].includes(stage)) { setOpen(false); setMessage(""); } };
  if (!address || !supported) return null;
  const busy = ["preparing", "paying", "tracking"].includes(stage);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63] hover:bg-[#d99a54]/10"><FilePlus2 size={13} /> Inscribe files</button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090c]/80 p-4" role="dialog" aria-modal="true" aria-labelledby="inscribe-modal-title"><div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border border-[#3b434d] bg-[#14191f] p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Fractal Bitcoin Ordinals · UniSat approved</p><h2 id="inscribe-modal-title" className="mt-2 font-display text-2xl text-[#f3efe5]">Inscribe files dashboard</h2></div><button type="button" onClick={close} className="p-2 text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Fermer"><X size={18} /></button></div>
      <p className="mt-2 font-mono text-[10px] leading-5 text-[#7f8b99]">Images, texte, HTML, JSON, SVG, audio, vidéo, PDF et fichiers binaires sont acceptés. Chaque fichier respecte la limite UniSat de 365 KB.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-4"><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Fichiers</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{files.length} / {MAX_FILES}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Taille totale</p><p className="mt-1 font-display text-xl text-[#f3efe5]">{formatBytes(totalBytes)}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Réseau</p><p className="mt-1 truncate font-mono text-xs text-[#f2bd63]">{chain.name ?? chain.enum}</p></div><div className="border border-[#3b434d] bg-[#10151a] p-3"><p className="font-mono text-[9px] uppercase text-[#718092]">Statut live</p><p className="mt-1 font-mono text-xs text-[#f2bd63]">{status ? describeStatus(status) : "Prêt"}</p></div></div>
      <label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFiles(Array.from(event.dataTransfer.files ?? [])); }} className="mt-5 flex cursor-pointer flex-col items-center justify-center border border-dashed border-[#d99a54]/70 bg-[#10151a] px-5 py-8 text-center hover:bg-[#d99a54]/5"><Upload size={22} className="text-[#d99a54]" /><span className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#d9d3c6]">Déplacer ou ajouter les fichiers à minter</span><span className="mt-2 font-mono text-[10px] text-[#718092]">Maximum {MAX_FILES} fichiers · 365 KB par fichier · sélection multiple</span><input type="file" multiple accept="*/*" className="sr-only" disabled={busy || stage === "awaiting-approval"} onChange={event => chooseFiles(Array.from(event.target.files ?? []))} /></label>
      {files.length > 0 && <div className="mt-4 overflow-hidden border border-[#3b434d] bg-[#10151a]"><div className="flex items-center justify-between border-b border-[#3b434d] px-3 py-2"><span className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#d9d3c6]"><Files size={13} /> File queue</span><button type="button" disabled={busy} onClick={() => setFiles([])} className="font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Vider</button></div><div className="max-h-48 overflow-y-auto">{files.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center justify-between gap-3 border-b border-[#2c323a] px-3 py-2 last:border-b-0"><div className="min-w-0"><p className="truncate font-mono text-[10px] text-[#d9d3c6]">{index + 1}. {file.name}</p><p className="font-mono text-[9px] text-[#718092]">{fileKind(file)} · {formatBytes(file.size)}</p></div><button type="button" disabled={busy} onClick={() => removeFile(index)} className="shrink-0 font-mono text-[9px] uppercase text-[#a45e54] disabled:opacity-40">Retirer</button></div>)}</div></div>}
      <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">Fee rate (sat/vB)<input value={feeRate} onChange={event => setFeeRate(event.target.value)} disabled={busy || stage === "awaiting-approval"} inputMode="numeric" className="mt-2 block w-full border border-[#3b434d] bg-[#10151a] px-3 py-2 font-mono text-xs text-[#f3efe5]" /></label>
      {(receipt || busy || stage === "completed") && <div className="mt-5 border border-[#d99a54]/60 bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]"><ShieldCheck size={14} /> Reçu de précommande et approbation wallet</div>{receipt && <div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><div className="border border-[#d99a54]/40 bg-[#151a1f] p-3 sm:col-span-2"><p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><Activity size={12} /> Données live UniSat · synchronisées avant le reçu</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><p className="break-all"><span className="text-[#718092]">Adresse :</span> {address}</p><p><span className="text-[#718092]">Réseau :</span> {chain.name ?? chain.enum}</p><p><span className="text-[#718092]">Solde disponible :</span> {liveWallet?.available != null ? `${liveWallet.available.toLocaleString()} ${liveWallet.asset}` : "Indisponible"}</p><p><span className="text-[#718092]">Solde total :</span> {liveWallet?.total != null ? `${liveWallet.total.toLocaleString()} ${liveWallet.asset}` : "Indisponible"}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Clé publique :</span> {liveWallet?.publicKey || "Indisponible"}</p><p><span className="text-[#718092]">Synchronisé :</span> {liveWallet ? new Date(liveWallet.refreshedAt).toLocaleTimeString() : "Indisponible"}</p></div></div><p><span className="text-[#718092]">Fichiers :</span> {receipt.files.length} · {formatBytes(receipt.files.reduce((sum, file) => sum + file.size, 0))}</p><p><span className="text-[#718092]">Montant :</span> {receipt.amount.toLocaleString()} sats</p><p><span className="text-[#718092]">Réseau :</span> {chain.name ?? chain.enum}</p><p><span className="text-[#718092]">Fee rate :</span> {receipt.feeRate} sat/vB</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Receiver :</span> {address}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Order ID :</span> {receipt.orderId}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Adresse paiement :</span> {receipt.payAddress}</p>{txid && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Payment TXID :</span> {txid}</p>}</div>}</div>}
      {orderFiles.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><Activity size={14} /> Résultats live · {totalInscribed} / {orderFiles.length} créés</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{orderFiles.map((file, index) => <div key={`${file.inscriptionId ?? file.filename ?? index}`} className="border border-[#2c323a] p-2 font-mono text-[9px]"><p className="truncate text-[#d9d3c6]">{file.filename ?? `Fichier ${index + 1}`}</p><p className="mt-1 break-all text-[#718092]">{file.inscriptionId ?? describeStatus(file.status ?? status)}</p></div>)}</div></div>}
      {inscriptionHistory.length > 0 && <div className="mt-4 border border-[#3b434d] bg-[#10151a] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 font-mono text-[10px] uppercase text-[#f2bd63]"><CheckCircle2 size={14} /> Historique du wallet · conservation 2 mois</div><button type="button" onClick={() => { setInscriptionHistory([]); if (historyStorageKey) localStorage.removeItem(historyStorageKey); }} className="font-mono text-[9px] uppercase text-[#a45e54]">Effacer cet historique</button></div><div className="mt-3 max-h-56 overflow-y-auto">{inscriptionHistory.map(item => <div key={`${item.inscriptionId}-${item.createdAt}`} className="grid gap-1 border-b border-[#2c323a] py-2 font-mono text-[9px] last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto]"><span className="truncate text-[#d9d3c6]">{item.filename}</span><span className="break-all text-[#718092]">{item.inscriptionId}</span><span className="text-[#718092]">{new Date(item.createdAt).toLocaleDateString()}</span></div>)}</div></div>}
      {message && <p className="mt-3 break-words font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">{message}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={close} disabled={busy} className="border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] disabled:opacity-40">Fermer</button>{!receipt && <button type="button" onClick={() => void prepareOrder()} disabled={!files.length || busy} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">{stage === "preparing" ? "Préparation…" : "Préparer le reçu"}</button>}{receipt && stage === "awaiting-approval" && <button type="button" onClick={() => void approvePayment()} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10]">Approuver dans UniSat</button>}</div>
      {receipt && <a className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] text-[#d99a54] underline" href={`https://uniscan.cc/${chain.enum === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : "bitcoin"}/address/${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">Voir l’activité du wallet sur UniScan <ExternalLink size={11} /></a>}
    </div></div>}
  </>;
}
