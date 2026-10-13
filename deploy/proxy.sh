#!/usr/bin/env bash
# Open the private gateway and budget app on localhost using your own Google identity (you need roles/run.invoker,
# which Terraform grants to every admin and to extra_invokers).
#
#   gateway -> http://localhost:8891   what Claude Code signs in to (loopback passes its private-network check)
#   app     -> http://localhost:8892   the budget app
#
#   PROJECT_ID=my-project REGION=europe-west2 deploy/proxy.sh
#   or, from Terraform:  (cd terraform && terraform output -raw proxy_command | sh)
#   or give the URLs directly:  GATEWAY_URL=https://... APP_URL=https://... deploy/proxy.sh
#
# Uses proxy.mjs rather than `gcloud run services proxy`: that one overwrites the Authorization header, which carries the
# gateway session token. proxy.mjs sends X-Serverless-Authorization instead and binds to loopback only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_LOCAL_PORT="${GATEWAY_LOCAL_PORT:-8891}"
APP_LOCAL_PORT="${APP_LOCAL_PORT:-8892}"

if [[ -z "${GATEWAY_URL:-}" || -z "${APP_URL:-}" ]]; then
  : "${PROJECT_ID:?set PROJECT_ID, or GATEWAY_URL and APP_URL}"
  REGION="${REGION:-europe-west2}"
  GATEWAY_URL="${GATEWAY_URL:-$(gcloud run services describe claude-gateway --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')}"
  APP_URL="${APP_URL:-$(gcloud run services describe claude-budget-app --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')}"
fi
for u in "$GATEWAY_URL" "$APP_URL"; do [[ "$u" == https://*.run.app ]] || { echo "unexpected service URL: $u" >&2; exit 1; }; done

# Each proxy refuses to start when its port is busy, rejects requests that carry a foreign Origin or arrive as
# Sec-Fetch-Site: cross-site, and forwards only an allow-list of headers (see proxy.mjs). PROXY_REQUIRE_SECRET=header|path
# additionally requires a random per-run secret (printed at start-up). If either proxy stops, both are stopped.
trap 'kill 0' EXIT
node "$HERE/proxy.mjs" "$GATEWAY_URL" "$GATEWAY_LOCAL_PORT" &
P1=$!
node "$HERE/proxy.mjs" "$APP_URL" "$APP_LOCAL_PORT" &
P2=$!
while kill -0 "$P1" 2>/dev/null && kill -0 "$P2" 2>/dev/null; do sleep 1; done
echo "a proxy stopped (see the message above): stopping the other one" >&2
exit 1
