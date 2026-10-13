#!/usr/bin/env bash
# End-to-end suite: the REAL gateway binary (`claude gateway`) against a throwaway Postgres and a fake OIDC issuer,
# exercised by the budget app, the usage-log parsers and the installer. Everything is hermetic and torn down afterwards.
#
#   scripts/e2e.sh              run every layer (L1 twin fidelity, L2 log formats, L3 app+gateway, L4 installer, L5 operations)
#   scripts/e2e.sh l1 l3        run only the named layers (files tests/e2e/l*.test.mjs whose name starts with the argument)
#   E2E_KEEP=1 scripts/e2e.sh   keep the temp dir (logs, config) for debugging; the container is still removed
#   E2E_TMPDIR=/some/dir        where the temp dir is created (default: $TMPDIR or /tmp)
#
# Needs: docker (one container, gw-e2e-pg on 127.0.0.1:19160), the `claude` binary on PATH, node 20+, python3.
# Uses only ports 19160-19189. Never contacts the internet. Exit code 0 = everything passed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_NAME=gw-e2e-pg; PG_PORT=19160
PORT_LIST=(19160 19161 19162 19163 19164 19165 19166)
START=$(date +%s)
T=""; PIDS=(); STARTED_PG=0

say() { printf '%s\n' "$*"; }
die() { printf 'e2e: %s\n' "$*" >&2; exit 2; }

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null; done
  if [ "$STARTED_PG" = 1 ]; then docker rm -f "$PG_NAME" >/dev/null 2>&1; fi
  if [ -n "$T" ] && [ "${E2E_KEEP:-0}" != 1 ]; then rm -rf "$T"; elif [ -n "$T" ]; then say "kept: $T"; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || die "docker not found"
command -v claude >/dev/null || die "the claude binary is not on PATH (it runs the gateway)"
command -v node >/dev/null || die "node not found"
command -v python3 >/dev/null || die "python3 not found (the installer needs it)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node 20+ required"
for p in "${PORT_LIST[@]}"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then die "port $p is already in use; refusing to run"; fi
done
if docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then die "a container named $PG_NAME already exists (leftover from a crashed run?). Remove it: docker rm -f $PG_NAME"; fi

BASE="${E2E_TMPDIR:-${TMPDIR:-/tmp}}"; mkdir -p "$BASE"
T="$(mktemp -d "$BASE/gw-e2e.XXXXXX")" || die "cannot create a temp dir"; T="$(cd "$T" && pwd -P)"; chmod 700 "$T"

# ---- Postgres (the one permitted container) ----
export E2E_PG_PASSWORD; E2E_PG_PASSWORD="$(openssl rand -hex 12)"
docker run -d --rm --name "$PG_NAME" -p 127.0.0.1:$PG_PORT:5432 -e POSTGRES_PASSWORD="$E2E_PG_PASSWORD" postgres:16-alpine >/dev/null || die "could not start the postgres container"
STARTED_PG=1
ok=0
for _ in $(seq 1 80); do
  if docker exec "$PG_NAME" psql -h 127.0.0.1 -U postgres -tAc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ "$ok" -ge 2 ] && break; else ok=0; fi
  sleep 0.5
done
[ "$ok" -ge 2 ] || die "postgres did not become ready"
for db in gateway_main gateway_ops gateway_vertex; do docker exec "$PG_NAME" psql -h 127.0.0.1 -U postgres -qc "CREATE DATABASE $db" >/dev/null || die "could not create database $db"; done

# ---- config + secrets, fake OIDC issuer, the real gateway ----
node "$ROOT/tests/e2e/lib/prepare.mjs" "$T" || die "could not prepare the stack config"
set -a; . "$T/stack.env"; set +a
node "$ROOT/tests/e2e/lib/oidc.mjs" "$E2E_OIDC_PORT" >"$T/oidc.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 40); do curl -fs --max-time 1 "http://127.0.0.1:$E2E_OIDC_PORT/.well-known/openid-configuration" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fs --max-time 1 "http://127.0.0.1:$E2E_OIDC_PORT/.well-known/openid-configuration" >/dev/null 2>&1 || die "fake OIDC issuer did not start"

mkdir -p "$T/home-main"
env -i PATH="$PATH" HOME="$T/home-main" CLAUDE_CONFIG_DIR="$T/home-main/cc" CLAUDE_GATEWAY_ALLOW_LOOPBACK=1 CLAUDE_GATEWAY_LOG_LEVEL=info GOOGLE_APPLICATION_CREDENTIALS="$E2E_FAKE_ADC" \
  claude gateway --config "$T/gateway-main.yaml" >/dev/null 2>"$E2E_GW_LOG" & PIDS+=($!)
for _ in $(seq 1 80); do curl -fs --max-time 1 "$E2E_GW_URL/readyz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fs --max-time 1 "$E2E_GW_URL/readyz" >/dev/null 2>&1 || { tail -n 15 "$E2E_GW_LOG" | cut -c1-300 >&2; die "the gateway did not become ready"; }
say "stack up: postgres :$PG_PORT, fake oidc :$E2E_OIDC_PORT, gateway :$E2E_GW_PORT (load_test_mode), temp $T"

# ---- run the tests ----
cd "$ROOT" || exit 2
FILES=()
if [ $# -eq 0 ]; then for f in tests/e2e/*.test.mjs; do FILES+=("$f"); done
else for a in "$@"; do for f in tests/e2e/"$a"*.test.mjs; do [ -e "$f" ] && FILES+=("$f"); done; done; fi
[ ${#FILES[@]} -gt 0 ] || die "no test files match: $*"
node --test --test-concurrency=1 --test-timeout=150000 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap --test-reporter-destination="$T/report.tap" \
  --test-reporter=junit --test-reporter-destination="$T/report.xml" "${FILES[@]}"
RC=$?

# ---- summary ----
# leaf tests only (node's own tallies also count every describe block as a "test")
TOTALS="$(python3 -I - "$T/report.tap" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding="utf8").read().splitlines()
res = [(len(l) - len(l.lstrip(" ")), l.lstrip().startswith("ok"), i) for i, l in enumerate(lines) if re.match(r"^ *(not )?ok \d+ - ", l)]
leaf = p = f = 0
last = {}
for ind, ok, i in res:
    prev = last.get(ind, -1)
    suite = any(re.match(r"^ {%d}# Subtest:" % (ind + 4), lines[j]) for j in range(prev + 1, i))
    last[ind] = i
    if suite: continue
    leaf += 1; p += ok; f += (not ok)
print(f"{leaf} tests, {p} passed, {f} failed")
PY
)"
KNOWN="$(grep -E '^ *not ok [0-9]+ - known-bug:' "$T/report.tap" | sed -E 's/^ *not ok [0-9]+ - //' | sort -u)"
END=$(date +%s)
say ""
say "================ e2e summary ================"
say "files:   ${FILES[*]}"
say "tallies: ${TOTALS:-n/a}"
say "time:    $((END-START))s"
if [ -n "$KNOWN" ]; then say "known product bugs reproduced by failing tests (named known-bug:):"; printf '%s\n' "$KNOWN" | sed 's/^/  - /'; fi
if [ "$RC" -eq 0 ]; then say "RESULT: PASS"; else say "RESULT: FAIL (exit $RC)"; fi
exit "$RC"
