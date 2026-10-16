import { useMemo, useState } from "react";
import { Check, Clipboard, Download, FileCode2 } from "lucide-react";

const HEX_DATA = /^0x(?:[0-9a-f]{2})+$/i;
const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/i;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

type Mode = "deploy" | "call";

export function Brc20ProgModulePanel({ network }: { network: "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET" }) {
  const [mode, setMode] = useState<Mode>("deploy");
  const [bytecode, setBytecode] = useState("");
  const [contract, setContract] = useState("");
  const [inscriptionId, setInscriptionId] = useState("");
  const [calldata, setCalldata] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");

  const contractTargetValid = Boolean(contract.trim()) !== Boolean(inscriptionId.trim())
    && (!contract.trim() || EVM_ADDRESS.test(contract.trim()))
    && (!inscriptionId.trim() || INSCRIPTION_ID.test(inscriptionId.trim()));
  const data = mode === "deploy" ? bytecode.trim() : calldata.trim();
  const valid = network === "BITCOIN_MAINNET" && HEX_DATA.test(data)
    && (mode === "deploy" || contractTargetValid);
  const payload = useMemo(() => {
    if (!valid) return "";
    return JSON.stringify(mode === "deploy"
      ? { p: "brc20-prog", op: "d", d: data }
      : { p: "brc20-prog", op: "c", ...(contract.trim() ? { c: contract.trim() } : { i: inscriptionId.trim() }), d: data }, null, 2);
  }, [valid, mode, data, contract, inscriptionId]);

  const copyPayload = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setMessage("JSON copié. Aucun ordre d’inscription ni transaction n’a été créé.");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage("Copie impossible dans ce navigateur. Téléchargez plutôt le JSON.");
    }
  };

  const downloadPayload = () => {
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `brc20-prog-${mode}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("JSON téléchargé. Aucun ordre d’inscription ni transaction n’a été créé.");
  };

  return (
    <section className="border border-[#3b434d] bg-[#10151a] p-3" aria-labelledby="brc20-prog-module-title">
      <div className="flex items-start gap-2">
        <FileCode2 size={15} className="mt-0.5 shrink-0 text-[#f2bd63]" />
        <div>
          <h3 id="brc20-prog-module-title" className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#f2bd63]">Module programmable BRC2.0</h3>
          <p className="mt-1 font-mono text-[9px] leading-5 text-[#9ea7b3]">Préparateur distinct de BRC20‑Prog (tickers 6 caractères) et des transferts BRC‑20 classiques.</p>
        </div>
      </div>
      <p className="mt-2 border border-[#d99a54]/40 bg-[#151a1f] p-2 font-mono text-[9px] leading-5 text-[#d9d3c6]">
        {network === "BITCOIN_MAINNET"
          ? "BRC2.0 s’exécute sur Bitcoin mainnet. Ce formulaire ne signe et ne diffuse rien : il prépare uniquement le JSON deploy/call. L’exécution exige un indexeur BRC2.0 et une transaction d’activation vers OP_RETURN « BRC20PROG » après l’inscription."
          : "Le module programmable BRC2.0 est présenté ici comme Bitcoin-only. Passez UniSat sur Bitcoin mainnet pour préparer une inscription ; aucune donnée Fractal n’est envoyée à cet indexeur."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Type d’inscription BRC2.0">
        {(["deploy", "call"] as const).map(option => (
          <button key={option} type="button" onClick={() => { setMode(option); setMessage(""); }} aria-pressed={mode === option} className={`min-h-10 border px-3 py-2 font-mono text-[9px] uppercase ${mode === option ? "border-[#d99a54] bg-[#d99a54] text-[#0b0d10]" : "border-[#3b434d] text-[#9ea7b3]"}`}>
            {option === "deploy" ? "Déployer contrat" : "Appeler contrat"}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-2">
        {mode === "call" && <>
          <label className="font-mono text-[9px] text-[#9ea7b3]">Adresse EVM du contrat (0x…)
            <input value={contract} onChange={event => { setContract(event.target.value); if (event.target.value) setInscriptionId(""); }} placeholder="0x + 40 caractères hex" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]" />
          </label>
          <label className="font-mono text-[9px] text-[#9ea7b3]">ou inscription de déploiement (ID)
            <input value={inscriptionId} onChange={event => { setInscriptionId(event.target.value); if (event.target.value) setContract(""); }} placeholder="64 caractères hex + i + numéro" className="mt-1 min-h-11 w-full border border-[#3b434d] bg-[#0b0d10] px-3 font-mono text-[10px] text-[#d9d3c6]" />
          </label>
        </>}
        <label className="font-mono text-[9px] text-[#9ea7b3]">{mode === "deploy" ? "Bytecode + arguments du constructeur (hex)" : "Calldata ABI encodée (hex)"}
          <textarea value={data} onChange={event => mode === "deploy" ? setBytecode(event.target.value) : setCalldata(event.target.value)} rows={4} spellCheck={false} placeholder="0x… (octets hexadécimaux complets)" className="mt-1 w-full resize-y border border-[#3b434d] bg-[#0b0d10] p-3 font-mono text-[10px] text-[#d9d3c6]" />
        </label>
      </div>
      {mode === "call" && !contractTargetValid && <p className="mt-2 font-mono text-[9px] text-[#e08b7d]">Indiquez exactement une adresse EVM valide ou un ID d’inscription de déploiement.</p>}
      {data && !HEX_DATA.test(data) && <p className="mt-2 font-mono text-[9px] text-[#e08b7d]">La donnée doit commencer par 0x et contenir des octets hexadécimaux complets.</p>}
      {payload && <pre className="mt-3 max-h-40 overflow-auto border border-[#3b434d] bg-[#0b0d10] p-3 font-mono text-[9px] leading-4 text-[#70c7a0]">{payload}</pre>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => void copyPayload()} disabled={!valid} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] disabled:opacity-40">{copied ? <Check size={13} /> : <Clipboard size={13} />} Copier le JSON</button>
        <button type="button" onClick={downloadPayload} disabled={!valid} className="inline-flex min-h-11 items-center justify-center gap-2 border border-[#d99a54] px-3 py-2 font-mono text-[9px] uppercase text-[#f2bd63] disabled:opacity-40"><Download size={13} /> Télécharger le JSON</button>
      </div>
      {message && <p className="mt-2 font-mono text-[9px] text-[#9ea7b3]" role="status">{message}</p>}
      <p className="mt-3 font-mono text-[9px] leading-5 text-[#718092]">Aucune clé privée n’est demandée ici. Ne considérez pas le JSON comme exécuté : l’inscription, sa transaction d’activation et son reçu doivent être vérifiés séparément dans UniSat et sur un indexeur BRC2.0 de confiance.</p>
    </section>
  );
}
