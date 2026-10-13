#!/usr/bin/env bash
# Budget tracker: builds the web app (if needed) and serves it with its API on http://localhost:8792.
#   ./scripts/run-app.sh            serve (builds app/dist when missing)
#   BUILD=1 ./scripts/run-app.sh    force a rebuild first
#   DEMO_SPEND=1 ./scripts/run-app.sh   overlay FAKE spend so the UI can be inspected (dev only; the app shows a banner)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

if [[ "${BUILD:-0}" == 1 || ! -f app/dist/index.html ]]; then
  (cd app && npm install --no-audit --no-fund >/dev/null && npx expo export -p web >/dev/null)
  echo "built app/dist"
fi
echo "Sign in with APP_ADMIN_PASSWORD from .env"
exec node api/server.mjs
