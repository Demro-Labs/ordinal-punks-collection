#!/usr/bin/env bash
set -Eeuo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be provided by the GitHub environment}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be provided by the GitHub environment}"

BASE_URL="https://fractal-ordinal-live.servostar23.workers.dev"
SCRIPT_API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/fractal-ordinal-live"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

curl -fsS --max-time 20 -H "${AUTH_HEADER}" "${SCRIPT_API}/secrets" \
  | jq -e '.success == true and any(.result[]?; .name == "UNISAT_API_KEY" and .type == "secret_text") and any(.result[]?; .name == "UNISAT_BITCOIN_API" and .type == "secret_text") and any(.result[]?; .name == "ETH_API" and .type == "secret_text")' >/dev/null
echo "Cloudflare UniSat and ETH API secret names/types verified; values were not read."

bitcoin_fees="$(curl -fsS --retry 2 --max-time 20 "${BASE_URL}/api/fees/recommended?chain=BITCOIN_MAINNET" \
  -H 'Origin: https://demro-labs.github.io')"
printf '%s' "${bitcoin_fees}" | jq -e '.network == "BITCOIN_MAINNET" and .sources.unisat.available == true and (.sources.unisat.feeRate | type == "number" and . >= 1)' >/dev/null
echo "Bitcoin UniSat-authenticated fee source verified; the secret value was not returned."

curl -fsS --max-time 20 -H "${AUTH_HEADER}" "${SCRIPT_API}/settings" \
  | jq -e '.success == true and any(.result.bindings[]?; .name == "AUTH_STORAGE" and .type == "durable_object_namespace" and .class_name == "AuthStorage")' >/dev/null
echo "Cloudflare AuthStorage Durable Object binding verified."

for collection in opunk pokedex; do
  payload="$(curl -fsS --retry 2 --max-time 20 "${BASE_URL}/api/market?collectionId=${collection}&start=0&limit=1" \
    -H 'Origin: https://demro-labs.github.io')"
  printf '%s' "${payload}" | jq -e --arg collection "${collection}" '.collectionId == $collection' >/dev/null
  echo "Market API verified for ${collection}."
done

for site in punks pokedex; do
  headers_file="${TMP_DIR}/${site}.headers"
  body_file="${TMP_DIR}/${site}.json"
  status="$(curl -sS --max-time 15 -D "${headers_file}" -o "${body_file}" -w '%{http_code}' \
    -H 'Origin: https://demro-labs.github.io' "${BASE_URL}/api/auth/session?site=${site}" || true)"
  [[ "${status}" == "200" ]] || { echo "Auth session endpoint for ${site} returned HTTP ${status}." >&2; exit 1; }
  grep -Fqi 'access-control-allow-origin: https://demro-labs.github.io' "${headers_file}" || { echo "Auth CORS origin missing for ${site}." >&2; exit 1; }
  grep -Fqi 'cache-control: no-store' "${headers_file}" || { echo "Auth response for ${site} is not no-store." >&2; exit 1; }
  jq -e '.session == null' "${body_file}" >/dev/null
  echo "Anonymous auth session verified for ${site}."
done

test_address='bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
for site in punks pokedex; do
  for network in BITCOIN_MAINNET FRACTAL_BITCOIN_MAINNET; do
    payload="$(jq -n --arg site "${site}" --arg address "${test_address}" --arg network "${network}" '{site:$site,address:$address,network:$network}')"
    response="$(curl -fsS --retry 2 --max-time 20 -X POST "${BASE_URL}/api/auth/ownership/challenge" \
      -H 'Origin: https://demro-labs.github.io' -H 'Content-Type: application/json' --data-binary "${payload}")"
    printf '%s' "${response}" | jq -e --arg site "${site}" --arg network "${network}" '.site == $site and .network == $network and .action == "ownership-proof-only" and (.message | contains("does not authorize, sign, or broadcast a payment or transfer"))' >/dev/null
    echo "Ownership-only challenge verified for ${site} on ${network}."
  done
done

for site in punks pokedex; do
  payload="$(jq -n --arg site "${site}" --arg address "${test_address}" '{site:$site,address:$address,network:"BITCOIN_MAINNET"}')"
  response="$(curl -fsS --retry 2 --max-time 20 -X POST "${BASE_URL}/api/auth/challenge" \
    -H 'Origin: https://demro-labs.github.io' -H 'Content-Type: application/json' --data-binary "${payload}")"
  printf '%s' "${response}" | jq -e --arg site "${site}" '.site == $site and .network == "BITCOIN_MAINNET" and (.message | contains("Network: BITCOIN_MAINNET") and contains("No payment, transfer, or spending approval is authorized."))' >/dev/null
  echo "Bitcoin sign-in challenge verified for ${site}; no signature, session, or payment was created."
done

for origin in "https://demro-labs.github.io" "https://punksgallery-mlwdpcwl.manus.space"; do
  headers_file="${TMP_DIR}/preflight.headers"
  status="$(curl -sS --max-time 15 -D "${headers_file}" -o /dev/null -w '%{http_code}' -X OPTIONS \
    -H "Origin: ${origin}" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    "${BASE_URL}/api/auth/ownership/challenge" || true)"
  [[ "${status}" == "204" ]] || { echo "Auth preflight for ${origin} returned HTTP ${status}." >&2; exit 1; }
  grep -Fqi "access-control-allow-origin: ${origin}" "${headers_file}" || { echo "Auth preflight did not allow ${origin}." >&2; exit 1; }
  echo "Auth CORS preflight verified for ${origin}."
done

status="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST \
  "${BASE_URL}/api/inscribe/order" \
  -H 'Origin: https://demro-labs.github.io' \
  -H 'Content-Type: text/plain' \
  --data-binary 'pre-deploy-smoke-probe' || true)"
[[ "${status}" == "415" ]] || { echo "Inscribe order route returned HTTP ${status} for a safe non-JSON probe (expected 415)." >&2; exit 1; }
echo "Inscribe order route safely rejected non-JSON before creating an order."
