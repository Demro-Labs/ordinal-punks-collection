import { keccak_256 } from "@noble/hashes/sha3.js";
import * as bitcoin from "bitcoinjs-lib";

export const BRC20_PROG_CONTROLLER_ADDRESS = "0xc54dd4581af2dbf18e4d90840226756e9d2b3cdb";
export const BRC20_PROG_DECIMALS = 18;
const MAX_UINT256 = BigInt(`0x${"f".repeat(64)}`);
const TICKER_PATTERN = /^[a-z0-9-]{6}$/i;

function bytesToHex(value: Uint8Array) {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

const TRANSFER_SELECTOR = bytesToHex(keccak_256(new TextEncoder().encode("transfer(bytes,address,uint256)")).slice(0, 4));

function uintWord(value: bigint | number) {
  const number = BigInt(value);
  if (number < BigInt(0) || number > MAX_UINT256) throw new Error("Valeur ABI hors limites.");
  return number.toString(16).padStart(64, "0");
}

export function isBrc20ProgTicker(ticker: string) {
  return TICKER_PATTERN.test(ticker);
}

/** Maps a Bitcoin mainnet output script to the BRC2.0 EVM identity. */
export function bitcoinAddressToBrc20ProgAddress(address: string) {
  let script: Uint8Array;
  try {
    script = bitcoin.address.toOutputScript(address.trim(), bitcoin.networks.bitcoin);
  } catch {
    throw new Error("Adresse Bitcoin mainnet du destinataire invalide.");
  }
  const digest = keccak_256(script);
  return `0x${bytesToHex(digest.slice(-20))}`;
}

/** Convert a human token quantity into the controller's 18-decimal uint256 units. */
export function parseBrc20ProgAmountUnits(amount: string) {
  const normalized = amount.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    throw new Error("Le montant doit être positif et comporter au maximum 18 décimales.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const scale = powerOfTen(BRC20_PROG_DECIMALS);
  const units = BigInt(whole) * scale + BigInt((fraction + "0".repeat(BRC20_PROG_DECIMALS)).slice(0, BRC20_PROG_DECIMALS) || "0");
  if (units <= BigInt(0) || units > MAX_UINT256) throw new Error("Le montant doit être supérieur à zéro et inférieur à la limite du contrat.");
  return units.toString();
}

/** ABI-encode BRC20_Controller.transfer(bytes ticker, address to, uint256 amount). */
export function encodeBrc20ControllerTransfer(ticker: string, recipientEvmAddress: string, amountUnits: string) {
  if (!isBrc20ProgTicker(ticker)) throw new Error("Le ticker BRC20-Prog doit comporter exactement six caractères alphanumériques ou tirets.");
  if (!/^0x[a-f0-9]{40}$/i.test(recipientEvmAddress)) throw new Error("Adresse EVM du destinataire invalide.");
  if (!/^(?:0|[1-9]\d*)$/.test(amountUnits)) throw new Error("Montant BRC2.0 invalide.");
  const amount = BigInt(amountUnits);
  if (amount <= BigInt(0) || amount > MAX_UINT256) throw new Error("Montant BRC2.0 hors limites.");

  const tickerBytes = new TextEncoder().encode(ticker);
  const tickerHex = bytesToHex(tickerBytes);
  const paddedTicker = tickerHex.padEnd(Math.ceil(tickerHex.length / 64) * 64, "0");
  const encoded = [
    TRANSFER_SELECTOR,
    uintWord(96),
    recipientEvmAddress.slice(2).toLowerCase().padStart(64, "0"),
    uintWord(amount),
    uintWord(tickerBytes.length),
    paddedTicker,
  ].join("");
  return `0x${encoded}`;
}

/** Build the call inscription that is later activated by spending it to OP_RETURN BRC20PROG. */
export function buildBrc20ProgTransferInscription(ticker: string, recipientBitcoinAddress: string, amount: string) {
  const recipientEvmAddress = bitcoinAddressToBrc20ProgAddress(recipientBitcoinAddress);
  const amountUnits = parseBrc20ProgAmountUnits(amount);
  const data = encodeBrc20ControllerTransfer(ticker, recipientEvmAddress, amountUnits);
  return JSON.stringify({ p: "brc20-prog", op: "call", c: BRC20_PROG_CONTROLLER_ADDRESS, d: data });
}

export function formatBrc20ProgAmountUnits(raw: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error("Solde BRC2.0 invalide.");
  const value = BigInt(raw);
  const scale = powerOfTen(BRC20_PROG_DECIMALS);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(BRC20_PROG_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function powerOfTen(exponent: number) {
  let value = BigInt(1);
  for (let index = 0; index < exponent; index += 1) value *= BigInt(10);
  return value;
}
