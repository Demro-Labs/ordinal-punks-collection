export type MobileContextInput = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  search?: string;
};

/**
 * Detect mobile browsers, iPadOS desktop-mode browsers, and UniSat openDapp
 * sessions without treating a desktop UniSat extension as a mobile device.
 */
export function isMobileUniSatDevice(input: MobileContextInput = {}): boolean {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const search = input.search ?? (typeof window === "undefined" ? "" : window.location.search);
  const userAgent = input.userAgent ?? nav?.userAgent ?? "";
  const platform = input.platform ?? nav?.platform ?? "";
  const maxTouchPoints = input.maxTouchPoints ?? nav?.maxTouchPoints ?? 0;

  const explicitUniSatMobile = new URLSearchParams(search).get("unisatMobile") === "1";
  const touchIPadDesktopMode = platform === "MacIntel" && maxTouchPoints > 1;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile|UniSat\s*Mobile/i.test(userAgent);

  return explicitUniSatMobile || touchIPadDesktopMode || mobileUserAgent;
}
