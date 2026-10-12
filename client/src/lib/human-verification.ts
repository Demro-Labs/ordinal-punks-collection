export type HumanVerificationAction = "ordinal-punks" | "pokedex";

export function getHumanVerificationHeaders(
  action: HumanVerificationAction,
  storedSession: string | null,
  now = Date.now(),
): Record<string, string> | null {
  if (!storedSession) return null;
  try {
    const session = JSON.parse(storedSession) as { proof?: unknown; expiresAt?: unknown };
    if (
      typeof session.proof !== "string" ||
      session.proof.length < 1 ||
      typeof session.expiresAt !== "number" ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= now
    ) return null;
    return { "X-Human-Action": action, "X-Human-Proof": session.proof };
  } catch {
    return null;
  }
}
