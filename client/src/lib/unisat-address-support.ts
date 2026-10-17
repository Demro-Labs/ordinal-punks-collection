export type UniSatAddressType =
  | "legacy-p2pkh"
  | "nested-segwit-p2sh-p2wpkh"
  | "native-segwit-p2wpkh"
  | "taproot-p2tr";

const BASE58_ADDRESS_CHARS = "[1-9A-HJ-NP-Za-km-z]";
const BECH32_DATA_CHARS = "[ac-hj-np-z02-9]";

/** Classify UniSat's four documented mainnet address formats. Checksum and network validation remain the Worker/Mempool's responsibility. */
export function getUniSatAddressType(address: string): UniSatAddressType | null {
  const value = address.trim();
  if (new RegExp(`^1${BASE58_ADDRESS_CHARS}{25,34}$`).test(value)) {
    return "legacy-p2pkh";
  }
  if (new RegExp(`^3${BASE58_ADDRESS_CHARS}{25,34}$`).test(value)) {
    return "nested-segwit-p2sh-p2wpkh";
  }
  if (new RegExp(`^bc1q${BECH32_DATA_CHARS}{38}$`, "i").test(value)) {
    return "native-segwit-p2wpkh";
  }
  if (new RegExp(`^bc1p${BECH32_DATA_CHARS}{58}$`, "i").test(value)) {
    return "taproot-p2tr";
  }
  return null;
}

export type UniSatMessageSignatureType = "ecdsa" | "bip322-simple";

/** Use UniSat's compact ECDSA/BIP-137 format for Base58 addresses; BIP-322 simple is for Bech32 SegWit/Taproot. */
export function getUniSatMessageSignatureType(address: string): UniSatMessageSignatureType | null {
  switch (getUniSatAddressType(address)) {
    case "legacy-p2pkh":
    case "nested-segwit-p2sh-p2wpkh": return "ecdsa";
    case "native-segwit-p2wpkh":
    case "taproot-p2tr": return "bip322-simple";
    default: return null;
  }
}

export function supportsUniSatMessageSigning(address: string): boolean {
  return getUniSatMessageSignatureType(address) !== null;
}

export function getUniSatAddressTypeLabel(type: UniSatAddressType): string {
  switch (type) {
    case "legacy-p2pkh": return "Legacy (P2PKH)";
    case "nested-segwit-p2sh-p2wpkh": return "Nested SegWit (P2SH-P2WPKH)";
    case "native-segwit-p2wpkh": return "Native SegWit (P2WPKH)";
    case "taproot-p2tr": return "Taproot (P2TR)";
  }
}
