import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, FilePlus2, Upload, X } from "lucide-react";

const API_BASE = "https://fractal-ordinal-live.servostar23.workers.dev";
const MAX_FILE_BYTES = 365 * 1024;
type Chain = { enum?: string; name?: string };
type InscribeReceipt = { orderId: string; payAddress: string; amount: number; filename: string; size: number; feeRate: number };
type InscribeStage = "idle" | "preparing" | "awaiting-approval" | "paying" | "tracking" | "completed";


function readAsDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Impossible de lire le fichier.")); reader.readAsDataURL(file); }); }
function formatBytes(value: number) { return `${(value / 1024).toFixed(value < 1024 ? 1 : 0)} KB`; }
function describeStatus(status: string) { return ({ pending: "En attente du paiement", paid: "Paiement reçu, inscription en préparation", processing: "Inscription en cours", minted: "Inscription créée", completed: "Inscription terminée", success: "Inscription terminée" } as Record<string, string>)[status] ?? status; }

export function UniSatInscribePanel() {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [feeRate, setFeeRate] = useState("5");
  const [stage, setStage] = useState<InscribeStage>("idle");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [receipt, setReceipt] = useState<InscribeReceipt | null>(null);
  const [txid, setTxid] = useState("");
  const [inscriptionId, setInscriptionId] = useState("");
  const supported = chain?.enum === "BITCOIN_MAINNET" || chain?.enum === "FRACTAL_BITCOIN_MAINNET";
  const refreshWallet = async () => { try { const [accounts, currentChain] = await Promise.all([window.unisat?.getAccounts?.(), window.unisat?.getChain?.()]); setAddress(accounts?.[0] ?? ""); setChain(currentChain ?? null); } catch { setAddress(""); setChain(null); } };
  useEffect(() => { void refreshWallet(); const listener = () => void refreshWallet(); window.unisat?.on?.("accountsChanged", listener); window.unisat?.on?.("chainChanged", listener); return () => { window.unisat?.removeListener?.("accountsChanged", listener); window.unisat?.removeListener?.("chainChanged", listener); }; }, []);
  const chooseFile = (next: File | null) => { if (!next) return; setMessage(next.size > MAX_FILE_BYTES ? "Le fichier dépasse la limite UniSat de 365 KB." : ""); setFile(next.size <= MAX_FILE_BYTES ? next : null); setStage("idle"); setReceipt(null); setTxid(""); setInscriptionId(""); };
  const prepareOrder = async () => {
    const provider = window.unisat; setMessage(""); setStatus(""); setReceipt(null); setTxid(""); setInscriptionId("");
    if (!provider?.getPublicKey) return setMessage("UniSat doit être connecté et compatible avec getPublicKey.");
    if (!address || !supported) return setMessage("Connectez UniSat sur Bitcoin mainnet ou Fractal Bitcoin mainnet.");
    if (!file) return setMessage("Ajoutez un fichier à inscrire.");
    const parsedFeeRate = Number(feeRate); if (!Number.isInteger(parsedFeeRate) || parsedFeeRate < 1 || parsedFeeRate > 10000) return setMessage("Le fee rate doit être un entier entre 1 et 10 000 sat/vB.");
    setStage("preparing");
    try {
      const [dataURL, publicKey] = await Promise.all([readAsDataUrl(file), provider.getPublicKey()]);
      const response = await fetch(`${API_BASE}/api/inscribe/order`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: publicKey, feeRate: parsedFeeRate, outputValue: 546, file: { filename: file.name, dataURL } }) });
      const created = await response.json() as { orderId?: string; payAddress?: string; amount?: number; error?: string };
      if (!response.ok || !created.orderId || !created.payAddress || !Number.isSafeInteger(created.amount)) throw new Error(created.error || "UniSat n’a pas créé la commande.");
      setReceipt({ orderId: created.orderId, payAddress: created.payAddress, amount: Number(created.amount), filename: file.name, size: file.size, feeRate: parsedFeeRate }); setStage("awaiting-approval"); setMessage("Reçu préparé. Vérifiez toutes les informations, puis approuvez le paiement dans UniSat.");
    } catch (error) { setStage("idle"); setMessage(error instanceof Error ? error.message : "Impossible de préparer l’inscription."); }
  };
  const pollOrder = async (orderId: string) => { for (let attempt = 0; attempt < 90; attempt += 1) { const response = await fetch(`${API_BASE}/api/inscribe/order?orderId=${encodeURIComponent(orderId)}`, { cache: "no-store" }); if (!response.ok) throw new Error("Impossible de lire le statut live de l’inscription."); const data = await response.json() as { status?: string; files?: Array<{ inscriptionId?: string }> }; const nextStatus = String(data.status ?? "pending"); setStatus(nextStatus); if (["minted", "completed", "success"].includes(nextStatus)) { const id = data.files?.[0]?.inscriptionId ?? ""; setInscriptionId(id); setStage("completed"); setMessage(id ? `Inscription créée : ${id}` : "Inscription terminée."); return; } if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(nextStatus)) throw new Error(`La commande UniSat est dans l’état ${nextStatus}.`); await new Promise(resolve => window.setTimeout(resolve, 10000)); } setMessage("Commande créée ; le suivi live continue sur UniSat."); };
  const approvePayment = async () => { if (!receipt || !window.unisat?.sendBitcoin) return setMessage("UniSat ne permet pas l’approbation du paiement depuis ce navigateur."); setStage("paying"); setMessage("UniSat va afficher le montant et les frais finaux avant signature."); try { const payment = await window.unisat.sendBitcoin(receipt.payAddress, receipt.amount, { feeRate: receipt.feeRate }); const returnedTxid = typeof payment === "string" ? payment : payment?.txid; if (!returnedTxid) throw new Error("UniSat n’a pas retourné de transaction de paiement."); setTxid(returnedTxid); setStage("tracking"); setMessage("Paiement approuvé. Suivi live de la commande d’inscription…"); await pollOrder(receipt.orderId); } catch (error) { setStage("awaiting-approval"); setMessage(error instanceof Error ? error.message : "Le paiement a été annulé dans UniSat."); } };
  const close = () => { if (!["preparing", "paying", "tracking"].includes(stage)) { setOpen(false); setMessage(""); } };
  if (!address || !supported) return null;
  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#f2bd63] hover:bg-[#d99a54]/10"><FilePlus2 size={13} /> Inscribe file</button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090c]/80 p-4" role="dialog" aria-modal="true" aria-labelledby="inscribe-modal-title"><div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#3b434d] bg-[#14191f] p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d99a54]">Wallet inscription · live receipt</p><h2 id="inscribe-modal-title" className="mt-2 font-display text-2xl text-[#f3efe5]">Inscribe file</h2></div><button type="button" onClick={close} className="p-2 text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Fermer"><X size={18} /></button></div>
      <p className="mt-2 font-mono text-[10px] leading-5 text-[#7f8b99]">Le fichier est d’abord préparé sans paiement. Un reçu détaillé est affiché avant l’ouverture de la confirmation UniSat.</p>
      <label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFile(event.dataTransfer.files?.[0] ?? null); }} className="mt-5 flex cursor-pointer flex-col items-center justify-center border border-dashed border-[#d99a54]/70 bg-[#10151a] px-5 py-10 text-center hover:bg-[#d99a54]/5"><Upload size={22} className="text-[#d99a54]" /><span className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#d9d3c6]">Déplacer ou ajouter le fichier à minter</span><span className="mt-2 font-mono text-[10px] text-[#718092]">365 KB maximum · cliquez pour sélectionner</span><input type="file" className="sr-only" disabled={stage !== "idle" && stage !== "awaiting-approval"} onChange={event => chooseFile(event.target.files?.[0] ?? null)} /></label>
      {file && <div className="mt-3 flex items-center justify-between border border-[#3b434d] bg-[#10151a] p-3 font-mono text-[10px]"><span className="truncate text-[#d9d3c6]">{file.name} · {formatBytes(file.size)}</span><button type="button" onClick={() => setFile(null)} className="text-[#a45e54]">Retirer</button></div>}
      <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">Fee rate (sat/vB)<input value={feeRate} onChange={event => setFeeRate(event.target.value)} disabled={stage !== "idle" && stage !== "awaiting-approval"} inputMode="numeric" className="mt-2 block w-full border border-[#3b434d] bg-[#10151a] px-3 py-2 font-mono text-xs text-[#f3efe5]" /></label>
      {(receipt || ["preparing", "paying", "tracking", "completed"].includes(stage)) && <div className="mt-5 border border-[#d99a54]/60 bg-[#10151a] p-4"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]"><CheckCircle2 size={14} /> Reçu de pré-confirmation</div>{receipt && <div className="mt-3 grid gap-2 font-mono text-[10px] text-[#d9d3c6] sm:grid-cols-2"><p><span className="text-[#718092]">Fichier :</span> {receipt.filename}</p><p><span className="text-[#718092]">Taille :</span> {formatBytes(receipt.size)}</p><p><span className="text-[#718092]">Réseau :</span> {chain?.name ?? chain?.enum}</p><p className="break-all"><span className="text-[#718092]">Receiver :</span> {address}</p><p><span className="text-[#718092]">Montant demandé :</span> {receipt.amount.toLocaleString()} sats</p><p><span className="text-[#718092]">Fee rate :</span> {receipt.feeRate} sat/vB</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Order ID :</span> {receipt.orderId}</p><p className="break-all sm:col-span-2"><span className="text-[#718092]">Adresse de paiement :</span> {receipt.payAddress}</p>{txid && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Payment TXID :</span> {txid}</p>}{status && <p><span className="text-[#718092]">Statut live :</span> {describeStatus(status)}</p>}{inscriptionId && <p className="break-all sm:col-span-2"><span className="text-[#718092]">Inscription ID :</span> {inscriptionId}</p>}</div>}</div>}
      {message && <p className="mt-3 break-words font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">{message}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={close} disabled={["preparing", "paying", "tracking"].includes(stage)} className="border border-[#3b434d] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3] disabled:opacity-40">Fermer</button>{!receipt && <button type="button" onClick={() => void prepareOrder()} disabled={!file || ["preparing", "paying", "tracking"].includes(stage)} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:opacity-40">{stage === "preparing" ? "Préparation…" : "Préparer le reçu"}</button>}{receipt && stage === "awaiting-approval" && <button type="button" onClick={() => void approvePayment()} className="border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10]">Approuver dans UniSat</button>}</div>
      {receipt && <a className="mt-4 inline-flex items-center gap-1 font-mono text-[10px] text-[#d99a54] underline" href={`https://uniscan.cc/${chain?.enum === "FRACTAL_BITCOIN_MAINNET" ? "fractal" : "bitcoin"}/address/${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">Voir l’activité du wallet sur UniScan <ExternalLink size={11} /></a>}
    </div></div>}
  </>;
}
