import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { signMobileUniSatMessage, UniSatSignTimeoutError } from "@/lib/unisat-mobile-signing";

const API_BASE = "https://fractal-ordinal-live.servostar23.workers.dev";
type SiteName = "punks" | "pokedex";
type WalletChain = { enum?: string };
type OwnershipProvider = {
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<WalletChain>;
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
};
type OwnershipChallenge = { challengeId: string; message: string; expiresAt: string; network: string; site: string; action: string; contextKey: string };

function describeOwnershipError(cause: unknown) {
  if (cause instanceof UniSatSignTimeoutError) return "UniSat did not répondu dans les 30 secondes. Verify qu’aucune demande n’est encore ouverte avant de réessayer.";
  if (cause instanceof Error) return cause.message;
  return "The BIP-322 proof could not be validated.";
}

export function UniSatOwnershipProof({
  site,
  address,
  network,
  provider,
  contextKey,
  onVerified,
}: {
  site: SiteName;
  address: string;
  network: string;
  provider?: OwnershipProvider;
  contextKey: string;
  onVerified: (contextKey: string | null) => void;
}) {
  const [challenge, setChallenge] = useState<OwnershipChallenge | null>(null);
  const [verifiedContext, setVerifiedContext] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const mobile = isMobileUniSatDevice();
  const activeChallenge = challenge?.contextKey === contextKey ? challenge : null;
  const verified = Boolean(contextKey) && verifiedContext === contextKey;

  useEffect(() => {
    setChallenge(null);
    setVerifiedContext("");
    setError("");
    onVerified(null);
  }, [site, address, network, contextKey, onVerified]);

  useEffect(() => {
    if (!verified) return;
    const timer = window.setTimeout(() => {
      setVerifiedContext("");
      setChallenge(null);
      setError("The ownership proof expired in the interface. Sign a new proof before the transaction.");
      onVerified(null);
    }, 2 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [verified, onVerified]);

  if (!mobile) return null;

  const assertWalletMatches = async () => {
    if (!address || !network || !provider?.getAccounts || !provider.getChain) {
      throw new Error("UniSat doit exposer le compte et le réseau actifs pour vérifier la propriété.");
    }
    const [accounts, chain] = await Promise.all([provider.getAccounts(), provider.getChain()]);
    if (!accounts.includes(address) || chain.enum !== network) {
      throw new Error("The UniSat account or network changed. Reconnect the correct wallet and restart the proof.");
    }
  };

  const requestChallenge = async () => {
    setError("");
    if (!contextKey || !address || !["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"].includes(network)) {
      setError("Select an address and the Bitcoin or Fractal mainnet network before the proof.");
      return;
    }
    setWorking(true);
    try {
      await assertWalletMatches();
      const response = await fetch(`${API_BASE}/api/auth/ownership/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ site, address, network }),
      });
      const data = await response.json().catch(() => null) as Partial<OwnershipChallenge> & { error?: string } | null;
      if (!response.ok || typeof data?.challengeId !== "string" || typeof data.message !== "string" || typeof data.expiresAt !== "string") {
        throw new Error(data?.error || "The Worker could not prepare the BIP-322 challenge.");
      }
      setChallenge({ challengeId: data.challengeId, message: data.message, expiresAt: data.expiresAt, network, site, action: data.action ?? "ownership-proof-only", contextKey });
    } catch (cause) {
      setError(describeOwnershipError(cause));
    } finally {
      setWorking(false);
    }
  };

  const signOwnership = () => {
    setError("");
    if (!activeChallenge || !provider?.signMessage) {
      setError("Le challenge ou la signature BIP-322 UniSat n’est pas disponible. Demandez un nouveau challenge.");
      return;
    }
    if (Date.parse(activeChallenge.expiresAt) <= Date.now()) {
      setChallenge(null);
      setError("The challenge expired. Prepare a new one before signing.");
      return;
    }

    setWorking(true);
    let signaturePromise: Promise<string>;
    try {
      // Start the UniSat BIP-322 prompt synchronously in this button's tap call stack.
      signaturePromise = signMobileUniSatMessage(provider, activeChallenge.message);
    } catch (cause) {
      setWorking(false);
      setError(describeOwnershipError(cause));
      return;
    }

    void signaturePromise
      .then(async signature => {
        await assertWalletMatches();
        const response = await fetch(`${API_BASE}/api/auth/ownership/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify({ site, address, network, challengeId: activeChallenge.challengeId, signature }),
        });
        const data = await response.json().catch(() => null) as { verified?: boolean; error?: string } | null;
        if (!response.ok || data?.verified !== true) throw new Error(data?.error || "The Worker did not validate this ownership proof.");
        setVerifiedContext(contextKey);
        onVerified(contextKey);
      })
      .catch(cause => setError(describeOwnershipError(cause)))
      .finally(() => setWorking(false));
  };

  return <section className="mt-3 border border-[#d99a54]/60 bg-[#151a1f] p-3 font-mono text-[10px] leading-5" aria-label="Preuve mobile BIP-322 de propriété du wallet">
    <p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><ShieldCheck size={13} /> Ownership signature required · BIP-322</p>
    <p className="mt-1 text-[#9ea7b3]">This signature only proves control of the wallet {address ? `${address.slice(0, 10)}…${address.slice(-6)}` : "connected"} sur {network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}. It does not pay anything or sign the transaction.</p>
    {verified ? <p className="mt-2 flex items-center gap-2 text-[#70c7a0]" role="status"><CheckCircle2 size={13} /> Ownership verified. UniSat transaction approval remains a separate step.</p> : <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" onClick={() => void requestChallenge()} disabled={working || !contextKey || !address || !provider?.getAccounts || !provider.getChain} className="min-h-10 border border-[#3b434d] px-3 py-2 uppercase tracking-[0.06em] text-[#d9d3c6] disabled:opacity-40">{working && !activeChallenge ? <><Loader2 size={12} className="mr-1 inline animate-spin" /> Preparing…</> : "1 · Prepare proof"}</button>
      {activeChallenge && <button type="button" onClick={signOwnership} disabled={working || !provider?.signMessage} className="min-h-10 border border-[#d99a54] bg-[#d99a54] px-3 py-2 uppercase tracking-[0.06em] text-[#0b0d10] disabled:opacity-40">{working ? <><Loader2 size={12} className="mr-1 inline animate-spin" /> Verifying…</> : "2 · Sign ownership"}</button>}
    </div>}
    {activeChallenge && !verified && <p className="mt-2 text-[#718092]">Challenge valid until {new Date(activeChallenge.expiresAt).toLocaleTimeString("en-US")} · no payment ou transfert n’est autorisé par ce message.</p>}
    {error && <p className="mt-2 text-[#e08b7d]" role="alert">{error}</p>}
  </section>;
}
