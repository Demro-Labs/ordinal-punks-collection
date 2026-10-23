import { useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { LocalVaultOwnershipProof } from "@/components/LocalVaultOwnershipProof";
import { LocalVaultBrc20InscriptionScanner } from "@/components/LocalVaultBrc20InscriptionScanner";
import { LocalVaultSafeBalanceDiscovery } from "@/components/LocalVaultSafeBalanceDiscovery";
import { fetchProtocolBalances, type Brc20Balance } from "@/lib/protocol-balances";
import { buildBrc20TransferInscription, isConsistentBrc20PaymentState, isValidBrc20InscriptionId } from "@/lib/brc20-transfer-flow";
import { getRecommendedFeeEstimate, validateMempoolAddress } from "@/lib/mempool";
import { prepareLocalNativeTransfer } from "@/lib/local-native-transfer";
import { broadcastLocalPsbt, finalizeLocalPsbt, reviewLocalPsbt, signLocalPsbt, type LocalPsbtReview } from "@/lib/local-psbt-signer";
import type { AddressType, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";

type Site = "punks" | "pokedex";
type Order = { version: 1; site: Site; network: OrdiNetwork; address: string; addressType: AddressType; ticker: string; amount: string; recipient: string; orderId: string; payAddress: string; payAmount: number; feeRate: number; paymentStarted: boolean; paymentTxid: string; inscriptionId: string };
type Plan = { psbtHex: string; network: OrdiNetwork; addressType: AddressType; sourceAddress: string; amountSats: number; feeSats: number; feeRateSatVb: number; changeSats: number };
type Tx = { rawTxHex: string; txid: string };
const API = (import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription").replace(/\/api\/live-inscription\/?$/, "");
const keyFor = (site: Site, network: OrdiNetwork, address: string, ticker: string) => "ordi-wallet-brc20-order:v1:" + [site, network, address.toLowerCase(), ticker.toLowerCase()].map(encodeURIComponent).join(":");
const positive = (value: string) => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && /[1-9]/.test(value);
function compare(a: string, b: string) {
  const split = (v: string) => { const p = v.split("."); return [(p[0] || "0").replace(/^0+/, "") || "0", (p[1] || "").replace(/0+$/, "")]; };
  const x = split(a), y = split(b);
  if (x[0].length !== y[0].length) return x[0].length > y[0].length ? 1 : -1;
  if (x[0] !== y[0]) return x[0] > y[0] ? 1 : -1;
  const n = Math.max(x[1].length, y[1].length), xf = x[1].padEnd(n, "0"), yf = y[1].padEnd(n, "0");
  return xf === yf ? 0 : xf > yf ? 1 : -1;
}
function dataUrl(value: string) { return "data:application/json;base64," + btoa(value); }

export function LocalVaultBrc20TransferPanel({ wallet, network, addressType, site, onCreated, completedInscriptionId }: { wallet: OrdiWalletRecord; network: OrdiNetwork; addressType: AddressType; site: Site; onCreated: (id: string, recipient: string) => void; completedInscriptionId: string }) {
  const account = wallet.addresses[addressType], address = account.address;
  const [balances, setBalances] = useState<Brc20Balance[]>([]);
  const [loading, setLoading] = useState(false);
  const [ticker, setTicker] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [review, setReview] = useState<LocalPsbtReview | null>(null);
  const [signed, setSigned] = useState("");
  const [tx, setTx] = useState<Tx | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedBroadcast, setConfirmedBroadcast] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [proofKey, setProofKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const context = ticker && positive(amount) && recipient.trim()
    ? JSON.stringify(order && !order.paymentStarted && !order.inscriptionId
      ? ["brc20-payment", site, network, address, addressType, order.orderId, order.payAddress, order.payAmount, ticker, amount, recipient.trim()]
      : ["brc20-transfer", site, network, address, addressType, ticker, amount, recipient.trim()])
    : "";
  const selected = balances.find(item => item.ticker.toLowerCase() === ticker.toLowerCase()) || null;

  async function refresh() {
    setLoading(true); setError("");
    try {
      const result = await fetchProtocolBalances(address, network);
      setBalances(result.brc20);
      if (!ticker && result.brc20.length) { setTicker(result.brc20[0].ticker); setAmount(result.brc20[0].availableBalance); }
      if (result.brc20.length === 0) setMessage("Aucun solde BRC-20 classique indexé pour ce compte et ce réseau.");
    } catch (cause) { setBalances([]); setError(cause instanceof Error ? cause.message : "Impossible de charger les soldes BRC-20."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 300_000); return () => window.clearInterval(timer); }, [address, network, ticker]);
  useEffect(() => {
    setOrder(null); setPlan(null); setReview(null); setSigned(""); setTx(null); setConfirmed(false); setConfirmedBroadcast(false);
    if (!ticker) return;
    try {
      const raw = localStorage.getItem(keyFor(site, network, address, ticker));
      if (!raw) return;
      const saved = JSON.parse(raw) as Order;
      if (saved.version !== 1 || saved.site !== site || saved.network !== network || typeof saved.address !== "string" || saved.address.toLowerCase() !== address.toLowerCase() || saved.addressType !== addressType || typeof saved.ticker !== "string" || saved.ticker.toLowerCase() !== ticker.toLowerCase() || !positive(saved.amount) || typeof saved.recipient !== "string" || !saved.recipient.trim() || typeof saved.orderId !== "string" || !saved.orderId || typeof saved.payAddress !== "string" || !saved.payAddress || !Number.isSafeInteger(saved.payAmount) || saved.payAmount <= 0 || !Number.isFinite(saved.feeRate) || saved.feeRate <= 0 || (saved.paymentStarted && (typeof saved.paymentTxid !== "string" || !/^[a-f0-9]{64}$/i.test(saved.paymentTxid))) || !isConsistentBrc20PaymentState(saved)) return;
      setOrder(saved); setAmount(saved.amount); setRecipient(saved.recipient);
      setMessage(saved.paymentStarted ? "Ordre restauré. Ne payez pas une seconde fois; vérifiez d’abord son état." : "Ordre non payé restauré.");
    } catch { /* Ignore malformed local progress. */ }
  }, [site, network, address, addressType, ticker]);
  useEffect(() => {
    if (!completedInscriptionId || !order || order.inscriptionId !== completedInscriptionId) return;
    try { localStorage.removeItem(keyFor(order.site, order.network, order.address, order.ticker)); } catch { /* Storage is optional. */ }
    setOrder(null); setPlan(null); setReview(null); setSigned(""); setTx(null); setConfirmed(false); setConfirmedBroadcast(false); setAmount(""); setRecipient(""); setProofKey(null);
    setMessage("Le transfert de l’inscription a été diffusé. Actualisez les soldes avant de préparer le transfert suivant.");
  }, [completedInscriptionId, order]);
  function saveOrder(next: Order) {
    setOrder(next);
    try { localStorage.setItem(keyFor(next.site, next.network, next.address, next.ticker), JSON.stringify(next)); } catch { /* In-memory flow remains available. */ }
  }

  async function createOrder() {
    if (!selected || !context || proofKey !== context || !positive(amount) || compare(amount, selected.availableBalance) > 0 || !recipient.trim()) { setError("Choisissez un ticker et un montant disponible, indiquez le destinataire et terminez la preuve BIP-322 locale."); return; }
    if (!/^[a-z0-9]{1,32}$/i.test(ticker)) { setError("Ticker BRC-20 invalide."); return; }
    if (order) { setError("Un ordre existe déjà pour ce ticker. Reprenez-le au lieu d’en créer un autre."); return; }
    if (loading) { setError("Attendez la fin de l’actualisation des soldes avant de créer un ordre."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      // Reject a malformed or wrong-network recipient before creating a paid order.
      // Bitcoin and Fractal share address encodings, but the selected network is still bound below.
      await validateMempoolAddress(network, recipient.trim());
      // Revalidate the protocol balance immediately before creating the inscription order.
      // A previously displayed balance is not authorization to spend a BRC-20 amount.
      const fresh = await fetchProtocolBalances(address, network);
      if (fresh.network !== network || fresh.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("L’indexeur a répondu pour un autre compte ou réseau. Aucun ordre n’a été créé.");
      }
      setBalances(fresh.brc20);
      const freshSelected = fresh.brc20.find(item => item.ticker.toLowerCase() === ticker.toLowerCase());
      if (!freshSelected || compare(amount, freshSelected.availableBalance) > 0) {
        throw new Error("Le solde BRC-20 disponible a changé ou n’est plus vérifiable. Actualisez les soldes et vérifiez le montant avant de réessayer.");
      }
      const estimate = await getRecommendedFeeEstimate(network);
      const feeRate = Math.max(1, Math.ceil(estimate.feeRate));
      const response = await fetch(API + "/api/inscribe/order", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ receiver: address, refundAddress: address, userAddress: address, userPubkey: account.publicKey, feeRate, outputValue: 546, chain: network, files: [{ filename: "brc20-transfer-" + ticker + ".json", dataURL: dataUrl(buildBrc20TransferInscription(ticker, amount)) }] }) });
      const data = await response.json().catch(() => null) as { orderId?: string; payAddress?: string; amount?: number; error?: string } | null;
      if (!response.ok || !data?.orderId || !data.payAddress || !Number.isSafeInteger(data.amount) || !data.amount || data.amount <= 0) throw new Error(data?.error || "Le service d’inscription n’a pas créé un ordre valide.");
      saveOrder({ version: 1, site, network, address, addressType, ticker, amount, recipient: recipient.trim(), orderId: data.orderId, payAddress: data.payAddress, payAmount: data.amount, feeRate, paymentStarted: false, paymentTxid: "", inscriptionId: "" });
      setMessage("Ordre préparé sans paiement. Préparez le paiement local ci-dessous.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de préparer l’ordre BRC-20."); }
    finally { setBusy(false); }
  }
  async function preparePayment() {
    if (!order || order.paymentStarted || order.inscriptionId) return;
    if (!context || proofKey !== context) { setError("Terminez la preuve BIP-322 du portefeuille Ordi local pour cet ordre avant de préparer le paiement."); return; }
    setBusy(true); setError(""); setPlan(null); setReview(null); setSigned(""); setTx(null); setConfirmed(false); setConfirmedBroadcast(false);
    try {
      const payment = await prepareLocalNativeTransfer(network, wallet, addressType, order.payAddress, (order.payAmount / 100_000_000).toFixed(8));
      const examined = await reviewLocalPsbt(payment.psbtHex, wallet, network);
      if (examined.addressType !== addressType || examined.sourceAddress !== address || !examined.outputs.some(o => o.address === order.payAddress && o.valueSats === order.payAmount)) throw new Error("Le paiement examiné ne correspond pas à l’ordre. Aucun paiement n’a été signé.");
      setPlan(payment); setReview(examined); setMessage("Montant exact et UTXO sûrs vérifiés. Rien n’est encore signé.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Impossible de préparer le paiement local."); }
    finally { setBusy(false); }
  }
  async function signPayment() {
    if (!order || !plan || !review || !confirmed || order.paymentStarted) return;
    if (!context || proofKey !== context) { setError("Terminez la preuve BIP-322 du portefeuille Ordi local pour cet ordre avant de signer le paiement."); return; }
    setBusy(true); setError("");
    try { setSigned(await signLocalPsbt(plan.psbtHex, wallet, review)); setMessage("Signature locale créée; la transaction n’est pas encore diffusée."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "La signature locale a échoué."); }
    finally { setBusy(false); }
  }
  async function finalizePayment() {
    if (!order || !plan || !review || !signed || order.paymentStarted) return;
    setBusy(true); setError("");
    setConfirmedBroadcast(false);
    try { setTx(await finalizeLocalPsbt(signed, wallet, review)); setMessage("Transaction finalisée et vérifiée. La diffusion reste une action séparée."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "La finalisation a échoué."); }
    finally { setBusy(false); }
  }
  async function broadcastPayment() {
    if (!order || !review || !tx || order.paymentStarted || !confirmedBroadcast) return;
    const attempted = { ...order, paymentStarted: true, paymentTxid: tx.txid };
    saveOrder(attempted);
    setBusy(true); setError(""); setMessage("Diffusion demandée. Le paiement est marqué comme tenté pour éviter tout double paiement.");
    try { await broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review); setMessage("Paiement diffusé: " + tx.txid + ". Vérifiez l’ordre pour récupérer l’inscription."); setPlan(null); setReview(null); setSigned(""); setTx(null); setConfirmedBroadcast(false); }
    catch (cause) { setError((cause instanceof Error ? cause.message : "Résultat de diffusion incertain.") + " Ne payez pas à nouveau; vérifiez le TXID " + tx.txid + "."); }
    finally { setBusy(false); }
  }
  async function checkPaymentStatus() {
    if (!order?.paymentStarted || !order.paymentTxid) return;
    setBusy(true); setError(""); setMessage("Vérification du TXID du paiement; aucun nouveau paiement ne sera envoyé.");
    try {
      const query = new URLSearchParams({ chain: network, txid: order.paymentTxid });
      const response = await fetch(API + "/api/mempool/tx-status?" + query, { cache: "no-store", headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null) as { confirmed?: boolean; block_height?: number; error?: string } | null;
      if (response.status === 404) {
        setMessage("Le TXID n’est pas trouvé par l’explorateur pour le moment. Cela ne prouve pas à lui seul que le paiement n’a pas été accepté. Ne payez pas à nouveau; vérifiez le même TXID sur l’explorateur et réessayez cette vérification plus tard.");
        return;
      }
      if (!response.ok || !data || typeof data.confirmed !== "boolean") throw new Error(data?.error || "L’état du TXID n’a pas pu être confirmé.");
      setMessage(data.confirmed
        ? "Paiement confirmé dans le bloc " + (Number.isSafeInteger(data.block_height) ? data.block_height : "inconnu") + " · TXID " + order.paymentTxid + ". Vérifiez maintenant l’ordre d’inscription."
        : "Le TXID est présent dans le mempool mais pas encore confirmé · " + order.paymentTxid + ". Aucun nouveau paiement n’a été envoyé.");
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : "Vérification du TXID impossible.") + " Ne payez pas à nouveau tant que le TXID n’a pas été vérifié.");
    } finally { setBusy(false); }
  }

  async function checkOrder() {
    if (!order || !order.paymentStarted || order.inscriptionId) return;
    setBusy(true); setError(""); setMessage("Vérification de l’ordre existant; aucun nouveau paiement ne sera envoyé.");
    try {
      const response = await fetch(API + "/api/inscribe/order?" + new URLSearchParams({ orderId: order.orderId, chain: network }), { cache: "no-store", headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => null) as { status?: string; files?: Array<{ inscriptionId?: string }>; error?: string } | null;
      if (!response.ok || !data) throw new Error(data?.error || "Impossible de lire l’ordre.");
      const id = data.files?.find(file => isValidBrc20InscriptionId(file.inscriptionId))?.inscriptionId || "";
      if (!id) { setMessage("Inscription pas encore indexée (état: " + (data.status || "inconnu") + "). Aucun nouveau paiement n’a été envoyé; réessayez plus tard."); return; }
      const next = { ...order, inscriptionId: id }; saveOrder(next); setMessage("Inscription créée: " + id + ". Sélectionnez-la ci-dessous pour envoyer les jetons au destinataire."); onCreated(id, order.recipient);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Vérification de l’ordre échouée. Ne payez pas à nouveau."); }
    finally { setBusy(false); }
  }
  function discardOrder() {
    if (!order || order.paymentStarted) return;
    try { localStorage.removeItem(keyFor(site, network, address, order.ticker)); } catch { /* Storage is optional. */ }
    setOrder(null); setPlan(null); setReview(null); setSigned(""); setTx(null); setConfirmed(false); setConfirmedBroadcast(false); setMessage("Ordre non payé supprimé."); setError("");
  }

  return <section id="local-vault-brc20-transfer" className="mt-4 scroll-mt-6 border border-[#d99a54]/40 bg-[#10151a] p-3 sm:p-4" aria-labelledby="local-vault-brc20-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#f2bd63]">Local Vault · Parcours B · Classic BRC-20</p><h3 id="local-vault-brc20-title" className="mt-1 font-display text-lg text-[#f3efe5]">BRC-20 balances &amp; transfer</h3><p className="mt-1 font-mono text-[9px] leading-4 text-[#9ea7b3]">{network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet"} · compte local actif</p></div><button type="button" onClick={() => void refresh()} disabled={loading || busy} className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Actualiser</button></div>
    {balances.length > 0 && <div className="mt-3 space-y-2">{balances.map(item => <button key={item.ticker} type="button" disabled={Boolean(order) || busy} onClick={() => { setTicker(item.ticker); setAmount(item.availableBalance); setProofKey(null); }} className={"flex min-h-11 w-full flex-wrap items-center justify-between gap-2 border px-3 py-2 text-left font-mono text-[10px] " + (item.ticker.toLowerCase() === ticker.toLowerCase() ? "border-[#d99a54] bg-[#d99a54]/10" : "border-[#2c323a] bg-[#0b0f13]")}><span className="text-[#f2bd63]">{item.ticker}</span><span>Total {item.overallBalance}</span><span className="text-[#70c7a0]">Disponible {item.availableBalance}</span><span className="text-[#9ea7b3]">Transférable {item.transferableBalance}</span></button>)}</div>}
    {loading && <p className="mt-2 font-mono text-[9px] text-[#718092]">Chargement des soldes BRC-20…</p>}
    <LocalVaultBrc20InscriptionScanner address={address} network={network} ticker={ticker} recipient={recipient} disabled={busy} selectionDisabled={Boolean(order)} onSelect={(inscriptionId, target) => onCreated(inscriptionId, target)} />
    {error && !order && <p className="mt-2 break-words font-mono text-[10px] text-[#e6a69b]" role="alert">{error}</p>}
    {!order && <div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="font-mono text-[9px] uppercase text-[#9ea7b3]">Ticker<input value={ticker} onChange={e => { setTicker(e.target.value.trim()); setProofKey(null); }} placeholder="ordi" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0f13] p-3 text-sm text-[#f3efe5]" /></label><label className="font-mono text-[9px] uppercase text-[#9ea7b3]">Montant<input value={amount} onChange={e => { setAmount(e.target.value); setProofKey(null); }} inputMode="decimal" placeholder="Montant disponible" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0f13] p-3 text-sm text-[#f3efe5]" /></label><label className="font-mono text-[9px] uppercase text-[#9ea7b3] sm:col-span-2">Adresse destinataire<input value={recipient} onChange={e => { setRecipient(e.target.value); setProofKey(null); }} placeholder="Adresse Bitcoin / Fractal" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0f13] p-3 text-sm text-[#f3efe5]" /></label></div>}
    {selected && <p className="mt-2 font-mono text-[9px] text-[#718092]">Total {selected.overallBalance} {selected.ticker} · disponible pour une nouvelle inscription: {selected.availableBalance}. Un solde disponible à zéro ne peut pas créer une inscription de transfert.</p>}
    {context && (!order || (!order.paymentStarted && !order.inscriptionId)) && <LocalVaultOwnershipProof key={context} site={site} network={network} wallet={wallet} addressType={addressType} contextKey={context} onVerified={setProofKey} />}
    <LocalVaultSafeBalanceDiscovery wallet={wallet} network={network} selectedAddressType={addressType} />
    {!order && <button type="button" onClick={() => void createOrder()} disabled={busy || !selected || !positive(amount) || compare(amount, selected.availableBalance) > 0 || !recipient.trim() || !context || proofKey !== context} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 bg-[#d99a54] px-4 font-mono text-[10px] uppercase text-[#0b0d10] disabled:opacity-40">{busy ? <Loader2 size={13} className="animate-spin" /> : <Wallet size={13} />} Préparer l’inscription de transfert (sans paiement)</button>}
    {order && <div className="mt-3 border border-[#d99a54]/50 bg-[#0b0f13] p-3 font-mono text-[10px] leading-5">
      <button type="button" onClick={() => setReceiptOpen(value => !value)} aria-expanded={receiptOpen} className="flex min-h-11 w-full items-center justify-between gap-2 text-left uppercase text-[#f2bd63]">
        <span>Reçu de précommande BRC-20</span><span>{receiptOpen ? "Masquer le reçu −" : "Afficher le reçu +"}</span>
      </button>
      {receiptOpen && <div className="mt-2 border-t border-[#3b434d] pt-2" role="region" aria-label="Reçu de précommande BRC-20">
        <p className="text-[#f2bd63]">Ordre: {order.orderId}</p>
        <p className="break-all">Adresse de paiement: {order.payAddress}</p>
        <p>Coût exact de l’ordre: {order.payAmount.toLocaleString("en-US")} sats · frais réseau séparés.</p>
        <p>Réseau: {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet"}</p>
        <p>Jeton et montant: {order.amount} {order.ticker}</p>
        <p className="break-all">Destinataire prévu: {order.recipient}</p>
        <p>État du paiement: {order.paymentStarted ? "paiement démarré — vérifier le TXID avant toute nouvelle action" : "précommande non payée"}</p>
        {order.paymentTxid && <p className="break-all">TXID paiement: {order.paymentTxid}</p>}
        {order.inscriptionId && <p className="break-all text-[#70c7a0]">Inscription créée: {order.inscriptionId}</p>}
      </div>}
      {!order.paymentStarted && !order.inscriptionId && !plan && <button type="button" onClick={() => void preparePayment()} disabled={busy || !context || proofKey !== context} className="mt-3 min-h-11 w-full border border-[#3b434d] px-3 uppercase disabled:opacity-40">{busy ? "Préparation…" : "Préparer et examiner le paiement local"}</button>}
      {!order.paymentStarted && !order.inscriptionId && !(review && plan) && <button type="button" disabled className="mt-2 min-h-11 w-full border border-[#3b434d] px-3 uppercase text-[#718092] disabled:opacity-60" aria-label="Signer localement indisponible avant la préparation et la revue du PSBT">Signer localement · préparer et vérifier le PSBT d’abord</button>}
      {review && plan && !order.paymentStarted && <div className="mt-3 border border-[#3b434d] p-3"><p>Entrées: {review.inputCount} · total {review.inputSats.toLocaleString("en-US")} sats · frais {review.feeSats.toLocaleString("en-US")} sats · change {plan.changeSats.toLocaleString("en-US")} sats.</p><p className="break-all">Destination: {order.payAddress} · montant exact {order.payAmount.toLocaleString("en-US")} sats.</p><label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1" /><span>Je confirme le réseau, l’adresse de paiement, le montant exact et les frais séparés. Signer dans le coffre local.</span></label><button type="button" onClick={() => void signPayment()} disabled={busy || !confirmed || !context || proofKey !== context} className="mt-3 min-h-11 w-full bg-[#d99a54] px-3 uppercase text-[#0b0f13] disabled:opacity-40">{busy ? "Signature…" : "Signer localement"}</button></div>}
      {signed && !tx && !order.paymentStarted && <button type="button" onClick={() => void finalizePayment()} disabled={busy} className="mt-3 min-h-11 w-full border border-[#3b434d] px-3 uppercase">{busy ? "Finalisation…" : "Vérifier la transaction signée"}</button>}
      {tx && !order.paymentStarted && <div className="mt-3 border border-[#e0b45f]/40 p-3"><p className="break-all">TXID: {tx.txid}</p><label className="mt-2 flex min-h-11 items-start gap-2"><input type="checkbox" checked={confirmedBroadcast} onChange={e => setConfirmedBroadcast(e.target.checked)} className="mt-1 h-4 w-4" /><span>Je confirme ce TXID exact, le montant du paiement et sa diffusion irréversible sur {network}.</span></label><button type="button" onClick={() => void broadcastPayment()} disabled={busy || !confirmedBroadcast} className="mt-3 min-h-11 w-full bg-[#d99a54] px-3 uppercase text-[#0b0f13] disabled:opacity-40">{busy ? "Diffusion…" : "Diffuser le paiement de l’inscription"}</button></div>}
      {order.paymentStarted && order.paymentTxid && <button type="button" onClick={() => void checkPaymentStatus()} disabled={busy} className="mt-3 min-h-11 w-full border border-[#3b434d] px-3 uppercase disabled:opacity-40">{busy ? "Vérification…" : "Vérifier le TXID du paiement (sans paiement)"}</button>}
      {order.paymentStarted && !order.inscriptionId && <button type="button" onClick={() => void checkOrder()} disabled={busy} className="mt-3 min-h-11 w-full border border-[#d99a54] px-3 uppercase disabled:opacity-40">{busy ? "Vérification…" : "Vérifier l’ordre / inscription (sans paiement)"}</button>}
      {order.inscriptionId && <button type="button" onClick={() => onCreated(order.inscriptionId, order.recipient)} className="mt-3 min-h-11 w-full border border-[#70c7a0] px-3 uppercase text-[#70c7a0]">Sélectionner l’inscription pour l’envoyer</button>}
      {!order.paymentStarted && <button type="button" onClick={discardOrder} disabled={busy} className="mt-2 w-full text-left uppercase text-[#a45e54]">Supprimer le brouillon non payé</button>}
    </div>}
    {error && order && <p className="mt-3 break-words font-mono text-[10px] text-[#e6a69b]" role="alert">{error}</p>}
    {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
    <p className="mt-3 font-mono text-[9px] leading-4 text-[#718092]">La clé privée reste locale et aucun portefeuille UniSat ne signe le paiement. La création/indexation de l’inscription dépend toutefois du service d’inscription configuré. L’envoi de l’inscription au destinataire est une seconde transaction locale avec sa propre revue et signature.</p>
  </section>;
}
