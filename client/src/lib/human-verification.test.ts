import { describe, expect, it } from "vitest";
import { getHumanVerificationHeaders } from "@/lib/human-verification";

describe("getHumanVerificationHeaders", () => {
  it("returns the action and current proof for an unexpired session", () => {
    const session = JSON.stringify({ proof: "signed-proof", expiresAt: 2000 });
    expect(getHumanVerificationHeaders("ordinal-punks", session, 1000)).toEqual({
      "X-Human-Action": "ordinal-punks",
      "X-Human-Proof": "signed-proof",
    });
  });

  it.each([null, "not-json", JSON.stringify({ proof: "", expiresAt: 2000 }), JSON.stringify({ proof: "expired", expiresAt: 1000 })])(
    "rejects missing, malformed, or expired sessions (%s)",
    (session) => expect(getHumanVerificationHeaders("pokedex", session, 1000)).toBeNull(),
  );
});
