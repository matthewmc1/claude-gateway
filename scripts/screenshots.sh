#!/usr/bin/env bash
# Regenerate docs/screenshots/*.png from the built-in demo data (APP_DEMO=1; no gateway, cloud or credentials needed).
# Needs Google Chrome and a built app (cd app && npx expo export -p web). Boots the demo on a spare port, creates two
# temporary on-call boosts through the real API so the screenshots show them, then captures each page.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME" ]] || { echo "set CHROME to a Chrome/Chromium binary"; exit 1; }
[[ -f app/dist/index.html ]] || (cd app && npm install --no-audit --no-fund >/dev/null && npx expo export -p web >/dev/null)
PORT="${PORT:-19192}"; OUT="docs/screenshots"; mkdir -p "$OUT"

APP_DEMO=1 APP_PORT="$PORT" node api/server.mjs >/dev/null 2>&1 & PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sf "localhost:$PORT/api/health" >/dev/null && break; sleep 0.25; done

TOKEN=$(curl -s -X POST "localhost:$PORT/api/login" -H 'content-type: application/json' -d '{"email":"admin@example.com","password":"demo-admin"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
iso() { python3 -c "import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=float(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%S.000Z'))" "$1"; }
boost() { curl -s -X POST "localhost:$PORT/api/overrides" -H "x-app-token: $TOKEN" -H 'content-type: application/json' -d "$1" >/dev/null; }
boost "{\"sub\":\"demo-ben\",\"period\":\"weekly\",\"extraUsd\":75,\"endsAt\":\"$(iso 6)\",\"reason\":\"On-call rotation: incident response week\"}"
boost "{\"sub\":\"demo-gus\",\"period\":\"monthly\",\"extraUsd\":150,\"startsAt\":\"$(iso 2)\",\"endsAt\":\"$(iso 9)\",\"reason\":\"Launch week: migration sprint\"}"

shot() {  # shot <file> <theme> <hash> [width] [height]
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size="${4:-1440},${5:-1000}" --virtual-time-budget=15000 \
    --screenshot="$OUT/$1.png" "http://127.0.0.1:$PORT/?theme=$2#$3" >/dev/null 2>&1
  echo "  $OUT/$1.png"
}
shot people          dark  /people
shot my-usage        dark  /my-usage
shot person-boost    dark  /people/demo-ben 1440 1500
shot company         dark  /company 1440 1300
shot models          dark  /models
shot activity        dark  /activity
shot people-light    light /people
shot my-usage-light  light /my-usage
echo "done"
