import { describe, expect, it } from "vitest";
import { normalizeUniSatTxid, parseFbAmountToSats } from "./native-fb-send";

describe("parseFbAmountToSats", () => {
  it.each([["1", 100_000_000], ["0.00000001", 1], ["2.5", 250_000_000], ["0.00000010", 10]])("parses %s exactly", (input, expected) => {
    expect(parseFbAmountToSats(input)).toBe(expected);
  });
  it.each(["", "0", "-1", "1e-8", "1.000000001", "01", "0.00000000", "90071993.54740992"])("rejects invalid or unsafe amount %s", input => {
    expect(parseFbAmountToSats(input)).toBeNull();
  });
});

describe("normalizeUniSatTxid", () => {
  const id = "a".repeat(64);
  it("accepts the documented string response", () => expect(normalizeUniSatTxid(id)).toBe(id));
  it("accepts an object-wrapped txid defensively", () => expect(normalizeUniSatTxid({ txid: id })).toBe(id));
  it("rejects malformed values", () => expect(normalizeUniSatTxid("bad")).toBeNull());
});
