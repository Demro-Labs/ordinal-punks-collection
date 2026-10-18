import * as bitcoin from "bitcoinjs-lib";
import type { AddressType, OrdiWalletRecord } from "./ordi-wallet";

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

export function isWalletExtensionContext() {
  return typeof window !== "undefined" && /^(?:chrome|moz|safari-web)-extension:$/.test(window.location.protocol);
}

export function isLocalVaultSiteSession(value: unknown): value is LocalVaultSiteSession {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalVaultSiteSession>;
  if (item.version !== 2 || (item.site !== "punks" && item.site !== "pokedex")
    || (item.network !== "BITCOIN_MAINNET" && item.network !== "FRACTAL_BITCOIN_MAINNET")
    || !ADDRESS_TYPES.includes(item.activeAddressType as AddressType)
    || typeof item.address !== "string" || typeof item.publicKey !== "string" || !/^(?:[a-f0-9]{66}|[a-f0-9]{130})$/i.test(item.publicKey)
    || typeof item.connectedAt !== "string" || !Number.isFinite(Date.parse(item.connectedAt))
    || "privateKey" in item || "mnemonic" in item || "passphrase" in item) return false;
  if (!item.addresses || typeof item.addresses !== "object") return false;
  const addressesValid = ADDRESS_TYPES.every(type => {
    const address = item.addresses?.[type];
    return Boolean(address && address.type === type && typeof address.label === "string"
      && typeof address.address === "string" && address.address.length > 0
      && typeof address.publicKey === "string" && /^(?:[a-f0-9]{66}|[a-f0-9]{130})$/i.test(address.publicKey)
      && !("privateKey" in address));
  });
  if (!addressesValid) return false;
  const active = item.addresses[item.activeAddressType as AddressType];
  if (!active || item.address !== active.address || item.publicKey.toLowerCase() !== active.publicKey.toLowerCase()) return false;
  try {
    bitcoin.address.toOutputScript(item.address, bitcoin.networks.bitcoin);
    return ADDRESS_TYPES.every(type => Boolean(item.addresses?.[type]?.address)
      && (bitcoin.address.toOutputScript(item.addresses![type].address, bitcoin.networks.bitcoin).length > 0));
  } catch {
    return false;
  }
}

export function createLocalVaultSiteSession(input: {
  wallet: OrdiWalletRecord;
  site: LocalVaultSite;
  network: LocalVaultNetwork;
  activeAddressType: AddressType;
}): LocalVaultSiteSession {
  const active = input.wallet.addresses[input.activeAddressType];
  const session: LocalVaultSiteSession = {
    version: 2,
    site: input.site,
    network: input.network,
    activeAddressType: input.activeAddressType,
    address: active.address,
    publicKey: active.publicKey,
    addresses: Object.fromEntries(ADDRESS_TYPES.map(type => {
      const walletAddress = input.wallet.addresses[type];
      return [type, { type, label: walletAddress.label, address: walletAddress.address, publicKey: walletAddress.publicKey }];
    })) as Record<AddressType, LocalVaultAddress>,
    connectedAt: new Date().toISOString(),
  };
  if (!isLocalVaultSiteSession(session)) throw new Error("The local vault site configuration is invalid.");
  return session;
}

export function readLocalVaultSiteSession(site: LocalVaultSite): LocalVaultSiteSession | null {
  try {
    const raw = localStorage.getItem(storageKey(site));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLocalVaultSiteSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function publishLocalVaultSiteSession(session: LocalVaultSiteSession | null, site?: LocalVaultSite) {
  if (typeof window === "undefined") return;
  if (session && !isLocalVaultSiteSession(session)) return;
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
