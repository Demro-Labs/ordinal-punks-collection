export type LocalVaultSite = "punks" | "pokedex";
export type LocalVaultNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";

export type LocalVaultSiteSession = {
  version: 1;
  site: LocalVaultSite;
  network: LocalVaultNetwork;
  address: string;
  publicKey: string;
  connectedAt: string;
};

export const LOCAL_VAULT_SESSION_EVENT = "ordi-wallet:local-vault-session";
const storageKey = (site: LocalVaultSite) => `ordi-wallet-site-session:${site}`;

function isSession(value: unknown): value is LocalVaultSiteSession {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalVaultSiteSession>;
  return item.version === 1
    && (item.site === "punks" || item.site === "pokedex")
    && (item.network === "BITCOIN_MAINNET" || item.network === "FRACTAL_BITCOIN_MAINNET")
    && typeof item.address === "string" && item.address.length > 0
    && typeof item.publicKey === "string" && item.publicKey.length > 0
    && typeof item.connectedAt === "string";
}

export function readLocalVaultSiteSession(site: LocalVaultSite): LocalVaultSiteSession | null {
  try {
    const raw = localStorage.getItem(storageKey(site));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function publishLocalVaultSiteSession(session: LocalVaultSiteSession | null, site?: LocalVaultSite) {
  if (typeof window === "undefined") return;
  try {
    if (session) localStorage.setItem(storageKey(session.site), JSON.stringify(session));
    else if (site) localStorage.removeItem(storageKey(site));
  } catch {
    // Private browsing or storage restrictions do not disable the in-memory event.
  }
  window.dispatchEvent(new CustomEvent<LocalVaultSiteSession | null>(LOCAL_VAULT_SESSION_EVENT, { detail: session }));
}

export function clearLocalVaultSiteSession(site: LocalVaultSite) {
  try { localStorage.removeItem(storageKey(site)); } catch { /* storage may be unavailable */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<null>(LOCAL_VAULT_SESSION_EVENT, { detail: null }));
}
