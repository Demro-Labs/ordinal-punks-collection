#!/usr/bin/env bash
set -Eeuo pipefail

HOST="127.0.0.1"
PORT="${WRANGLER_PORT:-8787}"
BASE="http://${HOST}:${PORT}"
TMP_DIR="$(mktemp -d)"
LOG_FILE="${TMP_DIR}/wrangler.log"
WORKER_PID=""

cleanup() {
  if [[ -n "${WORKER_PID}" ]]; then
    kill "${WORKER_PID}" 2>/dev/null || true
    wait "${WORKER_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

fail() {
  echo "Worker runtime smoke test failed: $*" >&2
  if [[ -f "${LOG_FILE}" ]]; then
    cat "${LOG_FILE}" >&2
  fi
  exit 1
}

pnpm dlx wrangler@4.150.0 dev --local --ip "${HOST}" --port "${PORT}" --log-level error >"${LOG_FILE}" 2>&1 &
WORKER_PID=$!

status="000"
for _ in $(seq 1 30); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 1 "${BASE}/" 2>/dev/null || true)"
  if [[ "${status}" == "404" ]]; then
    break
  fi
  if ! kill -0 "${WORKER_PID}" 2>/dev/null; then
    fail "Wrangler exited before the Worker became ready (HTTP ${status})"
  fi
  sleep 1
done
[[ "${status}" == "404" ]] || fail "expected the Worker root to load and return 404, got HTTP ${status}"

origin="https://demro-labs.github.io"
for site in punks pokedex; do
  headers_file="${TMP_DIR}/${site}.headers"
  body_file="${TMP_DIR}/${site}.json"
  status="$(curl -sS -D "${headers_file}" -o "${body_file}" -w '%{http_code}' --max-time 5 \
    -H "Origin: ${origin}" "${BASE}/api/auth/session?site=${site}" || true)"
  [[ "${status}" == "200" ]] || fail "GET auth session for ${site} returned HTTP ${status}"
  grep -Fqi "access-control-allow-origin: ${origin}" "${headers_file}" || fail "CORS origin missing for ${site}"
  node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); if (v.session !== null) process.exit(1);' <"${body_file}" || fail "expected an empty anonymous session for ${site}"
done

for origin in "https://demro-labs.github.io" "https://punksgallery-mlwdpcwl.manus.space"; do
  headers_file="${TMP_DIR}/preflight.headers"
  status="$(curl -sS -D "${headers_file}" -o /dev/null -w '%{http_code}' --max-time 5 -X OPTIONS \
    -H "Origin: ${origin}" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    "${BASE}/api/auth/challenge" || true)"
  [[ "${status}" == "204" ]] || fail "OPTIONS auth preflight for ${origin} returned HTTP ${status}"
  grep -Fqi "access-control-allow-origin: ${origin}" "${headers_file}" || fail "CORS preflight did not allow ${origin}"
done

echo "Worker runtime smoke passed: workerd starts; anonymous sessions work for punks and pokedex; both allowed origins pass CORS."
