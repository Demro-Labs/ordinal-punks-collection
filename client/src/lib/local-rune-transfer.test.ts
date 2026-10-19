import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { buildLocalRunestoneScript } from "@/lib/local-rune-transfer";

function decodeVarints(payload: Buffer) {
  const values: bigint[] = [];
  let value = BigInt(0), shift = BigInt(0);
  for (const byte of payload) {
    value |= BigInt(byte & 0x7f) << shift;
    if (byte & 0x80) shift += BigInt(7);
    else { values.push(value); value = BigInt(0); shift = BigInt(0); }
  }
  if (shift !== BigInt(0)) throw new Error("Truncated varint");
  return values;
}

describe("Local Runestone builder", () => {
  it("encodes a Rune transfer and explicit Rune change edicts", () => {
    const script = buildLocalRunestoneScript("840000:12", "2500", "7500");
    const chunks = bitcoin.script.decompile(script);
    expect(chunks?.[0]).toBe(bitcoin.opcodes.OP_RETURN);
    expect(chunks?.[1]).toBe(bitcoin.opcodes.OP_13);
    expect(decodeVarints(Buffer.from(chunks?.[2] as Uint8Array))).toEqual([BigInt(0), BigInt(840000), BigInt(12), BigInt(2500), BigInt(1), BigInt(0), BigInt(0), BigInt(7500), BigInt(2)]);
  });

  it("does not emit a change edict when the exact Rune balance is sent", () => {
    const script = buildLocalRunestoneScript("1:1", "1", "0");
    const chunks = bitcoin.script.decompile(script);
    expect(decodeVarints(Buffer.from(chunks?.[2] as Uint8Array))).toEqual([BigInt(0), BigInt(1), BigInt(1), BigInt(1), BigInt(1)]);
  });

  it("rejects malformed Rune IDs and non-positive send amounts", () => {
    expect(() => buildLocalRunestoneScript("invalid", "1", "0")).toThrow();
    expect(() => buildLocalRunestoneScript("1:1", "0", "0")).toThrow();
    expect(() => buildLocalRunestoneScript("1:1", "1", "-1")).toThrow();
  });
});
