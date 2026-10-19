#!/usr/bin/env bash
set -Eeuo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be provided by the GitHub environment}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be provided by the GitHub environment}"

BASE_URL="https://fractal-ordinal-live.servostar23.workers.dev"
SCRIPT_API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/fractal-ordinal-live"
AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

# The auth challenge limiter allows only six challenges per address per hour.
# Generate a valid, fresh address so every production verification run is
# independent from previous deployments and never reuses a rate-limited one.
test_address="$(node --input-type=module <<'NODE'
import { randomBytes } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";

bitcoin.initEccLib(ecc);
let privateKey;
do {
  privateKey = randomBytes(32);
} while (!ecc.isPrivate(privateKey));

const publicKey = ecc.pointFromScalar(privateKey, true);
const payment = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: bitcoin.networks.bitcoin });
if (!payment.address) throw new Error("Could not generate a valid smoke-test address");
console.log(payment.address);
NODE
)"
echo "Generated a fresh valid smoke-test address for this verification run."

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

# Exercise the UniSat-backed read routes that previously failed across both sites.
# A fresh address avoids wallet-specific assumptions and these GETs cannot sign or broadcast.
for network in BITCOIN_MAINNET FRACTAL_BITCOIN_MAINNET; do
  encoded_address="${test_address}"
  for route in \
    "/api/transactions/history?address=${encoded_address}&chain=${network}&cursor=0&size=1" \
    "/api/brc20/balances?address=${encoded_address}&chain=${network}" \
    "/api/brc20/transferable?address=${encoded_address}&ticker=ordi&chain=${network}" \
    "/api/ordinals/address-list?address=${encoded_address}&chain=${network}&start=0&limit=1" \
    "/api/runes/balance-list?address=${encoded_address}&chain=${network}&start=0&limit=1" \
    "/api/alkanes/balances?address=${encoded_address}&chain=${network}"; do
    payload_file="${TMP_DIR}/read-route.json"
    status="$(curl -sS --max-time 20 -o "${payload_file}" -w '%{http_code}' \
      -H 'Origin: https://demro-labs.github.io' "${BASE_URL}${route}" || true)"
    if [[ "${status}" != "200" ]]; then
      route_path="${route%%\?*}"
      echo "Live UniSat read route ${route_path} on ${network} returned HTTP ${status}: $(jq -c '{error,code}' "${payload_file}" 2>/dev/null || true)" >&2
      exit 1
    fi
    jq -e --arg network "${network}" '.network == $network' "${payload_file}" >/dev/null || {
      echo "Live UniSat read route returned an unexpected network payload for ${network}." >&2
      exit 1
    }
    echo "Live read route ${route%%\?*} verified for ${network}."
  done
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

for site in punks pokedex; do
  for network in BITCOIN_MAINNET FRACTAL_BITCOIN_MAINNET; do
    payload="$(jq -n --arg site "${site}" --arg address "${test_address}" --arg network "${network}" '{site:$site,address:$address,network:$network}')"
    headers_file="${TMP_DIR}/${site}-${network}.headers"
    response_file="${TMP_DIR}/${site}-${network}.json"
    status="$(curl -sS --retry 0 --max-time 20 -D "${headers_file}" -o "${response_file}" -w '%{http_code}' -X POST "${BASE_URL}/api/auth/ownership/challenge" \
      -H 'Origin: https://demro-labs.github.io' -H 'Content-Type: application/json' --data-binary "${payload}" || true)"
    if [[ "${status}" == "429" ]]; then
      retry_after="$(awk 'BEGIN { IGNORECASE=1 } /^Retry-After:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]]+$/, ""); print; exit }' "${headers_file}")"
      echo "Ownership challenge for ${site} on ${network} returned HTTP 429; not retrying${retry_after:+ (Retry-After: ${retry_after})}." >&2
      exit 1
    fi
    [[ "${status}" == "200" ]] || { echo "Ownership challenge for ${site} on ${network} returned HTTP ${status}." >&2; exit 1; }
    response="$(cat "${response_file}")"
    printf '%s' "${response}" | jq -e --arg site "${site}" --arg network "${network}" '.site == $site and .network == $network and .action == "ownership-proof-only" and (.message | contains("does not authorize, sign, or broadcast a payment or transfer"))' >/dev/null
    echo "Ownership-only challenge verified for ${site} on ${network}."
  done
done

for site in punks pokedex; do
  payload="$(jq -n --arg site "${site}" --arg address "${test_address}" '{site:$site,address:$address,network:"BITCOIN_MAINNET"}')"
  headers_file="${TMP_DIR}/${site}-bitcoin-signin.headers"
  response_file="${TMP_DIR}/${site}-bitcoin-signin.json"
  status="$(curl -sS --retry 0 --max-time 20 -D "${headers_file}" -o "${response_file}" -w '%{http_code}' -X POST "${BASE_URL}/api/auth/challenge" \
    -H 'Origin: https://demro-labs.github.io' -H 'Content-Type: application/json' --data-binary "${payload}" || true)"
  if [[ "${status}" == "429" ]]; then
    retry_after="$(awk 'BEGIN { IGNORECASE=1 } /^Retry-After:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]]+$/, ""); print; exit }' "${headers_file}")"
    echo "Bitcoin sign-in challenge for ${site} returned HTTP 429; not retrying${retry_after:+ (Retry-After: ${retry_after})}." >&2
    exit 1
  fi
  [[ "${status}" == "200" ]] || { echo "Bitcoin sign-in challenge for ${site} returned HTTP ${status}." >&2; exit 1; }
  response="$(cat "${response_file}")"
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
