# UniSat Open API quota failover

The shared `fractal-ordinal-live` Worker serves both Ordinal Punks and Fractal Pokedex. Local Vault transaction preparation requires live UniSat UTXO and asset metadata; it must fail closed when that data cannot be verified.

## Existing production secrets

- `UNISAT_BITCOIN_API`: primary key for `https://open-api.unisat.io` (Bitcoin mainnet).
- `UNISAT_API_KEY`: primary key for `https://open-api-fractal.unisat.io` (Fractal Bitcoin mainnet).

## Optional fallback secrets

The Worker supports same-network fallback keys when UniSat returns HTTP 403 with API code `-2005` (quota exceeded):

- `UNISAT_BITCOIN_API_FALLBACK`: optional additional Bitcoin Open API key.
- `UNISAT_API_KEY_FALLBACK`: optional additional Fractal Open API key.

Add each fallback value as a **secret** on the existing Cloudflare Worker `fractal-ordinal-live` (Workers & Pages → Worker → Settings → Variables and Secrets). Never add API keys to Vite variables, browser code, Git, Wrangler plaintext vars, or issue/PR text. A fallback key must have active quota for its matching network; Bitcoin and Fractal keys are never cross-used.

The existing primary secrets, Worker name, Durable Object binding, compatibility date, and routes remain unchanged. No fallback value is included in this repository.

## Operational note

A fallback key reduces downtime only if it is configured and has quota. If both keys for a network are exhausted, the Worker returns the existing safe failure for UTXO-dependent transactions. Do not bypass asset/UTXO verification by substituting an unverified UTXO list. Fee estimates can use the existing Mempool fallback, but that is not sufficient to authorize spending inputs.
