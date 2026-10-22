import { ShieldCheck } from "lucide-react";

type ProtocolTransferCenterProps = {
  network: "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
};

export function ProtocolTransferCenter({ network }: ProtocolTransferCenterProps) {
  const label = network === "BITCOIN_MAINNET" ? "Bitcoin mainnet" : "Fractal Bitcoin mainnet";
  return <section className="mt-4 border border-[#d99a54]/40 bg-[#10151a] p-3 sm:p-4" aria-labelledby="local-protocol-transfer-title">
    <div className="flex items-start gap-2"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#f2bd63]" /><div><p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#f2bd63]">Ordi Wallet local signing · {label}</p><h3 id="local-protocol-transfer-title" className="mt-1 font-display text-lg text-[#f3efe5]">Protocol-specific signing is fail-closed</h3><p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">{network === "BITCOIN_MAINNET" ? "Bitcoin: native payments, Ordinals, classic BRC-20 and Runes have dedicated Local Vault flows. Alkanes and BRC2.0 are available in the UniSat-facing Bitcoin panels, but Local Vault signing remains blocked until dedicated builders and independent protocol-output validation are implemented." : "Fractal Bitcoin: native payments, Ordinals/inscriptions, classic BRC-20 and Runes only. Alkanes and BRC2.0 are disabled for this network."} Classic BRC-20 inscription creation and final send are separate transactions; generic signing never approves unsupported protocol outputs.</p><p className="mt-2 font-mono text-[9px] leading-4 text-[#718092]">Ownership proof (BIP-322) is separate from each transaction signature. Every transaction still requires its own exact review, local signature and explicit broadcast confirmation.</p></div></div>
  </section>;
}
