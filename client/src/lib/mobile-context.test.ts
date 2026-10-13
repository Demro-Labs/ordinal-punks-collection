import { describe, expect, it } from "vitest";
import { isMobileUniSatDevice } from "./mobile-context";

describe("isMobileUniSatDevice", () => {
  it.each([
    { userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile", platform: "Linux armv8l" },
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone" },
    { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", platform: "MacIntel", maxTouchPoints: 5 },
    { userAgent: "Custom WebView", platform: "Linux", search: "?unisatMobile=1" },
  ])("recognizes a mobile UniSat context: %o", input => {
    expect(isMobileUniSatDevice(input)).toBe(true);
  });

  it.each([
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 },
    { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", platform: "MacIntel", maxTouchPoints: 0 },
  ])("does not classify a regular desktop as mobile: %o", input => {
    expect(isMobileUniSatDevice(input)).toBe(false);
  });
});
