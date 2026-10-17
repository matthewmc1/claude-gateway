#!/usr/bin/env bash
# The enterprise edge on your laptop: the same TOPOLOGY as the deployed setup, with zero cloud access.
#
#   browser --http://app.localhost:19330--> IAP emulator --> budget app (APP_AUTH_MODE=iap, signed-JWT identity)
#   Claude Code --https://gateway.localhost:19331--> ILB emulator (TLS, throwaway CA) --> claude gateway (public_url = that https URL)
#                                                                                            └-> local IdP (sign-in) + Postgres
#
#   scripts/edge.sh up        generate certs/config, start everything, print URLs
#   scripts/edge.sh down      stop ONLY what `up` started (pids in data/edge/pids)
#   scripts/edge.sh status    what is running and answering, and the URLs
#   scripts/edge.sh test      the L6 end-to-end layer (needs Docker for a throwaway Postgres; `scripts/e2e.sh l6`)
#
# `up` needs: node 20+, the `claude` binary and `openssl` on PATH, and a Postgres: the compose one (scripts/setup.sh writes .env, then
# `docker compose up -d postgres`) or EDGE_POSTGRES_URL.
# The emulators are NOT Google (see docs/LOCAL-DEV.md): they prove our wiring, not Google's behaviour. Replies from the gateway are canned
# (load_test_mode), so no model, Google account or internet is needed. Postgres: the compose one on :15432 (own database `gateway_edge`),
# or EDGE_POSTGRES_URL=postgres://... for any other. Everything generated lives in data/edge/ (gitignored). Ports: see EDGE_* below.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
D="$ROOT/data/edge"; PIDS="$D/pids"; LOGS="$D/logs"
export EDGE_APP_PORT="${EDGE_APP_PORT:-19330}" EDGE_GATEWAY_PORT="${EDGE_GATEWAY_PORT:-19331}" EDGE_IDP_PORT="${EDGE_IDP_PORT:-19332}"
export EDGE_GATEWAY_INTERNAL_PORT="${EDGE_GATEWAY_INTERNAL_PORT:-19333}" EDGE_APP_INTERNAL_PORT="${EDGE_APP_INTERNAL_PORT:-19334}"
APP_URL="http://app.localhost:$EDGE_APP_PORT"; GW_URL="https://gateway.localhost:$EDGE_GATEWAY_PORT"
PORTS=("$EDGE_APP_PORT" "$EDGE_GATEWAY_PORT" "$EDGE_IDP_PORT" "$EDGE_GATEWAY_INTERNAL_PORT" "$EDGE_APP_INTERNAL_PORT")

say() { printf '%s\n' "$*"; }
die() { printf 'edge: %s\n' "$*" >&2; exit 1; }
# what each tracked process must look like, so `down` never signals a recycled pid
expect() { case "$1" in idp) echo 'idp-emulator.mjs';; ilb) echo 'ilb-emulator.mjs';; iap) echo 'iap-emulator.mjs';; app) echo 'api/server.mjs';; gateway) echo 'claude';; esac; }
alive() { local p="$2"; kill -0 "$p" 2>/dev/null && ps -p "$p" -o command= 2>/dev/null | grep -q -- "$(expect "$1")"; }
running_names() { [ -f "$PIDS" ] || return 0; while read -r n p; do [ -n "${p:-}" ] && alive "$n" "$p" && echo "$n"; done <"$PIDS"; }

start() {  # start <name> <command...>: background, logs to data/edge/logs/<name>.log, pid recorded
  local n="$1"; shift
  nohup "$@" >>"$LOGS/$n.log" 2>&1 &
  echo "$n $!" >>"$PIDS"
}
wait_for() {  # wait_for <label> <seconds> <command...>
  local label="$1" secs="$2"; shift 2
  for _ in $(seq 1 $((secs*4))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.25; done
  say "edge: $label did not become ready; see $LOGS/" >&2; return 1
}

cmd_up() {
  command -v node >/dev/null || die "node not found"
  command -v claude >/dev/null || die "the claude binary is not on PATH (it runs the gateway)"
  command -v openssl >/dev/null || die "openssl not found"
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node 20+ required"
  if [ -n "$(running_names)" ]; then die "already running ($(running_names | tr '\n' ' ')): run scripts/edge.sh down first"; fi
  for p in "${PORTS[@]}"; do lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && die "port $p is in use (override with EDGE_APP_PORT, EDGE_GATEWAY_PORT, EDGE_IDP_PORT, EDGE_GATEWAY_INTERNAL_PORT, EDGE_APP_INTERNAL_PORT)"; done
  mkdir -p "$LOGS" "$D/home"; chmod 700 "$D"; : >"$PIDS"

  if [ -z "${EDGE_POSTGRES_URL:-}" ]; then
    [ -f .env ] || die "no .env (run scripts/setup.sh) and no EDGE_POSTGRES_URL"
    local pw; pw="$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)"; [ -n "$pw" ] || die "POSTGRES_PASSWORD is not in .env"
    docker compose ps --status running postgres 2>/dev/null | grep -q postgres || die "the compose Postgres is not running (docker compose up -d postgres), or set EDGE_POSTGRES_URL"
    docker compose exec -T postgres psql -U gw -d gateway -tc "SELECT 1 FROM pg_database WHERE datname='gateway_edge'" | grep -q 1 \
      || docker compose exec -T postgres psql -U gw -d gateway -c "CREATE DATABASE gateway_edge" >/dev/null || die "could not create database gateway_edge"
    export EDGE_POSTGRES_URL="postgres://gw:${pw}@127.0.0.1:15432/gateway_edge"
  fi
  bash scripts/edge/make-certs.sh "$D" >/dev/null || die "certificate generation failed"
  node scripts/edge/prepare.mjs "$D" >/dev/null || die "could not render the config"
  # shellcheck disable=SC1091
  . "$D/edge.env"
  [ -f app/dist/index.html ] || { say "building app/dist (first run)"; (cd app && npm install --no-audit --no-fund >/dev/null && npx expo export -p web >/dev/null) || die "app build failed"; }

  start idp node scripts/edge/idp-emulator.mjs --port "$EDGE_IDP_PORT" --users "$EDGE_USERS_RESOLVED" --redirect-origin "$GW_URL"
  start gateway env -i PATH="$PATH" HOME="$D/home" CLAUDE_CONFIG_DIR="$D/home/cc" CLAUDE_GATEWAY_ALLOW_LOOPBACK=1 CLAUDE_GATEWAY_LOG_LEVEL=info GOOGLE_APPLICATION_CREDENTIALS="$EDGE_ADC" \
    claude gateway --config "$D/gateway.yaml"
  start ilb node scripts/edge/ilb-emulator.mjs --port "$EDGE_GATEWAY_PORT" --upstream "http://127.0.0.1:$EDGE_GATEWAY_INTERNAL_PORT" --cert-dir "$D" ${EDGE_ALLOW_CIDRS:+--allow-cidr "$EDGE_ALLOW_CIDRS"}
  start iap node scripts/edge/iap-emulator.mjs --port "$EDGE_APP_PORT" --upstream "http://127.0.0.1:$EDGE_APP_INTERNAL_PORT" --audience "$EDGE_AUDIENCE" --users "$EDGE_USERS_RESOLVED"
  start app bash -c "set -a; . '$D/app.env'; set +a; exec node api/server.mjs"

  wait_for "the gateway behind the load-balancer emulator" 40 curl -fs --max-time 2 --cacert "$D/ca.pem" "$GW_URL/readyz" || { cmd_down >/dev/null; exit 1; }
  wait_for "the app" 20 curl -fs --max-time 2 "http://127.0.0.1:$EDGE_APP_INTERNAL_PORT/healthz" || { cmd_down >/dev/null; exit 1; }
  say "The enterprise edge is up (emulated: not Google; replies are canned, nothing leaves this machine)."
  say ""
  say "  Budget app   $APP_URL   (IAP emulator sign-in: pick an email. Admins: $EDGE_ADMINS_RESOLVED. Everyone else listed is a viewer: $EDGE_USERS_RESOLVED)"
  say "  Gateway      $GW_URL   (https, throwaway CA: $D/ca.pem)"
  say "  Local IdP    http://127.0.0.1:$EDGE_IDP_PORT   (device sign-in: pick alice@example.com or bob@example.com)"
  say "  Logs         $LOGS/      Secrets (mode 600)  $D/secrets.json"
  say ""
  say "  Try Claude Code against it (isolated config; trust the CA for this one process):"
  say "    NODE_EXTRA_CA_CERTS=$D/ca.pem GATEWAY_URL=$GW_URL ./scripts/claude-dev.sh      # unverified with the real Claude Code binary"
  say "  Probe from the shell:   curl --cacert $D/ca.pem $GW_URL/readyz      curl -i $APP_URL/   (302 to the sign-in page)"
  say "  Stop:   scripts/edge.sh down        Test:   scripts/edge.sh test"
}

cmd_down() {
  [ -f "$PIDS" ] || { say "edge: nothing to stop (no $PIDS)"; return 0; }
  local n p
  while read -r n p; do
    [ -n "${p:-}" ] || continue
    if alive "$n" "$p"; then kill "$p" 2>/dev/null; else say "edge: $n (pid $p) is not running (or the pid was reused): not touching it"; fi
  done <"$PIDS"
  for _ in $(seq 1 32); do [ -z "$(running_names)" ] && break; sleep 0.25; done
  while read -r n p; do [ -n "${p:-}" ] && alive "$n" "$p" && { say "edge: $n did not stop, killing pid $p"; kill -9 "$p" 2>/dev/null; }; done <"$PIDS"
  rm -f "$PIDS"; say "edge: stopped (the gateway_edge database and data/edge/ are kept)"
}

cmd_status() {
  local up; up="$(running_names | tr '\n' ' ')"
  if [ -z "$up" ]; then say "edge: not running (start it with scripts/edge.sh up; it would listen on app $APP_URL, gateway $GW_URL)"; return 1; fi
  say "processes: $up"
  say "URLs:      app $APP_URL   gateway $GW_URL   (CA: $D/ca.pem)   IdP http://127.0.0.1:$EDGE_IDP_PORT"
  say "app (through the IAP emulator, signed out):  $(curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' --max-time 3 "$APP_URL/" || echo unreachable)   (302 to the sign-in page is right)"
  say "app (direct, bypassing IAP, /healthz):       $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$EDGE_APP_INTERNAL_PORT/healthz" || echo unreachable)"
  say "app (direct, no JWT, /api/users):            $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$EDGE_APP_INTERNAL_PORT/api/users" || echo unreachable)   (401 is right)"
  say "gateway (https, generated CA, /readyz):      $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 --cacert "$D/ca.pem" "$GW_URL/readyz" || echo unreachable)"
  if curl -s -o /dev/null --max-time 3 "$GW_URL/readyz" 2>/dev/null; then say "gateway (https, no CA):                      answered WITHOUT a trusted CA (unexpected)"; else say "gateway (https, no CA):                      refused (untrusted certificate: right)"; fi
  say "IdP discovery:                               $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$EDGE_IDP_PORT/.well-known/openid-configuration" || echo unreachable)"
}

case "${1:-}" in
  up) cmd_up;;
  down) cmd_down;;
  status) cmd_status;;
  test) shift; exec bash scripts/e2e.sh l6 "$@";;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2;;
esac
