import { describe, expect, it } from "vitest";
import {
  getUniSatInscriptionUrl,
  isTransferOutcomeUnclear,
} from "./transfer-safety";

const INSCRIPTION_ID = `${"a".repeat(64)}i0`;

describe("getUniSatInscriptionUrl", () => {
  it("uses the Fractal UniSat explorer for Fractal mainnet", () => {
    expect(getUniSatInscriptionUrl("FRACTAL_BITCOIN_MAINNET", INSCRIPTION_ID)).toBe(
      `https://fractal.unisat.io/inscription/${INSCRIPTION_ID}`
    );
  });

  it("uses the Bitcoin UniSat explorer for Bitcoin mainnet", () => {
    expect(getUniSatInscriptionUrl("BITCOIN_MAINNET", INSCRIPTION_ID)).toBe(
      `https://unisat.io/inscription/${INSCRIPTION_ID}`
    );
  });

  it("does not invent an explorer link for an unsupported chain", () => {
    expect(getUniSatInscriptionUrl("BITCOIN_TESTNET", INSCRIPTION_ID)).toBeNull();
  });
});

describe("isTransferOutcomeUnclear", () => {
  it.each([
    ["native toAddress undefined", new Error("Cannot read property 'toAddress' of undefined"), true],
    ["structured incomplete response", { message: "UniSat Mobile returned an incomplete transfer response." }, true],
    ["missing transaction id after wallet call", "UniSat did not return a valid transaction ID.", true],
    ["uncertain Mempool broadcast", new Error("BROADCAST_OUTCOME_UNCLEAR: network timeout"), true],
    ["wallet rejection", new Error("User rejected the request."), false],
    ["PSBT cancelled before signing", new Error("Transfer cancelled before signing; no transaction was signed or broadcast."), false],
    ["preflight error", new Error("Fee service unavailable."), false],
  ])("classifies %s", (_label, error, expected) => {
    expect(isTransferOutcomeUnclear(error)).toBe(expected);
  });
});
