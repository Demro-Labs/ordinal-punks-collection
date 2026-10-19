import { LIVE_DATA_API_BASE } from "@/lib/live";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

bitcoin.initEccLib(ecc);

export type OrdiNetwork = "BITCOIN_MAINNET" | "FRACTAL_BITCOIN_MAINNET";
export type AddressType = "legacy" | "nested-segwit" | "native-segwit" | "taproot";
export type OrdiAddress = {
  type: AddressType;
  label: string;
  path: string;
  address: string;
  publicKey: string;
  privateKey: string;
};
export type OrdiWalletRecord = {
  mnemonic: string;
  passphrase: string;
  createdAt: string;
  addresses: Record<AddressType, OrdiAddress>;
};
export type OrdiVault = { version: 1; salt: string; iv: string; ciphertext: string; createdAt: string };

export const ORDI_WALLET_NAME = "Ordi Wallet";
export const ORDI_VAULT_KEY = "ordi-wallet-v1";
export const ADDRESS_SPECS: Array<{ type: AddressType; label: string; purpose: number }> = [
  { type: "legacy", label: "Legacy · P2PKH", purpose: 44 },
  { type: "nested-segwit", label: "Nested SegWit · P2SH-P2WPKH", purpose: 49 },
  { type: "native-segwit", label: "Native SegWit · P2WPKH", purpose: 84 },
  { type: "taproot", label: "Taproot · P2TR", purpose: 86 },
];

const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => Uint8Array.from(value.match(/.{1,2}/g) ?? [], item => parseInt(item, 16));
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...Array.from(value)));
const unbase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export function createMnemonic(words: 12 | 24) {
  return generateMnemonic(wordlist, words === 12 ? 128 : 256);
}

export function deriveOrdiWallet(mnemonic: string, passphrase = ""): OrdiWalletRecord {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(normalized, wordlist)) throw new Error("The BIP39 recovery phrase is invalid.");
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normalized, passphrase));
  const addresses = {} as Record<AddressType, OrdiAddress>;
  for (const spec of ADDRESS_SPECS) {
    // UniSat keeps the same Bitcoin-compatible derivation family when switching
    // between Bitcoin mainnet and Fractal mainnet; the network is selected at use time.
    const path = `m/${spec.purpose}'/0'/0'/0/0`;
    const child = root.derive(path);
    if (!child.privateKey || !child.publicKey) throw new Error("Unable to derive the wallet key.");
    const network = bitcoin.networks.bitcoin;
    const publicKey = child.publicKey;
    const payment = spec.type === "legacy"
      ? bitcoin.payments.p2pkh({ pubkey: publicKey, network })
      : spec.type === "nested-segwit"
        ? bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: publicKey, network }), network })
        : spec.type === "native-segwit"
          ? bitcoin.payments.p2wpkh({ pubkey: publicKey, network })
          : bitcoin.payments.p2tr({ internalPubkey: ecc.xOnlyPointFromPoint(publicKey), network });
    if (!payment.address) throw new Error(`Unable to derive the ${spec.label} address.`);
    addresses[spec.type] = { type: spec.type, label: spec.label, path, address: payment.address, publicKey: hex(publicKey), privateKey: hex(child.privateKey) };
  }
  return { mnemonic: normalized, passphrase, createdAt: new Date().toISOString(), addresses };
}

async function vaultKey(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptOrdiWallet(wallet: OrdiWalletRecord, password: string): Promise<OrdiVault> {
  if (password.length < 10) throw new Error("The vault password must be at least 10 characters long.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await vaultKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(wallet));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { version: 1, salt: base64(salt), iv: base64(iv), ciphertext: base64(ciphertext), createdAt: wallet.createdAt };
}

export async function decryptOrdiWallet(vault: OrdiVault, password: string): Promise<OrdiWalletRecord> {
  const key = await vaultKey(password, unbase64(vault.salt));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(vault.iv) }, key, unbase64(vault.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as OrdiWalletRecord;
}

export function readOrdiVault(): OrdiVault | null {
  try {
    const value = localStorage.getItem(ORDI_VAULT_KEY);
    return value ? JSON.parse(value) as OrdiVault : null;
  } catch { return null; }
}

export function formatSats(value: number | null) {
  return value === null ? "—" : `${value.toLocaleString("en-US")} sats`;
}

export async function fetchAddressBalance(network: OrdiNetwork, address: string) {
  const query = new URLSearchParams({ chain: network, address });
  const response = await fetch(`${LIVE_DATA_API_BASE}/api/mempool/address?${query}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Mempool HTTP ${response.status}`);
  const value = await response.json() as { chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number }; mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number } };
  const chain = value.chain_stats ?? {}; const mempool = value.mempool_stats ?? {};
  const confirmed = (chain.funded_txo_sum ?? 0) - (chain.spent_txo_sum ?? 0);
  const unconfirmed = (mempool.funded_txo_sum ?? 0) - (mempool.spent_txo_sum ?? 0);
  return { confirmed, unconfirmed, total: confirmed + unconfirmed };
}
