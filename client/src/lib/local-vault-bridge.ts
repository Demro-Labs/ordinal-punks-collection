import type { AddressType } from "./ordi-wallet";

export type LocalVaultSite = "punks" | "pokedex";
export type LocalVaultNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
export type LocalVaultAddress = { type: AddressType; label: string; address: string; publicKey: string };
export type LocalVaultSiteSession = {
  version: 2;
  site: LocalVaultSite;
  network: LocalVaultNetwork;
  activeAddressType: AddressType;
  address: string;
  publicKey: string;
  addresses: Record<AddressType, LocalVaultAddress>;
  connectedAt: string;
};

export const LOCAL_VAULT_SESSION_EVENT = "ordi-wallet:local-vault-session";
const storageKey = (site: LocalVaultSite) => `ordi-wallet-site-session:${site}`;
const ADDRESS_TYPES: AddressType[] = ["legacy", "nested-segwit", "native-segwit", "taproot"];

function isSession(value: unknown): value is LocalVaultSiteSession {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalVaultSiteSession>;
  if (item.version !== 2 || (item.site !== "punks" && item.site !== "pokedex")
    || (item.network !== "BITCOIN_MAINNET" && item.network !== "FRACTAL_BITCOIN_MAINNET")
    || !ADDRESS_TYPES.includes(item.activeAddressType as AddressType)
    || typeof item.address !== "string" || typeof item.publicKey !== "string" || typeof item.connectedAt !== "string") return false;
  if (!item.addresses || typeof item.addresses !== "object") return false;
  return ADDRESS_TYPES.every(type => {
    const address = item.addresses?.[type];
    return Boolean(address && address.type === type && typeof address.label === "string"
      && typeof address.address === "string" && address.address.length > 0
      && typeof address.publicKey === "string" && address.publicKey.length > 0);
  });
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
