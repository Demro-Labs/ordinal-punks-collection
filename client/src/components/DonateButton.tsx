import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Heart, RefreshCw, X } from "lucide-react";

const DONATION_ADDRESS = "13bsQSSXzXMJoXbMhZ6fqBYVkkHx4y8cs1";
const QR_IMAGE = "https://api.qrserver.com/v1/create-qr-code/";
const PRESETS = [5, 10, 25] as const;

function qrUrl(value: string) {
  return `${QR_IMAGE}?size=220x220&margin=12&data=${encodeURIComponent(value)}`;
}

function formatBtc(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 });
}

export function DonateButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [priceUsd, setPriceUsd] = useState<number | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceError, setPriceError] = useState("");
  const [presetUsd, setPresetUsd] = useState<number | null>(10);
  const [customUsd, setCustomUsd] = useState("");
  const [copied, setCopied] = useState(false);

  const usdAmount = presetUsd ?? Number(customUsd);
  const validAmount = Number.isFinite(usdAmount) && usdAmount > 0 && usdAmount <= 100000;
  const btcAmount = useMemo(() => priceUsd && validAmount ? usdAmount / priceUsd : null, [priceUsd, usdAmount, validAmount]);
  const paymentUri = useMemo(() => {
    if (!btcAmount || !Number.isFinite(btcAmount)) return `bitcoin:${DONATION_ADDRESS}`;
    const btc = (Math.round(btcAmount * 1e8) / 1e8).toFixed(8);
    return `bitcoin:${DONATION_ADDRESS}?amount=${btc}`;
  }, [btcAmount]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadPrice = async () => {
      setPriceLoading(true);
      setPriceError("");
      try {
        const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { bitcoin?: { usd?: number } };
        const price = data.bitcoin?.usd;
        if (!Number.isFinite(price) || !price || price <= 0) throw new Error("Prix BTC indisponible");
        if (!cancelled) setPriceUsd(price);
      } catch {
        if (!cancelled) {
          setPriceUsd(null);
          setPriceError("Cours BTC live indisponible. Le QR reste utilisable sans montant prédéfini.");
        }
      } finally {
        if (!cancelled) setPriceLoading(false);
      }
    };
    void loadPrice();
    const timer = window.setInterval(() => void loadPrice(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(DONATION_ADDRESS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return <>
    <button type="button" onClick={() => setOpen(true)} className={`inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54]/60 bg-[#d99a54]/10 px-3 py-3 font-mono text-[10px] uppercase tracking-[.14em] text-[#f2bd63] transition hover:border-[#d99a54] hover:bg-[#d99a54]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d99a54] ${compact ? "w-auto lg:hidden" : "hidden w-full lg:inline-flex"}`}>
      <Heart size={15} /> Donate
    </button>
    {open && createPortal(
      <div className="fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto bg-[#050608]/90 p-4 backdrop-blur-sm" onMouseDown={event => event.target === event.currentTarget && setOpen(false)}>
        <section role="dialog" aria-modal="true" aria-labelledby="donate-title" className="my-auto w-full max-w-xl border border-[#3b434d] bg-[#0e1217] text-[#f3efe5] shadow-[0_24px_100px_rgba(0,0,0,.65)]">
          <header className="flex items-center justify-between border-b border-[#2c323a] px-5 py-4">
            <div><p className="font-mono text-[9px] uppercase tracking-[.18em] text-[#d99a54]">Support the project</p><h2 id="donate-title" className="mt-1 font-display text-2xl">Donate with Bitcoin</h2></div>
            <button type="button" onClick={() => setOpen(false)} className="flex min-h-11 min-w-11 items-center justify-center text-[#9ea7b3] hover:text-[#f3efe5]" aria-label="Close donation window"><X size={18} /></button>
          </header>
          <div className="grid gap-5 p-5 sm:grid-cols-[220px_minmax(0,1fr)]">
            <div className="flex flex-col items-center gap-3">
              <div className="border border-[#2c323a] bg-white p-2"><img src={qrUrl(paymentUri)} alt="Bitcoin donation QR code" width="204" height="204" className="block h-[204px] w-[204px]" /></div>
              <p className="text-center font-mono text-[9px] leading-4 text-[#718092]">Scan with a Bitcoin wallet. Check the address and amount in your wallet before confirming.</p>
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Donation amount (USD)</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {PRESETS.map(amount => <button key={amount} type="button" onClick={() => { setPresetUsd(amount); setCustomUsd(""); }} aria-pressed={presetUsd === amount} className={`min-h-11 border px-2 font-mono text-xs transition ${presetUsd === amount ? "border-[#d99a54] bg-[#d99a54]/15 text-[#f2bd63]" : "border-[#3b434d] text-[#9ea7b3] hover:border-[#d99a54]/60"}`}>${amount}</button>)}
              </div>
              <label htmlFor="donation-custom-usd" className="mt-4 block font-mono text-[9px] uppercase tracking-[.14em] text-[#718092]">Custom amount (USD)</label>
              <div className="mt-2 flex items-center border border-[#3b434d] bg-[#0b0f13] px-3">
                <span className="font-mono text-sm text-[#718092]">$</span>
                <input id="donation-custom-usd" type="number" inputMode="decimal" min="0.01" max="100000" step="0.01" value={customUsd} onChange={event => { setCustomUsd(event.target.value); setPresetUsd(null); }} placeholder="Enter any amount" className="min-h-11 w-full bg-transparent px-2 font-mono text-sm text-[#f3efe5] outline-none placeholder:text-[#596575]" />
              </div>
              {priceLoading && <p className="mt-3 flex items-center gap-2 font-mono text-[9px] text-[#9ea7b3]"><RefreshCw size={12} className="animate-spin" /> Fetching live BTC/USD price…</p>}
              {priceUsd && <div className="mt-3 border border-[#2c323a] bg-[#12171d] p-3"><p className="font-mono text-[9px] text-[#718092]">Live BTC/USD · CoinGecko</p><p className="mt-1 font-mono text-sm text-[#d9d3c6]">${priceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</p><p className="mt-2 font-mono text-[9px] text-[#718092]">Estimated donation</p><p className="mt-1 break-all font-mono text-sm text-[#9fe0bd]">{validAmount && btcAmount ? `${formatBtc(Math.round(btcAmount * 1e8) / 1e8)} BTC` : "Enter an amount above 0 USD"}</p></div>}
              {priceError && <p role="status" className="mt-3 border border-[#a45e54]/40 bg-[#a45e54]/10 p-2 font-mono text-[9px] leading-4 text-[#e6a69b]">{priceError}</p>}
              <p className="mt-4 break-all font-mono text-[10px] leading-5 text-[#d9d3c6]">{DONATION_ADDRESS}</p>
              <button type="button" onClick={() => void copyAddress()} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63] hover:border-[#d99a54]"><Copy size={13} /> {copied ? "Address copied" : "Copy Bitcoin address"}</button>
              <a href={paymentUri} className="mt-2 flex min-h-11 items-center justify-center border border-[#d99a54]/60 bg-[#d99a54]/10 px-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63] hover:bg-[#d99a54]/20">Open Bitcoin wallet</a>
              <p className="mt-3 font-mono text-[9px] leading-4 text-[#718092]">BTC amounts are estimates from the latest available price, not a payment confirmation. The donation is never sent automatically.</p>
            </div>
          </div>
        </section>
      </div>,
      document.body
    )}
  </>;
}
