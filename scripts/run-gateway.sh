#!/usr/bin/env bash
# Runs the Claude apps gateway natively on this machine (macOS is supported for
# local dev; production runs the Linux binary in a container, see README).
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${VERTEX_PROJECT_ID:?set VERTEX_PROJECT_ID in .env}"

if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "No usable Application Default Credentials. Run: gcloud auth application-default login" >&2
  exit 1
fi

db=gateway
cfg=config/gateway.yaml
if [[ "${LOAD_TEST:-0}" == "1" ]]; then
  # Canned replies, no Vertex call. Uses a SEPARATE database so fake spend can
  # never touch real caps or the real ledger. Audit events carry load_test:true.
  db=gateway_loadtest
  cfg=.gateway.loadtest.yaml
  cp config/gateway.yaml "$cfg"
  printf '\nload_test_mode:\n  enabled: true\n  reply_tokens: 300\n  reply_seconds: 0\n' >> "$cfg"
  docker compose exec -T postgres psql -U gw -d gateway -tc "SELECT 1 FROM pg_database WHERE datname='gateway_loadtest'" | grep -q 1 \
    || docker compose exec -T postgres psql -U gw -d gateway -c "CREATE DATABASE gateway_loadtest" >/dev/null
  echo "*** LOAD TEST MODE: replies are canned, no model is called ***" >&2
fi
export GATEWAY_POSTGRES_URL="postgres://gw:${POSTGRES_PASSWORD}@localhost:15432/${db}"
# The collector is on loopback; the gateway's SSRF guard blocks that by default.
export CLAUDE_GATEWAY_ALLOW_LOOPBACK=1
export CLAUDE_GATEWAY_LOG_LEVEL="${CLAUDE_GATEWAY_LOG_LEVEL:-info}"

mkdir -p logs
# Operational log -> stderr, audit events are JSON lines (evt field). Keep both.
exec claude gateway --config "$cfg" 2> >(tee -a logs/gateway.log >&2)
