import { useEffect, useMemo, useState } from "react";
import { Heart, RefreshCw, X, Copy, Check } from "lucide-react";

const DONATION_ADDRESS = "13bsQSSXzXMJoXbMhZ6fqBYVkkHx4y8cs1";
const AMOUNTS_USD = [5, 10, 25] as const;
type UsdAmount = typeof AMOUNTS_USD[number];

export function DonateDialog() {
  const [open, setOpen] = useState(false);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [amountUsd, setAmountUsd] = useState<UsdAmount>(5);
  const [copied, setCopied] = useState(false);

  async function refreshPrice(signal?: AbortSignal) {
    try {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
        cache: "no-store", signal, headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { bitcoin?: { usd?: unknown } };
      const price = payload.bitcoin?.usd;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("Invalid BTC/USD price");
      setBtcPrice(price);
      setUpdatedAt(new Date().toISOString());
      setError("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError("Live BTC/USD price is temporarily unavailable. Donation amounts are not estimated.");
    }
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void refreshPrice(controller.signal);
    const timer = window.setInterval(() => void refreshPrice(), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const amountSats = useMemo(() => btcPrice ? Math.round(amountUsd / btcPrice * 100_000_000) : null, [amountUsd, btcPrice]);
  const uri = amountSats === null ? "" : `bitcoin:${DONATION_ADDRESS}?amount=${(amountSats / 100_000_000).toFixed(8)}`;
  const qrUrl = uri ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(uri)}` : "";

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(DONATION_ADDRESS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy failed. Select and copy the address manually.");
    }
  }

  return <>
    <button type="button" onClick={() => setOpen(true)} className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#d99a54]/70 bg-[#d99a54]/10 px-3 font-mono text-[10px] uppercase tracking-[.16em] text-[#f2bd63] transition hover:bg-[#d99a54]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d99a54]">
      <Heart size={14} /> Donate with Bitcoin
    </button>
    {open && <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[#050709]/85 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="donate-dialog-title" className="relative max-h-[min(760px,calc(100vh-2rem))] w-full max-w-md overflow-auto border border-[#3b434d] bg-[#11161c] p-5 shadow-[0_24px_80px_rgba(0,0,0,.65)] sm:p-7">
        <button type="button" onClick={() => setOpen(false)} className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center text-[#9ea7b3] hover:bg-[#202831] hover:text-[#f3efe5]" aria-label="Close donation dialog"><X size={18} /></button>
        <p className="font-mono text-[10px] uppercase tracking-[.2em] text-[#d99a54]">Support the project</p>
        <h2 id="donate-dialog-title" className="mt-2 pr-8 font-display text-2xl text-[#f3efe5]">Donate Bitcoin</h2>
        <p className="mt-2 text-sm leading-6 text-[#9ea7b3]">Choose a USD amount. The equivalent BTC amount is calculated from the live BTC/USD price.</p>
        <div className="mt-5 grid grid-cols-3 gap-2">
          {AMOUNTS_USD.map(amount => <button key={amount} type="button" onClick={() => setAmountUsd(amount)} className={`min-h-12 border px-2 font-mono text-sm transition ${amountUsd === amount ? "border-[#d99a54] bg-[#d99a54] text-[#0b0d10]" : "border-[#3b434d] text-[#d9d3c6] hover:border-[#d99a54]"}`}>${amount}</button>)}
        </div>
        <div className="mt-4 border border-[#2c323a] bg-[#0b0f13] p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[.12em] text-[#718092]">Live BTC price</span>
            <button type="button" onClick={() => void refreshPrice()} className="inline-flex min-h-8 items-center gap-1 font-mono text-[9px] uppercase text-[#f2bd63]" aria-label="Refresh BTC price"><RefreshCw size={12} /> Refresh</button>
          </div>
          <p className="mt-1 font-mono text-sm text-[#f3efe5]">{btcPrice ? `$${btcPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} / BTC` : "Loading live price…"}</p>
          {updatedAt && <p className="mt-1 font-mono text-[9px] text-[#718092]">Updated {new Date(updatedAt).toLocaleTimeString()}</p>}
          {amountSats !== null && <p className="mt-3 text-sm text-[#9fe0bd]">${amountUsd} ≈ {(amountSats / 100_000_000).toFixed(8)} BTC <span className="text-[#718092]">({amountSats.toLocaleString("en-US")} sats)</span></p>}
          {error && <p role="alert" className="mt-2 text-xs leading-5 text-[#e6a69b]">{error}</p>}
        </div>
        {qrUrl ? <div className="mt-5 flex flex-col items-center border border-[#2c323a] bg-white p-4">
          <img src={qrUrl} alt={`Bitcoin donation QR code for ${amountUsd}`} width="240" height="240" className="h-60 w-60 max-w-full" />
          <p className="mt-3 break-all text-center font-mono text-[10px] text-[#11161c]">${amountUsd} · {(amountSats! / 100_000_000).toFixed(8)} BTC</p>
        </div> : <div className="mt-5 flex min-h-24 items-center justify-center border border-[#2c323a] p-4 text-center text-xs text-[#9ea7b3]">QR and payment amount appear when live BTC/USD data is available.</div>}
        <div className="mt-4">
          <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#718092]">Bitcoin mainnet address</p>
          <p className="mt-2 break-all font-mono text-xs leading-5 text-[#d9d3c6]">{DONATION_ADDRESS}</p>
          <button type="button" onClick={() => void copyAddress()} className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 border border-[#3b434d] px-3 font-mono text-[10px] uppercase tracking-[.12em] text-[#f3efe5] hover:border-[#d99a54]">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Address copied" : "Copy address"}</button>
        </div>
        <p className="mt-4 text-[10px] leading-5 text-[#718092]">Only send Bitcoin (BTC) on Bitcoin mainnet to this address. Do not send FB, Ordinals, or tokens. QR image is generated by a public QR service; it contains only the public payment URI.</p>
      </section>
    </div>}
  </>;
}
