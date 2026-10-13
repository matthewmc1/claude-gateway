#!/usr/bin/env bash
# Try the app in under a minute: built-in sample data, no gateway, cloud account or credentials needed.
#   ./scripts/demo.sh            http://localhost:8792   (sign in as admin@example.com / demo-admin to change things)
#   PORT=9000 ./scripts/demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f app/dist/index.html ]]; then
  echo "building the web app (first run only, about a minute)..."
  (cd app && npm install --no-audit --no-fund >/dev/null && npx expo export -p web >/dev/null)
fi
echo "Demo with SAMPLE DATA on http://localhost:${PORT:-8792}  ·  admin sign-in: admin@example.com / demo-admin"
APP_DEMO=1 APP_PORT="${PORT:-8792}" exec node api/server.mjs
