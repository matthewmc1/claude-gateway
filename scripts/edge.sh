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
#   scripts/edge.sh check     a curl walk-through with PASS/FAIL per step (sign in as admin and viewer, writes, CSRF, tampered tokens, TLS, /readyz)
#   scripts/edge.sh claude    Claude Code (isolated config dir, throwaway CA trusted for this one process) pointed at the https gateway
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
is_up() { case " $(running_names | tr '\n' ' ') " in *" $1 "*) return 0;; esac; return 1; }
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
  say "  WHAT TO DO NEXT (copy/paste):"
  say "   1. Browser:  open $APP_URL  -> the IAP emulator asks who you are -> pick ada@example.com (admin: can change budgets) or bob@example.com (viewer: read-only)."
  say "                Change a budget as bob: refused (403). As ada: saved. Add ?secure_token_test=bad-signature to a URL: the app answers 401 (tampered token)."
  say "                A real browser trusts *.localhost already; no hosts-file edit. The browser needs no CA for the app (plain http), only the gateway is https."
  say "   2. Shell:    scripts/edge.sh check          # the same flow with curl, PASS/FAIL per step"
  say "   3. Claude Code against the https gateway (isolated config; your real ~/.claude and .claude-test are untouched):"
  say "                scripts/edge.sh claude         # then /login -> Cloud gateway -> sign in as alice@example.com or bob@example.com on the IdP page"
  say "                (or by hand: CLAUDE_CONFIG_DIR=<dir with settings.json forceLoginGatewayUrl=$GW_URL> NODE_EXTRA_CA_CERTS=$D/ca.pem claude)"
  say "                Browser opened by /login shows the gateway page over https: your browser warns about the throwaway CA unless you trust $D/ca.pem"
  say "                (macOS: Keychain Access -> import -> set 'Always trust'; or just click through the warning for this local test)."
  say "   4. Probe:    curl --cacert $D/ca.pem $GW_URL/readyz      curl -i $APP_URL/   (302 to the sign-in page)"
  say "  Stop:   scripts/edge.sh down        Full automated test:   scripts/edge.sh test"
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

cmd_claude() {
  is_up gateway || die "the edge is not running (scripts/edge.sh up)"
  command -v claude >/dev/null || die "the claude binary is not on PATH"
  local cfg="$D/claude-config"; mkdir -p "$cfg"
  printf '{\n  "forceLoginMethod": "gateway",\n  "forceLoginGatewayUrl": "%s"\n}\n' "$GW_URL" >"$cfg/settings.json"
  unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_BEDROCK
  say "edge: Claude Code with config dir $cfg, gateway $GW_URL, extra CA $D/ca.pem (this process only). /login -> Cloud gateway."
  CLAUDE_CONFIG_DIR="$cfg" NODE_EXTRA_CA_CERTS="$D/ca.pem" exec claude "$@"
}

# A curl walk-through of the whole edge. Each line says what it proves; see docs/LOCAL-DEV.md for what it cannot prove about real Google.
cmd_check() {
  is_up app || die "the edge is not running (scripts/edge.sh up)"
  local ok=0 bad=0 jar_a jar_v body; jar_a="$(mktemp)"; jar_v="$(mktemp)"
  trap 'rm -f "$jar_a" "$jar_v"' RETURN
  local ADMIN VIEWER; ADMIN="$(printf '%s' "$EDGE_ADMINS_RESOLVED" | cut -d, -f1)"
  VIEWER="$(printf '%s' "$EDGE_USERS_RESOLVED" | tr ',' '\n' | grep -vxF "$ADMIN" | head -1)"
  [ -n "$ADMIN" ] && [ -n "$VIEWER" ] || die "could not work out an admin and a viewer (EDGE_ADMINS / EDGE_USERS)"
  t() {  # t <label> <expected code> <curl args...>
    local label="$1" want="$2"; shift 2
    local got; got="$(curl -s -o "$D/check.body" -w '%{http_code}' --max-time 8 "$@" 2>/dev/null)"; got="${got:-000}"
    if [ "$got" = "$want" ]; then ok=$((ok+1)); printf '  PASS  %-4s %s\n' "$got" "$label"; else bad=$((bad+1)); printf '  FAIL  got %s, want %s: %s\n        %s\n' "$got" "$want" "$label" "$(head -c 200 "$D/check.body" 2>/dev/null)"; fi
  }
  local W=(-H "origin: $APP_URL" -H 'x-app-csrf: 1' -H 'sec-fetch-site: same-origin' -H 'content-type: application/json')
  local B='{"period":"weekly","action":"set","usd":25}'
  say "IAP emulator and app (iap mode): $APP_URL"
  t "signed out, browser navigation: redirected to the emulator's sign-in page" 302 "$APP_URL/"
  t "signed out, API call (Accept: application/json): 401 from the emulator, like IAP answers a non-browser caller" 401 "$APP_URL/api/health" -H 'accept: application/json'
  t "bypassing IAP (straight at the app, forged unsigned x-goog-* headers): 401" 401 "http://127.0.0.1:$EDGE_APP_INTERNAL_PORT/api/health" -H "x-goog-authenticated-user-email: accounts.google.com:$ADMIN"
  t "sign in as $ADMIN (admin)" 302 -c "$jar_a" -X POST "$APP_URL/_iap/signin" -H "origin: $APP_URL" --data-urlencode "email=$ADMIN" --data-urlencode "next=/"
  t "sign in as $VIEWER (viewer)" 302 -c "$jar_v" -X POST "$APP_URL/_iap/signin" -H "origin: $APP_URL" --data-urlencode "email=$VIEWER" --data-urlencode "next=/"
  t "admin reads /api/company" 200 -b "$jar_a" "$APP_URL/api/company"
  t "viewer reads /api/company (read-only access is allowed)" 200 -b "$jar_v" "$APP_URL/api/company"
  t "admin WRITE (org budget) with same-origin proof + CSRF header: allowed" 200 -b "$jar_a" -X PUT "$APP_URL/api/org/budget" "${W[@]}" --data "$B"
  t "viewer WRITE: 403 only admins can do this" 403 -b "$jar_v" -X PUT "$APP_URL/api/org/budget" "${W[@]}" --data "$B"
  t "admin write from another site (Origin evil, Sec-Fetch-Site cross-site): 403" 403 -b "$jar_a" -X PUT "$APP_URL/api/org/budget" -H "origin: http://evil.localhost:1" -H 'x-app-csrf: 1' -H 'sec-fetch-site: cross-site' -H 'content-type: application/json' --data "$B"
  t "admin write without the CSRF header: 403" 403 -b "$jar_a" -X PUT "$APP_URL/api/org/budget" -H "origin: $APP_URL" -H 'content-type: application/json' --data "$B"
  t "cross-site READ (Sec-Fetch-Site cross-site): 403" 403 -b "$jar_a" "$APP_URL/api/company" -H 'sec-fetch-site: cross-site'
  local k; for k in bad-signature expired wrong-aud wrong-iss wrong-alg unknown-kid too-long no-email garbage none; do
    t "tampered token ($k): 401" 401 -b "$jar_a" "$APP_URL/api/company?secure_token_test=$k"
  done
  say "Gateway behind the load-balancer emulator (TLS, throwaway CA): $GW_URL"
  t "https /readyz with the generated CA: 200" 200 --cacert "$D/ca.pem" "$GW_URL/readyz"
  t "https /healthz with the generated CA: 200" 200 --cacert "$D/ca.pem" "$GW_URL/healthz"
  t "https WITHOUT the CA: refused (curl exit 60 shows as 000)" 000 "$GW_URL/readyz"
  t "a name the certificate does not cover (other.localhost): refused" 000 --cacert "$D/ca.pem" "https://other.localhost:$EDGE_GATEWAY_PORT/readyz"
  t "TLS 1.1 only: refused" 000 --cacert "$D/ca.pem" --tls-max 1.1 "$GW_URL/readyz"
  t "plain http to the https port: no answer" 000 --max-time 3 "http://gateway.localhost:$EDGE_GATEWAY_PORT/readyz"
  say ""
  say "check: $ok passed, $bad failed.  The last admin write set the organisation weekly default to 25 USD in the local gateway_edge database only."
  say "Not proven (needs a real deployment): Google's signing keys and audience strings, the real consent screen, the real internal Application Load Balancer, Claude Code's certificate pinning."
  [ "$bad" -eq 0 ]
}

case "${1:-}" in
  up) cmd_up;;
  down) cmd_down;;
  status) cmd_status;;
  check) shift; [ -f "$D/edge.env" ] && . "$D/edge.env"; cmd_check;;
  claude) shift; cmd_claude "$@";;
  test) shift; exec bash scripts/e2e.sh l6 "$@";;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2;;
esac
