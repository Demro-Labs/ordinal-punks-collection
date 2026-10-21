import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Heart, X } from "lucide-react";
import { LocalQrCode } from "@/components/LocalQrCode";

const DONATION_ADDRESS = "13bsQSSXzXMJoXbMhZ6fqBYVkkHx4y8cs1";
export function DonateButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const paymentUri = `bitcoin:${DONATION_ADDRESS}`;

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
              <div className="border border-[#2c323a] bg-white p-2"><LocalQrCode value={paymentUri} alt="Bitcoin donation QR code" size={204} /></div>
              <p className="text-center font-mono text-[9px] leading-4 text-[#718092]">Scan with a Bitcoin wallet. Check the address and amount in your wallet before confirming.</p>
            </div>
            <div className="min-w-0">
              <p className="mt-4 break-all font-mono text-[10px] leading-5 text-[#d9d3c6]">{DONATION_ADDRESS}</p>
              <button type="button" onClick={() => void copyAddress()} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 border border-[#3b434d] px-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#f2bd63] hover:border-[#d99a54]"><Copy size={13} /> {copied ? "Address copied" : "Copy Bitcoin address"}</button>
              <p className="mt-3 font-mono text-[9px] leading-4 text-[#718092]">Scan the QR code or copy the address into your Bitcoin wallet. Verify the address before sending.</p>
            </div>
          </div>
        </section>
      </div>,
      document.body
    )}
  </>;
}
