import { useEffect, useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import { isMobileUniSatDevice } from "@/lib/mobile-context";
import { signMobileUniSatMessage, UniSatSignTimeoutError } from "@/lib/unisat-mobile-signing";

const AUTH_API = "https://fractal-ordinal-live.servostar23.workers.dev";
const LOGIN_NETWORKS = new Set(["BITCOIN_MAINNET", "FRACTAL_BITCOIN_MAINNET"]);

type UniSatAuthProvider = {
  getAccounts?: () => Promise<string[]>;
  getChain?: () => Promise<{ enum?: string }>;
  signMessage?: (message: string, type: "bip322-simple") => Promise<string>;
};

type AuthSite = "punks" | "pokedex";
type AuthChallenge = { challengeId: string; message: string; expiresAt: string; network: string };
type AuthSession = { site: string; address: string; network: string; createdAt: string; expiresAt: string };

export function UniSatWalletAuth({ site, address, network, provider }: {
  site: AuthSite;
  address: string;
  network: string;
  provider?: UniSatAuthProvider;
}) {
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"loading" | "anonymous" | "authenticated" | "unavailable">("loading");
  const [error, setError] = useState("");
  const [mobileSignTimedOut, setMobileSignTimedOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setStatus("loading");
    setSession(null);
    setChallenge(null);
    setError("");
    void fetch(`${AUTH_API}/api/auth/session?site=${site}`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    }).then(async response => {
      const data = await response.json() as { session?: AuthSession | null };
      if (!response.ok) throw new Error("The secure sign-in service is unavailable.");
      if (!active) return;
      setSession(data.session ?? null);
      setStatus(data.session ? "authenticated" : "anonymous");
    }).catch(() => {
      if (active && !controller.signal.aborted) setStatus("unavailable");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [site, address, network]);

  useEffect(() => {
    if (!challenge) return;
    const remaining = Date.parse(challenge.expiresAt) - Date.now();
    if (remaining <= 0) {
      setChallenge(null);
      return;
    }
    const timer = window.setTimeout(() => setChallenge(null), remaining);
    return () => window.clearTimeout(timer);
  }, [challenge]);

  const sessionMatchesWallet = Boolean(
    session && session.address.toLowerCase() === address.toLowerCase() && session.network === network,
  );
  const networkReady = LOGIN_NETWORKS.has(network);

  const requestChallenge = async () => {
    setBusy(true);
    setError("");
    setChallenge(null);
    setMobileSignTimedOut(false);
    try {
      if (!networkReady) throw new Error("Select Bitcoin mainnet or Fractal Bitcoin mainnet in UniSat first.");
      if (!provider) throw new Error("UniSat is not available in this browser.");
      const [accounts, currentChain] = await Promise.all([
        provider.getAccounts ? provider.getAccounts() : Promise.resolve([address]),
        provider.getChain ? provider.getChain() : Promise.resolve(null),
      ]);
      if (!accounts[0] || accounts[0].toLowerCase() !== address.toLowerCase()) throw new Error("The connected UniSat address changed. Refresh the wallet dashboard and try again.");
      if (currentChain?.enum && currentChain.enum !== network) throw new Error("The active UniSat network changed. Refresh the wallet dashboard and try again.");
      const response = await fetch(`${AUTH_API}/api/auth/challenge`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ site, address, network }),
      });
      const data = await response.json() as AuthChallenge & { error?: string };
      if (!response.ok || data.network !== network || typeof data.challengeId !== "string" || typeof data.message !== "string" || typeof data.expiresAt !== "string") throw new Error(data.error || "Unable to create a network-bound sign-in challenge.");
      setChallenge({ challengeId: data.challengeId, message: data.message, expiresAt: data.expiresAt, network: data.network });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the sign-in challenge.");
    } finally {
      setBusy(false);
    }
  };

  const signChallenge = async () => {
    if (!challenge) return;
    const mobile = isMobileUniSatDevice();
    setBusy(true);
    setError("");
    try {
      if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("The challenge expired. Create a new one.");
      if (!provider?.signMessage) throw new Error("This UniSat version does not expose BIP-322 message signing.");
      let signature: string;
      if (mobile) {
        // UniSat Mobile's injected in-app provider can require signMessage to
        // start directly from the tap; run read-only wallet checks immediately
        // after the prompt, and never submit if the active wallet changed.
        signature = await signMobileUniSatMessage(provider, challenge.message);
        const [accounts, currentChain] = await Promise.all([
          provider.getAccounts ? provider.getAccounts() : Promise.resolve([address]),
          provider.getChain ? provider.getChain() : Promise.resolve(null),
        ]);
        if (!accounts[0] || accounts[0].toLowerCase() !== address.toLowerCase()) throw new Error("The connected UniSat address changed. Create a new challenge for the active wallet.");
        if (currentChain?.enum && currentChain.enum !== challenge.network) throw new Error("The active UniSat network changed. Create a new challenge for the current network.");
      } else {
        const [accounts, currentChain] = await Promise.all([
          provider.getAccounts ? provider.getAccounts() : Promise.resolve([address]),
          provider.getChain ? provider.getChain() : Promise.resolve(null),
        ]);
        if (!accounts[0] || accounts[0].toLowerCase() !== address.toLowerCase()) throw new Error("The connected UniSat address changed. Create a new challenge for the active wallet.");
        if (currentChain?.enum && currentChain.enum !== challenge.network) throw new Error("The active UniSat network changed. Create a new challenge for the current network.");
        signature = await provider.signMessage(challenge.message, "bip322-simple");
      }
      if (typeof signature !== "string" || !signature) throw new Error("UniSat did not return a BIP-322 signature.");
      const verifyResponse = await fetch(`${AUTH_API}/api/auth/verify`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ site, address, network: challenge.network, challengeId: challenge.challengeId, signature }),
      });
      const verifyData = await verifyResponse.json() as { session?: AuthSession; error?: string };
      if (!verifyResponse.ok) throw new Error(verifyData.error || "The server rejected the signature.");
      const sessionResponse = await fetch(`${AUTH_API}/api/auth/session?site=${site}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const sessionData = await sessionResponse.json() as { session?: AuthSession | null };
      if (!sessionResponse.ok || !sessionData.session || sessionData.session.address.toLowerCase() !== address.toLowerCase() || sessionData.session.network !== challenge.network) {
        setSession(null);
        setStatus("anonymous");
        setChallenge(null);
        throw new Error("UniSat accepted the signature, but this browser did not retain the secure session cookie. Allow secure partitioned cookies for this site and try again.");
      }
      setSession(sessionData.session);
      setStatus("authenticated");
      setChallenge(null);
    } catch (cause) {
      if (mobile && cause instanceof UniSatSignTimeoutError) {
        setMobileSignTimedOut(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Sign-in failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${AUTH_API}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ site }),
      });
      if (!response.ok) throw new Error("Unable to revoke the server session.");
      setSession(null);
      setStatus("anonymous");
      setChallenge(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke the server session.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3 border border-[#3b434d] bg-[#10151a] p-3 sm:p-4" aria-labelledby={`wallet-auth-title-${site}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[#70c7a0]">
            <ShieldCheck size={13} /> BIP-322 wallet sign-in
          </p>
          <h3 id={`wallet-auth-title-${site}`} className="mt-1 font-display text-lg text-[#f3efe5]">Verify wallet ownership</h3>
          <p className="mt-1 font-mono text-[10px] leading-5 text-[#9ea7b3]">
            Signs a one-time login challenge only. It cannot send FB, transfer an inscription, or approve a spend. Your private key stays in UniSat.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {sessionMatchesWallet ? (
            <button type="button" onClick={() => void logout()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] hover:border-[#d99a54] disabled:opacity-50">
              <LogOut size={12} /> {busy ? "Revoking…" : "Sign out"}
            </button>
          ) : (
            <button type="button" onClick={() => void requestChallenge()} disabled={busy || !networkReady} className="min-h-10 border border-[#70c7a0] bg-[#70c7a0] px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-[#0b0d10] disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? "Waiting…" : "Create sign-in challenge"}
            </button>
          )}
          {session && !sessionMatchesWallet && <button type="button" onClick={() => void logout()} disabled={busy} className="inline-flex min-h-10 items-center gap-2 border border-[#3b434d] px-3 py-2 font-mono text-[9px] uppercase text-[#d9d3c6] hover:border-[#d99a54] disabled:opacity-50"><LogOut size={12} /> Sign out other session</button>}
        </div>
      </div>
      {!networkReady && <p className="mt-3 border border-[#a45e54]/60 bg-[#a45e54]/10 p-2 font-mono text-[10px] text-[#e08b7d]">Select Bitcoin mainnet or Fractal Bitcoin mainnet in UniSat to sign in.</p>}
      {sessionMatchesWallet && <p className="mt-3 border border-[#70c7a0]/40 bg-[#70c7a0]/5 p-2 font-mono text-[10px] text-[#70c7a0]" role="status">Verified for {address}. Session expires {new Date(session!.expiresAt).toLocaleString()}.</p>}
      {session && !sessionMatchesWallet && <p className="mt-3 border border-[#e0b45f]/50 bg-[#e0b45f]/5 p-2 font-mono text-[10px] text-[#e0b45f]">A session for a different wallet exists in this browser. Sign in with the active wallet to replace it, or sign out of that session.</p>}
      {status === "unavailable" && <p className="mt-3 font-mono text-[10px] text-[#e0b45f]" role="status">The secure sign-in service or its browser session cookie is unavailable.</p>}
      {challenge && !sessionMatchesWallet && (
        <div className="mt-3 border border-[#70c7a0]/50 bg-[#0b0f12] p-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#70c7a0]">Review this message before opening UniSat · expires {new Date(challenge.expiresAt).toLocaleTimeString()}</p>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-5 text-[#d9d3c6]">{challenge.message}</pre>
          <button type="button" onClick={() => void signChallenge()} disabled={busy || (isMobileUniSatDevice() && mobileSignTimedOut)} className="mt-3 min-h-10 w-full border border-[#70c7a0] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#70c7a0] hover:bg-[#70c7a0]/10 disabled:opacity-50 sm:w-auto">
            {busy ? "Waiting for UniSat…" : "Sign this challenge in UniSat"}
          </button>
          {mobileSignTimedOut && isMobileUniSatDevice() && <div className="mt-3 border border-[#e0b45f]/50 bg-[#e0b45f]/5 p-2 font-mono text-[10px] leading-5 text-[#e0b45f]" role="alert"><p>UniSat did not respond within 30 seconds. No signature was sent to the server. Check UniSat for a pending request; do not retry while one is still open.</p><button type="button" onClick={() => { setMobileSignTimedOut(false); setError(""); }} className="mt-2 underline">I checked UniSat — allow another attempt</button></div>}
        </div>
      )}
      {error && !(mobileSignTimedOut && isMobileUniSatDevice()) && <p className="mt-3 font-mono text-[10px] leading-5 text-[#e08b7d]" role="alert">{error}</p>}
      <p className="mt-3 font-mono text-[9px] leading-4 text-[#718092]">BIP-322 sign-in supports the four mainnet formats on Bitcoin and Fractal Bitcoin: 1… (P2PKH), 3… (P2SH-nested SegWit), bc1q… (P2WPKH) and bc1p… (P2TR). The signature is verified server-side and remains separate from every transaction approval.</p>
    </section>
  );
}
