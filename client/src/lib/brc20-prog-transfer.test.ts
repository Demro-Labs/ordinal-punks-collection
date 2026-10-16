import { describe, expect, it } from "vitest";
import {
  BRC20_PROG_CONTROLLER_ADDRESS,
  bitcoinAddressToBrc20ProgAddress,
  buildBrc20ProgTransferInscription,
  encodeBrc20ControllerTransfer,
  formatBrc20ProgAmountUnits,
  parseBrc20ProgAmountUnits,
} from "./brc20-prog-transfer";

const recipient = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const recipientEvm = "0x39280601edee011475789c611568e4e925c2dac4";

describe("BRC2.0 controller transfers", () => {
  it("derives the EVM identity from the Bitcoin mainnet output script", () => {
    expect(bitcoinAddressToBrc20ProgAddress(recipient)).toBe(recipientEvm);
    expect(() => bitcoinAddressToBrc20ProgAddress("tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")).toThrow(/Bitcoin mainnet/);
  });

  it("converts decimal token quantities to 18-decimal units without floating point", () => {
    expect(parseBrc20ProgAmountUnits("1.5")).toBe("1500000000000000000");
    expect(parseBrc20ProgAmountUnits("0.000000000000000001")).toBe("1");
    expect(() => parseBrc20ProgAmountUnits("0")).toThrow(/supérieur à zéro/);
    expect(() => parseBrc20ProgAmountUnits("1e-3")).toThrow(/18 décimales/);
    expect(() => parseBrc20ProgAmountUnits("0.0000000000000000001")).toThrow(/18 décimales/);
  });

  it("ABI-encodes transfer(bytes,address,uint256) for the canonical controller", () => {
    const data = encodeBrc20ControllerTransfer("ABC-12", recipientEvm, "1500000000000000000");
    const hex = data.slice(2);
    const words = hex.slice(8).match(/.{64}/g)!;
    expect(hex.slice(0, 8)).toBe("fde9ba41");
    expect(words[0]).toBe((96n).toString(16).padStart(64, "0"));
    expect(words[1]).toBe(recipientEvm.slice(2).padStart(64, "0"));
    expect(words[2]).toBe((1500000000000000000n).toString(16).padStart(64, "0"));
    expect(words[3]).toBe((6).toString(16).padStart(64, "0"));
    expect(words[4]).toBe(Buffer.from("ABC-12").toString("hex").padEnd(64, "0"));
  });

  it("builds a BRC2.0 call inscription targeting BRC20_Controller", () => {
    const inscription = JSON.parse(buildBrc20ProgTransferInscription("ABC-12", recipient, "1.5"));
    expect(inscription).toEqual({
      p: "brc20-prog",
      op: "call",
      c: BRC20_PROG_CONTROLLER_ADDRESS,
      d: encodeBrc20ControllerTransfer("ABC-12", recipientEvm, "1500000000000000000"),
    });
  });

  it("formats controller balances without losing precision", () => {
    expect(formatBrc20ProgAmountUnits("1500000000000000000")).toBe("1.5");
    expect(formatBrc20ProgAmountUnits("1000000000000000000")).toBe("1");
    expect(formatBrc20ProgAmountUnits("1")).toBe("0.000000000000000001");
    expect(() => formatBrc20ProgAmountUnits("01")).toThrow(/invalide/);
  });
});
