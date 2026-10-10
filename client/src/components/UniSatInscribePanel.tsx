import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

const API_BASE = "https://fractal-ordinal-live.servostar23.workers.dev";
const MAX_FILE_BYTES = 365 * 1024;

type Chain = { enum?: string; name?: string };

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the file."));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

export function UniSatInscribePanel() {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState<Chain | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [feeRate, setFeeRate] = useState("5");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [order, setOrder] = useState<{ orderId: string; payAddress: string; amount: number; status?: string } | null>(null);
  const [status, setStatus] = useState("");
  const supported = chain?.enum === "BITCOIN_MAINNET" || chain?.enum === "FRACTAL_BITCOIN_MAINNET";

  useEffect(() => {
    const refresh = async () => {
      const provider = window.unisat;
      try {
        const [accounts, currentChain] = await Promise.all([provider?.getAccounts?.(), provider?.getChain?.()]);
        setAddress(accounts?.[0] ?? "");
        setChain(currentChain ?? null);
      } catch { setAddress(""); setChain(null); }
    };
    void refresh();
    window.unisat?.on?.("accountsChanged", refresh as (...args: unknown[]) => void);
    window.unisat?.on?.("chainChanged", refresh as (...args: unknown[]) => void);
    return () => {
      window.unisat?.removeListener?.("accountsChanged", refresh as (...args: unknown[]) => void);
      window.unisat?.removeListener?.("chainChanged", refresh as (...args: unknown[]) => void);
    };
  }, []);

  const pollOrder = async (orderId: string) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const response = await fetch(`${API_BASE}/api/inscribe/order?orderId=${encodeURIComponent(orderId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Impossible de lire le statut de l’inscription.");
      const data = await response.json() as { status?: string; files?: Array<{ inscriptionId?: string; txid?: string }> };
      setStatus(data.status ?? "pending");
      if (["minted", "completed", "success"].includes(String(data.status))) {
        const first = data.files?.[0];
        setMessage(first?.inscriptionId ? `Inscription créée : ${first.inscriptionId}` : "Inscription terminée.");
        return;
      }
      if (["failed", "cancelled", "payment_notenough", "payment_overpay"].includes(String(data.status))) throw new Error(`La commande UniSat est dans l’état ${data.status}.`);
      await new Promise(resolve => window.setTimeout(resolve, 10_000));
    }
    setMessage("Commande créée ; le suivi continue sur UniSat.");
  };

  const submit = async () => {
    const provider = window.unisat;
    setMessage(""); setStatus(""); setOrder(null);
    if (!provider?.getPublicKey || !provider.sendBitcoin) return setMessage("UniSat doit être connecté et compatible avec sendBitcoin.");
    if (!address || !supported) return setMessage("Connectez UniSat sur Bitcoin mainnet ou Fractal Bitcoin mainnet.");
    if (!file) return setMessage("Choisissez un fichier à inscrire.");
    if (file.size > MAX_FILE_BYTES) return setMessage("Le fichier dépasse la limite UniSat de 365 KB.");
    const parsedFeeRate = Number(feeRate);
    if (!Number.isInteger(parsedFeeRate) || parsedFeeRate < 1 || parsedFeeRate > 10000) return setMessage("Le fee rate doit être un entier entre 1 et 10 000 sat/vB.");
    setBusy(true);
    try {
      const [dataURL, publicKey] = await Promise.all([readAsDataUrl(file), provider.getPublicKey()]);
      const response = await fetch(`${API_BASE}/api/inscribe/order`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: publicKey, feeRate: parsedFeeRate, outputValue: 546, file: { filename: file.name, dataURL } }),
      });
      const created = await response.json() as { orderId?: string; payAddress?: string; amount?: number; error?: string };
      if (!response.ok || !created.orderId || !created.payAddress || !Number.isSafeInteger(created.amount)) throw new Error(created.error || "UniSat n’a pas créé la commande.");
      const orderId = created.orderId;
      const payAddress = created.payAddress;
      const amount = Number(created.amount);
      setOrder({ orderId, payAddress, amount });
      setMessage(`Commande créée. UniSat va afficher ${amount.toLocaleString()} sats à payer ; vérifiez puis approuvez dans le wallet.`);
      const payment = await provider.sendBitcoin(payAddress, amount, { feeRate: parsedFeeRate });
      const txid = typeof payment === "string" ? payment : payment?.txid;
      setMessage(txid ? `Paiement approuvé (${txid}). Suivi de l’inscription…` : "Paiement approuvé. Suivi de l’inscription…");
      await pollOrder(created.orderId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "L’opération a été annulée.");
    } finally { setBusy(false); }
  };

  if (!address || !supported) return null;
  return <section className="mt-4 border-t border-[#2c323a] pt-4" aria-labelledby="inscribe-title">
    <h3 id="inscribe-title" className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#d9d3c6]">Upload & Inscribe · approbation UniSat</h3>
    <p className="mt-1 font-mono text-[10px] leading-5 text-[#7f8b99]">Le site prépare la commande ; le fichier, le montant et les frais doivent être vérifiés dans UniSat avant approbation.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
      <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">Fichier · 365 KB max<input type="file" onChange={event => setFile(event.target.files?.[0] ?? null)} disabled={busy} className="mt-2 block w-full text-xs normal-case text-[#d9d3c6]" /></label>
      <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ea7b3]">Fee rate<input value={feeRate} onChange={event => setFeeRate(event.target.value)} disabled={busy} inputMode="numeric" className="mt-2 block w-full border border-[#3b434d] bg-[#10151a] px-3 py-2 font-mono text-xs text-[#f3efe5]" /></label>
    </div>
    <button type="button" onClick={() => void submit()} disabled={busy || !file} className="mt-3 border border-[#d99a54] bg-[#d99a54] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40">{busy ? "Waiting for UniSat…" : "Create order & review in UniSat"}</button>
    {order && <p className="mt-3 break-all font-mono text-[10px] text-[#9ea7b3]">Order {order.orderId} · payment address {order.payAddress} · {status || "payment pending"}</p>}
    {message && <p className="mt-3 break-words font-mono text-[10px] leading-5 text-[#f2bd63]" role="status">{message}</p>}
    {order && <a className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-[#d99a54] underline" href={`https://unisat.io/inscribe`} target="_blank" rel="noreferrer">Open UniSat Inscribe <ExternalLink size={11} /></a>}
  </section>;
}
