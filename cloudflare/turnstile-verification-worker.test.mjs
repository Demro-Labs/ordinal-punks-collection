import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./turnstile-verification-worker.js";

const env = {
  TURNSTILE_SECRET: "test-turnstile-secret",
  SESSION_SECRET: "test-session-signing-secret-with-sufficient-entropy",
};
const origin = "https://demro-labs.github.io";

function request(path, body, requestOrigin = origin) {
  return new Request(`https://turnstile-human-verification.workers.dev${path}`, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Turnstile challenge yields a signed session tied to the site action", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const form = new URLSearchParams(init.body);
    const token = form.get("response");
    const action = token === "valid-punks-token" ? "ordinal-punks" : "pokedex";
    return Response.json({
      success: token === "valid-pokedex-token" || token === "valid-punks-token",
      hostname: "demro-labs.github.io",
      action,
    });
  };
  try {
    const issued = await worker.fetch(
      request("/api/verify", { action: "pokedex", token: "valid-pokedex-token" }),
      env,
    );
    assert.equal(issued.status, 200);
    const ticket = await issued.json();
    assert.equal(ticket.valid, true);
    assert.ok(ticket.proof);
    assert.ok(ticket.expiresAt > Date.now());

    const accepted = await worker.fetch(
      request("/api/session", { action: "pokedex", proof: ticket.proof }),
      env,
    );
    assert.deepEqual(await accepted.json(), { valid: true });

    const wrongAction = await worker.fetch(
      request("/api/session", { action: "ordinal-punks", proof: ticket.proof }),
      env,
    );
    assert.deepEqual(await wrongAction.json(), { valid: false });

    const tampered = await worker.fetch(
      request("/api/session", { action: "pokedex", proof: `${ticket.proof}x` }),
      env,
    );
    assert.deepEqual(await tampered.json(), { valid: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid Turnstile response is rejected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  try {
    const response = await worker.fetch(
      request("/api/verify", { action: "pokedex", token: "invalid-token" }),
      env,
    );
    assert.equal(response.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requests from an unapproved origin are rejected", async () => {
  const response = await worker.fetch(
    request("/api/session", { action: "pokedex", proof: "invalid" }, "https://attacker.example"),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("unknown actions and routes are rejected", async () => {
  const action = await worker.fetch(request("/api/session", { action: "other", proof: "x" }), env);
  assert.equal(action.status, 400);
  const route = await worker.fetch(request("/unknown", { action: "pokedex" }), env);
  assert.equal(route.status, 404);
});
