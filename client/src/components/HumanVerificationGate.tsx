import { useEffect, useRef, useState, type ReactNode } from "react";

const SITE_KEY = "0x4AAAAAAFSgiNTy1R9HRN2w";
const VERIFY_API = "https://turnstile-human-verification.servostar23.workers.dev/api";
const STORAGE_PREFIX = "demro-human-verification:v1:";

type Action = "ordinal-punks" | "pokedex";
type TurnstileOptions = {
  sitekey: string;
  action: Action;
  theme: "dark";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
};
type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function isUniSatAppBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  return Boolean((window as Window & { unisat?: unknown }).unisat) || ua.includes("unisat");
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const current = document.querySelector<HTMLScriptElement>("script[data-cloudflare-turnstile]");
    const script = current ?? document.createElement("script");
    const onLoad = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not initialize"));
    const onError = () => reject(new Error("Turnstile could not be loaded"));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!current) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.cloudflareTurnstile = "true";
      document.head.appendChild(script);
    }
  });
}

async function postJson(path: string, body: Record<string, string>) {
  const response = await fetch(`${VERIFY_API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Cloudflare could not verify this request");
  return result as { valid?: boolean; proof?: string; expiresAt?: number } | null;
}

export default function HumanVerificationGate({ action, children }: { action: Action; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [verified, setVerified] = useState(() => isUniSatAppBrowser());
  const [message, setMessage] = useState("Vérification en cours…");
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const storageKey = `${STORAGE_PREFIX}${action}`;

    const onSuccess = async (captchaToken: string) => {
      if (cancelled) return;
      setSubmitting(true);
      setMessage("Vérification de votre réponse…");
      try {
        const result = await postJson("verify", { action, token: captchaToken });
        if (!result?.valid || !result.proof || !result.expiresAt) throw new Error("Verification failed");
        localStorage.setItem(storageKey, JSON.stringify({ proof: result.proof, expiresAt: result.expiresAt }));
        setVerified(true);
      } catch {
        setMessage("La vérification n’a pas abouti. Réessayez dans le widget.");
        if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
      } finally {
        if (!cancelled) setSubmitting(false);
      }
    };

    const start = async () => {
      setMessage("Vérification en cours…");
      // UniSat's embedded dApp browser does not support the interactive
      // Turnstile challenge reliably. Wallet approval remains mandatory for
      // every sensitive operation, so allow this read-only gate to continue
      // only when UniSat explicitly exposes its in-app provider or UA.
      if (isUniSatAppBrowser()) {
        if (!cancelled) setVerified(true);
        return;
      }
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const session = JSON.parse(saved) as { proof?: string; expiresAt?: number };
          if (session.proof && session.expiresAt && session.expiresAt > Date.now()) {
            const checked = await postJson("session", { action, proof: session.proof });
            if (checked?.valid) {
              if (!cancelled) setVerified(true);
              return;
            }
          }
          localStorage.removeItem(storageKey);
        }
      } catch {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // Storage may be disabled; the visitor can still verify this session.
        }
      }
      if (cancelled) return;
      setMessage("Confirmez que vous êtes une personne pour accéder au site.");
      try {
        const api = await loadTurnstile();
        if (cancelled || !containerRef.current) return;
        if (!SITE_KEY) {
          setMessage("La vérification Cloudflare n’est pas encore configurée.");
          return;
        }
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: SITE_KEY,
          action,
          theme: "dark",
          callback: token => void onSuccess(token),
          "error-callback": () => setMessage("Le widget Cloudflare a rencontré un problème. Réessayez."),
          "expired-callback": () => {
            setMessage("La vérification a expiré. Confirmez à nouveau.");
            if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
          },
        });
        setReady(true);
      } catch {
        if (!cancelled) setMessage("Impossible de charger Cloudflare Turnstile. Vérifiez votre connexion et actualisez la page.");
      }
    };

    void start();
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [action]);

  if (verified) return <>{children}</>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0b0d10] px-4 py-10 text-[#f3efe5]">
      <section className="w-full max-w-md border border-[#3b434d] bg-[#12161b] p-6 shadow-2xl sm:p-8" aria-labelledby="human-check-title">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center border border-[#70c7a0]/50 bg-[#70c7a0]/10 text-[#70c7a0]" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z" />
              <path d="m8.5 12 2.2 2.2 4.8-5" />
            </svg>
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#70c7a0]">Cloudflare Turnstile</p>
        </div>
        <h1 id="human-check-title" className="font-display text-2xl font-semibold">Vérification de sécurité</h1>
        <p className="mt-3 font-sans text-sm leading-6 text-[#9ea7b3]">Confirmez que vous êtes une personne pour continuer vers le site.</p>
        <div className="mt-6 flex min-h-[66px] items-center justify-center" ref={containerRef} aria-label="Widget Cloudflare Turnstile" />
        <p className="mt-3 min-h-10 font-mono text-[11px] leading-5 text-[#9ea7b3]" role="status" aria-live="polite">{submitting ? "Validation sécurisée auprès de Cloudflare…" : message}</p>
        {!ready && !submitting && <div className="mt-2 h-1 w-full overflow-hidden bg-[#252b32]"><div className="h-full w-1/2 animate-pulse bg-[#70c7a0]" /></div>}
        <p className="mt-5 border-t border-[#2c323a] pt-4 font-mono text-[9px] leading-4 text-[#718092]">Le jeton est vérifié par le serveur Cloudflare; aucune donnée de vérification n’est conservée au-delà de la session signée.</p>
      </section>
    </main>
  );
}
