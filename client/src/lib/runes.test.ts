import { describe, expect, it } from "vitest";
import { formatRuneAmount, parseRuneAmountToBaseUnits } from "@/lib/runes";

describe("Fractal Rune amount conversion", () => {
  it("formats base units without floating-point rounding", () => {
    expect(formatRuneAmount("123450", 2)).toBe("1234.5");
    expect(formatRuneAmount("1", 8)).toBe("0.00000001");
    expect(formatRuneAmount("100000", 3)).toBe("100");
    expect(formatRuneAmount("987", 0)).toBe("987");
  });

  it("converts a valid decimal amount to base units and allows the exact maximum", () => {
    expect(parseRuneAmountToBaseUnits("1234.5", 2, "123450")).toBe("123450");
    expect(parseRuneAmountToBaseUnits("1.2", 3, "1234")).toBe("1200");
    expect(parseRuneAmountToBaseUnits("1234", 2, "123450")).toBe("123400");
  });

  it("rejects zero, excessive precision, malformed values, and overspending", () => {
    expect(parseRuneAmountToBaseUnits("0", 2, "123450")).toBeNull();
    expect(parseRuneAmountToBaseUnits("1.234", 2, "999999")).toBeNull();
    expect(parseRuneAmountToBaseUnits("1", 0, "999999")).toBe("1");
    expect(parseRuneAmountToBaseUnits("1.0", 0, "999999")).toBeNull();
    expect(parseRuneAmountToBaseUnits("1234.51", 2, "123450")).toBeNull();
    expect(parseRuneAmountToBaseUnits("01", 0, "999999")).toBeNull();
  });
});
