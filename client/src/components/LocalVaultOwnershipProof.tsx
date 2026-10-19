import { useEffect, useState } from "react";
import { Buffer } from "buffer";
import { Verifier } from "@exodus/bip322-js";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import type { AddressType, OrdiNetwork, OrdiWalletRecord } from "@/lib/ordi-wallet";
import { signLocalOwnershipMessage } from "@/lib/local-vault-ownership";
import { isWalletExtensionContext } from "@/lib/local-vault-bridge";

type SiteName = "punks" | "pokedex";
type OwnershipChallenge = { challengeId: string; message: string; expiresAt: string; contextHash: string };
const API_BASE = (import.meta.env.VITE_LIVE_DATA_URL || "https://fractal-ordinal-live.servostar23.workers.dev/api/live-inscription").replace(/\/api\/live-inscription\/?$/, "");

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : "The local wallet ownership check could not be completed.";
}

export function LocalVaultOwnershipProof({
  site, network, wallet, addressType, contextKey, onVerified,
}: {
  site: SiteName;
  network: OrdiNetwork;
  wallet: OrdiWalletRecord;
  addressType: AddressType;
  contextKey: string;
  onVerified: (contextKey: string | null) => void;
}) {
  const [challenge, setChallenge] = useState<OwnershipChallenge | null>(null);
  const [verifiedContext, setVerifiedContext] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const account = wallet.addresses[addressType];
  const address = account?.address ?? "";
  const activeChallenge = challenge;
  const verified = Boolean(contextKey) && verifiedContext === contextKey;

  useEffect(() => {
    setChallenge(null);
    setVerifiedContext("");
    setError("");
    onVerified(null);
  }, [site, network, address, addressType, contextKey, onVerified]);

  useEffect(() => {
    if (!verified) return;
    const timer = window.setTimeout(() => {
      setVerifiedContext("");
      setChallenge(null);
      setError("The ownership proof expired. Complete it again before preparing the transaction.");
      onVerified(null);
    }, 2 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [verified, onVerified]);

  const prepare = async () => {
    setError("");
    if (!contextKey || !address || !account?.privateKey || !account.publicKey) {
      setError("Unlock the local vault and select a source account before preparing the proof.");
      return;
    }
    setWorking(true);
    try {
      const contextHash = await sha256Hex(contextKey);
      if (isWalletExtensionContext()) {
        const issuedAt = Date.now();
        const expiresAt = issuedAt + 2 * 60 * 1000;
        const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
        const challengeId = Array.from(nonceBytes, byte => byte.toString(16).padStart(2, "0")).join("");
        const uri = site === "punks"
          ? "https://demro-labs.github.io/ordinal-punks-collection/"
          : "https://demro-labs.github.io/fractal-pokedex-ordinal-ledger/";
        const message = [
          "Local Ordi Wallet requests a wallet ownership proof",
          `URI: ${uri}`,
          `Network: ${network}`,
          `Address: ${address}`,
          "Action: Prove control of this local wallet before a transaction",
          `Transaction Context SHA-256: ${contextHash}`,
          `Nonce: ${challengeId}`,
          `Issued At: ${new Date(issuedAt).toISOString()}`,
          `Expiration Time: ${new Date(expiresAt).toISOString()}`,
          "This local signature only proves wallet ownership. It does not authorize a payment or transfer; a separate transaction review and signature is required.",
        ].join("\n");
        setChallenge({ challengeId, message, expiresAt: new Date(expiresAt).toISOString(), contextHash });
        return;
      }
      const response = await fetch(`${API_BASE}/api/auth/ownership/challenge`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", cache: "no-store",
        body: JSON.stringify({ site, address, network, contextHash }),
      });
      const data = await response.json().catch(() => null) as Partial<OwnershipChallenge> & { error?: string } | null;
      if (!response.ok || typeof data?.challengeId !== "string" || typeof data.message !== "string" || typeof data.expiresAt !== "string" || data.contextHash !== contextHash) {
        throw new Error(data?.error || "The Worker could not prepare the BIP-322 challenge.");
      }
      setChallenge({ challengeId: data.challengeId, message: data.message, expiresAt: data.expiresAt, contextHash });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setWorking(false);
    }
  };

  const signAndVerify = async () => {
    if (!activeChallenge || !account?.privateKey || !contextKey) return;
    if (Date.parse(activeChallenge.expiresAt) <= Date.now()) {
      setChallenge(null);
      setError("The challenge expired. Prepare a new one before signing.");
      return;
    }
    setWorking(true);
    setError("");
    try {
      // BIP-322 signs only the one-time ownership message. The key never leaves this page.
      const signature = await signLocalOwnershipMessage(account, activeChallenge.message);
      if (isWalletExtensionContext()) {
        const witness = Buffer.from(signature, "base64");
        if (!await Verifier.verifySignature(address, activeChallenge.message, witness)) throw new Error("The local BIP-322 ownership signature was rejected.");
      } else {
        const response = await fetch(`${API_BASE}/api/auth/ownership/verify`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", cache: "no-store",
          body: JSON.stringify({ site, address, network, challengeId: activeChallenge.challengeId, contextHash: activeChallenge.contextHash, signature }),
        });
        const data = await response.json().catch(() => null) as { verified?: boolean; error?: string } | null;
        if (!response.ok || data?.verified !== true || data.contextHash !== activeChallenge.contextHash) throw new Error(data?.error || "The Worker did not validate this transaction-bound ownership proof.");
      }
      setVerifiedContext(contextKey);
      onVerified(contextKey);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setWorking(false);
    }
  };

  return <section className="mt-3 border border-[#d99a54]/60 bg-[#151a1f] p-3 font-mono text-[10px] leading-5" aria-label="Local Ordi Wallet ownership check">
    <p className="flex items-center gap-2 uppercase tracking-[0.1em] text-[#f2bd63]"><ShieldCheck size={13} /> Ownership signature required · Local Ordi Wallet · BIP-322</p>
    <p className="mt-1 text-[#9ea7b3]">Proves control of {address ? `${address.slice(0, 10)}…${address.slice(-6)}` : "the selected local account"} on {network === "BITCOIN_MAINNET" ? "Bitcoin" : "Fractal Bitcoin"}. The signed challenge does not authorize a payment or transfer; the transaction still requires its own separate review and local signature.</p>
    {verified ? <p className="mt-2 flex items-center gap-2 text-[#70c7a0]" role="status"><CheckCircle2 size={13} /> Ownership verified for this current operation.</p> : <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" onClick={() => void prepare()} disabled={working || !contextKey || !account?.privateKey} className="min-h-10 border border-[#3b434d] px-3 py-2 uppercase tracking-[0.06em] text-[#d9d3c6] disabled:opacity-40">{working && !activeChallenge ? <><Loader2 size={12} className="mr-1 inline animate-spin" /> Preparing…</> : "1 · Prepare ownership proof"}</button>
      {activeChallenge && <button type="button" onClick={() => void signAndVerify()} disabled={working || !account?.privateKey} className="min-h-10 border border-[#d99a54] bg-[#d99a54] px-3 py-2 uppercase tracking-[0.06em] text-[#0b0d10] disabled:opacity-40">{working ? <><Loader2 size={12} className="mr-1 inline animate-spin" /> Verifying…</> : "2 · Sign locally"}</button>}
    </div>}
    {activeChallenge && !verified && <>
      <p className="mt-2 whitespace-pre-wrap break-words border-l border-[#59616b] pl-2 text-[#c1c8d0]" aria-label="Exact Ownership message to be signed">{activeChallenge.message}</p>
      <p className="mt-2 text-[#718092]">One-time challenge expires {new Date(activeChallenge.expiresAt).toLocaleTimeString()} · private key remains in the local vault.</p>
    </>}
    {error && <p className="mt-2 text-[#e08b7d]" role="alert">{error}</p>}
  </section>;
}
