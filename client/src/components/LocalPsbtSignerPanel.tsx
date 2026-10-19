import { useEffect, useState } from "react";
import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { LocalVaultOwnershipProof } from "@/components/LocalVaultOwnershipProof";
import { broadcastLocalPsbt, finalizeLocalPsbt, reviewLocalPsbt, signLocalPsbt, type LocalPsbtReview } from "@/lib/local-psbt-signer";
import { ADDRESS_SPECS, type AddressType, type OrdiNetwork, type OrdiWalletRecord } from "@/lib/ordi-wallet";

export function LocalPsbtSignerPanel({ wallet, network, site = "pokedex", initialAddressType = "native-segwit" }: { wallet: OrdiWalletRecord; network: OrdiNetwork; site?: "punks" | "pokedex"; initialAddressType?: AddressType }) {
  const [psbt, setPsbt] = useState("");
  const [addressType, setAddressType] = useState<AddressType>(initialAddressType);
  const [ownershipProofKey, setOwnershipProofKey] = useState<string | null>(null);
  const psbtFingerprint = psbt.trim() ? Buffer.from(bitcoin.crypto.sha256(Buffer.from(psbt.trim().toLowerCase(), "utf8"))).toString("hex") : "";
  const ownershipContextKey = psbtFingerprint ? JSON.stringify(["generic-psbt", site, network, addressType, wallet.addresses[addressType].address, psbtFingerprint]) : "";

  const [review, setReview] = useState<LocalPsbtReview | null>(null);
  const [signed, setSigned] = useState("");
  const [tx, setTx] = useState<{ rawTxHex: string; txid: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setAddressType(initialAddressType);
    setReview(null);
    setSigned("");
    setTx(null);
    setConfirmed(false);
    setOwnershipProofKey(null);
    setError("");
    setMessage("");
  }, [initialAddressType, network]);

  const inspect = async () => {
    setError("");
    setMessage("");
    setSigned("");
    setTx(null);
    setConfirmed(false);
    setBusy(true);
    try {
      const nextReview = await reviewLocalPsbt(psbt.trim(), wallet, network);
      if (nextReview.addressType !== addressType || nextReview.sourceAddress !== wallet.addresses[addressType].address) throw new Error("Le PSBT source ne correspond pas au compte Local Vault sélectionné. Choisissez le bon type d’adresse; aucune signature n’a été créée.");
      setReview(nextReview);
    } catch (cause) {
      setReview(null);
      setError(cause instanceof Error ? cause.message : "Invalid PSBT.");
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (!review || !confirmed || !ownershipContextKey || ownershipProofKey !== ownershipContextKey || review.addressType !== addressType) {
      setError("Complétez la preuve BIP-322 pour ce PSBT et ce compte, puis confirmez la revue avant la signature locale.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setSigned(await signLocalPsbt(psbt.trim(), wallet, review));
      setMessage("PSBT signed locally. The transaction has not been broadcast.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Local signing failed.");
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    if (!review || !signed) return;
    setBusy(true);
    setError("");
    try {
      setTx(await finalizeLocalPsbt(signed, wallet, review));
      setMessage("Signature verified locally. Check the transaction ID before broadcast.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid signature.");
    } finally {
      setBusy(false);
    }
  };

  const broadcast = async () => {
    if (!review || !tx) return;
    setBusy(true);
    setError("");
    try {
      await broadcastLocalPsbt(network, tx.rawTxHex, tx.txid, wallet, review);
      setMessage(`Transaction broadcast on ${network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal"}: ${tx.txid}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Broadcast status is uncertain. Check Mempool before retrying.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="mt-4 border border-[#d99a54]/50 bg-[#10151a] p-3 sm:mt-5 sm:p-4" aria-labelledby="local-psbt-title">
    <div className="flex items-center gap-2 text-[#f2bd63]"><ShieldCheck size={16} /><h3 id="local-psbt-title" className="font-mono text-[10px] uppercase tracking-[.14em]">Local PSBT signer</h3></div>
    <p className="mt-2 font-mono text-[10px] leading-5 text-[#9ea7b3]">Standard native BTC/FB only: this signer verifies every exact input against live confirmed, asset-free UTXOs and checks standard address outputs. It refuses Ordinals, BRC-20, Runes, Alkanes and OP_RETURN protocol transactions. Only the public address/outpoints are queried; private keys never leave this device.</p>
    <label className="mt-3 block font-mono text-[9px] uppercase tracking-[.12em] text-[#9ea7b3]" htmlFor="local-psbt-address-type">Source account type</label>
    <select id="local-psbt-address-type" aria-label="Local Vault source address type" value={addressType} onChange={event => { setAddressType(event.target.value as AddressType); setReview(null); setSigned(""); setTx(null); setConfirmed(false); setOwnershipProofKey(null); setError(""); setMessage(""); }} className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-sm text-[#f3efe5]">{ADDRESS_SPECS.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}</select>
    <p className="mt-1 break-all font-mono text-[9px] text-[#718092]">Local source: {wallet.addresses[addressType].address}</p>
    <label className="sr-only" htmlFor="local-psbt-input">PSBT to sign</label>
    <textarea id="local-psbt-input" value={psbt} onChange={event => { setPsbt(event.target.value); setReview(null); setSigned(""); setTx(null); setConfirmed(false); setOwnershipProofKey(null); setError(""); setMessage(""); }} placeholder="Paste a standard BTC/FB PSBT (no protocol assets)…" className="mt-3 min-h-28 w-full border border-[#3b434d] bg-[#0b0f13] p-3 font-mono text-base text-[#f3efe5] placeholder:text-[#718092] sm:text-sm" />
    {ownershipContextKey && <LocalVaultOwnershipProof key={ownershipContextKey} site={site} network={network} wallet={wallet} addressType={addressType} contextKey={ownershipContextKey} onVerified={setOwnershipProofKey} />}
    <button type="button" onClick={inspect} disabled={!psbt.trim() || busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40 sm:w-auto">Review PSBT</button>
    {review && <div className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 font-mono text-[10px] leading-5 text-[#d9d3c6]">
      <p className="flex items-center gap-2 uppercase text-[#9fe0bd]"><CheckCircle2 size={13} /> Review before signing</p>
      <p className="mt-2">Inputs: {review.inputCount} · outputs: {review.outputCount}</p>
      <p>Total inputs: {review.inputSats.toLocaleString("en-US")} sats · outputs: {review.outputSats.toLocaleString("en-US")} sats</p>
      <p>Exact fee: {review.feeSats.toLocaleString("en-US")} sats · estimated {review.feeRateSatVb.toFixed(2)} sat/vB</p>
      <div className="mt-2 space-y-1">{review.outputs.map((output, index) => <p key={`${output.address}:${index}`} className="break-all">Output {index + 1}: {output.valueSats.toLocaleString("en-US")} sats → {output.address}</p>)}</div>
      <label className="mt-3 flex min-h-11 items-start gap-2 py-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /> <span>I confirm these inputs, outputs, fees, and the {network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal mainnet"} network. A local signature will be created.</span></label>
      <button type="button" onClick={sign} disabled={!confirmed || !ownershipContextKey || ownershipProofKey !== ownershipContextKey || busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center bg-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#0b0d10] disabled:opacity-40 sm:w-auto">{busy ? "Signing…" : "Sign locally"}</button>
    </div>}
    {signed && !tx && <div className="mt-3 border border-[#d99a54]/40 p-3"><p className="font-mono text-[10px] text-[#f2bd63]">PSBT signed in memory; not broadcast.</p><button type="button" onClick={finalize} className="mt-2 inline-flex min-h-11 w-full items-center justify-center border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] sm:w-auto">Verify signature and prepare broadcast</button></div>}
    {tx && <div className="mt-3 border border-[#d99a54]/60 p-3 font-mono text-[10px] leading-5"><p className="break-all text-[#f2bd63]">Expected TXID: {tx.txid}</p><p className="mt-1 text-[#9ea7b3]">Broadcasting is an irreversible on-chain action. Verify the TXID and network one last time.</p><button type="button" onClick={() => void broadcast()} disabled={busy} className="mt-2 inline-flex min-h-11 w-full items-center justify-center bg-[#d99a54] px-3 py-2 uppercase text-[#0b0d10] disabled:opacity-40 sm:w-auto">{busy ? "Broadcasting…" : "Broadcast via Mempool"}</button></div>}
    {error && <p className="mt-3 break-words border border-[#a45e54]/50 p-3 font-mono text-[10px] leading-5 text-[#e6a69b]" role="alert">{error}</p>}
    {message && <p className="mt-3 break-words border border-[#70c7a0]/40 p-3 font-mono text-[10px] leading-5 text-[#9fe0bd]" role="status">{message}</p>}
  </section>;
}
