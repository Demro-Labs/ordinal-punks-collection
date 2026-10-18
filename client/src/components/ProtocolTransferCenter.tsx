import { ExternalLink, ShieldCheck } from "lucide-react";

type ProtocolTransferCenterProps = {
  network: "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
};

const protocolCopy = [
  { name: "BRC-20 classic", detail: "TRANSFER inscription puis envoi de l’inscription", action: "Ouvrir UniSat" },
  { name: "BRC20-Prog", detail: "Flux d’inscription et de transfert compatible UniSat", action: "Ouvrir UniSat" },
  { name: "Runes", detail: "Sélection d’un UTXO Rune dans Assets → Transfer", action: "Ouvrir UniSat" },
  { name: "Alkanes", detail: "Sélection d’un UTXO Alkane dans Assets → Transfer", action: "Ouvrir UniSat" },
];

export function ProtocolTransferCenter({ network }: ProtocolTransferCenterProps) {
  const explorer = network === "BITCOIN_MAINNET" ? "https://unisat.io" : "https://fractal.unisat.io";
  const label = network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet";
  return <section className="mt-4 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-3 sm:p-4" aria-labelledby="local-protocol-transfer-title">
    <div className="flex items-start gap-2"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#70c7a0]" /><div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#9fe0bd]">Protocol transfer routing · {label}</p><h3 id="local-protocol-transfer-title" className="mt-1 font-display text-lg text-[#f3efe5]">All protocol paths are configured</h3><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">The local vault keeps keys local. UniSat remains the reviewed transaction builder for protocol-specific transfers; no API key or private key is sent from this panel.</p></div></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{protocolCopy.map(item => <div key={item.name} className="flex items-center justify-between gap-3 border border-[#3b434d] bg-[#0b0f13] p-3"><div className="min-w-0"><p className="font-mono text-[10px] text-[#d9d3c6]">{item.name}</p><p className="mt-1 font-mono text-[9px] leading-4 text-[#718092]">{item.detail}</p></div><a href={explorer} target="_blank" rel="noreferrer" className="inline-flex min-h-10 shrink-0 items-center gap-1 border border-[#d99a54] px-2 font-mono text-[9px] uppercase text-[#f2bd63]">{item.action}<ExternalLink size={11} /></a></div>)}</div>
  </section>;
}
