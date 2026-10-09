# Turnstile verification Worker

Shared server-side verifier used by the Ordinal Punks and Pokédex GitHub Pages apps.

- Production endpoint: `https://turnstile-human-verification.servostar23.workers.dev/api`
- Widget hostname: `demro-labs.github.io`
- Allowed actions: `ordinal-punks` and `pokedex`
- API routes: `POST /verify` validates a Turnstile response with Cloudflare Siteverify and returns an HMAC-signed 12-hour session; `POST /session` validates that session and its action.
- Worker secrets are Cloudflare secret bindings named `TURNSTILE_SECRET` and `SESSION_SECRET`. Never add their values to this repository.
- The sitekey in each app is public by design; server validation binds tokens to the expected hostname and action.

To deploy changes, upload `turnstile-verification-worker.js` as the `turnstile-human-verification` Worker module, preserve the two secret bindings, and keep its `workers.dev` subdomain enabled. Run the local test suite with:

```sh
node --test cloudflare/turnstile-verification-worker.test.mjs
```

The sites remain hosted on GitHub Pages. The gate protects normal application rendering after server validation; it does not prevent direct requests to GitHub Pages static assets.
