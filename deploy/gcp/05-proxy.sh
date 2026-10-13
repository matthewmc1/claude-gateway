#!/usr/bin/env bash
# Open both private services on localhost using your own Google identity (project owners have run.invoker).
#   gateway -> http://localhost:8891   (what Claude Code signs in to; loopback passes its private-network check)
#   app     -> http://localhost:8892   (budget app; password: gcloud secrets versions access latest --secret=claude-budget-app-password)
# Uses proxy.mjs rather than `gcloud run services proxy`: that one overwrites the Authorization header, which carries
# the gateway session token, and needs an extra gcloud component. proxy.mjs sends X-Serverless-Authorization instead.
set -euo pipefail
cd "$(dirname "$0")"; source env.sh
GW="$(gcloud run services describe claude-gateway --region="$REGION" --format='value(status.url)')"
APP="$(gcloud run services describe claude-budget-app --region="$REGION" --format='value(status.url)')"
trap 'kill 0' EXIT
node proxy.mjs "$GW" "$GATEWAY_LOCAL_PORT" &
node proxy.mjs "$APP" "$APP_LOCAL_PORT" &
wait
