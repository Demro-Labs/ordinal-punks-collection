import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";

type PreSignatureSecurityPreviewProps = {
  network: string;
  transactionType: string;
  source: string;
  destination: string;
  amount: string;
  inputs: string[];
  outputs: string[];
  fees: string;
  warnings?: string[];
};

export function PreSignatureSecurityPreview({
  network, transactionType, source, destination, amount, inputs, outputs, fees, warnings = [],
}: PreSignatureSecurityPreviewProps) {
  return (
    <section className="mt-3 border border-[#d7b77b]/40 bg-[#0b100f]/90 p-3" aria-label="Aperçu sécurisé avant signature">
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#e4c98f]" />
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[.12em] text-[#e4c98f]">Aperçu sécurisé avant signature</p>
          <p className="mt-1 text-xs text-[#d9d3c6]">{transactionType} · {network}</p>
        </div>
      </div>
      <dl className="mt-3 grid gap-2 text-[10px] leading-5 sm:grid-cols-2">
        <div className="min-w-0 border border-[#27332f] p-2"><dt className="text-[#718092]">Source</dt><dd className="break-all text-[#d9d3c6]">{source}</dd></div>
        <div className="min-w-0 border border-[#27332f] p-2"><dt className="text-[#718092]">Destinataire</dt><dd className="break-all text-[#d9d3c6]">{destination}</dd></div>
        <div className="border border-[#27332f] p-2"><dt className="text-[#718092]">Montant demandé</dt><dd className="text-[#f3efe5]">{amount}</dd></div>
        <div className="border border-[#27332f] p-2"><dt className="text-[#718092]">Frais estimés / calculés</dt><dd className="text-[#f2bd63]">{fees}</dd></div>
      </dl>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 border border-[#27332f] p-2">
          <p className="font-mono text-[9px] uppercase text-[#9fe0bd]">Entrées ({inputs.length})</p>
          <ul className="mt-1 space-y-1 text-[10px] leading-4 text-[#9ea7b3]">{inputs.map((item, index) => <li key={index} className="break-all">{item}</li>)}</ul>
        </div>
        <div className="min-w-0 border border-[#27332f] p-2">
          <p className="font-mono text-[9px] uppercase text-[#9fe0bd]">Sorties prévues ({outputs.length})</p>
          <ul className="mt-1 space-y-1 text-[10px] leading-4 text-[#9ea7b3]">{outputs.map((item, index) => <li key={index} className="break-all">{item}</li>)}</ul>
        </div>
      </div>
      {warnings.length > 0 && <div className="mt-3 border border-[#e0b45f]/40 bg-[#e0b45f]/5 p-2"><p className="flex items-center gap-2 font-mono text-[9px] uppercase text-[#f2bd63]"><AlertTriangle size={12}/> Points à vérifier</p><ul className="mt-1 space-y-1 text-[10px] leading-4 text-[#e0b45f]">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      <p className="mt-3 flex items-start gap-2 border-t border-[#27332f] pt-2 text-[10px] leading-4 text-[#9fe0bd]"><CheckCircle2 size={12} className="mt-0.5 shrink-0"/> Vérifiez chaque champ dans cet aperçu puis dans le récapitulatif final. Cet aperçu ne signe et ne diffuse rien.</p>
    </section>
  );
}
