#!/usr/bin/env bash
# Test suite for the engineer installer (client/claude-gateway-setup.sh) and scripts/package-client.sh.
# Plain bash + python3, no other dependencies. The only network use is a fake gateway on 127.0.0.1:19350.
#
#   client/test/run.sh          exit code 0 = everything passed
#
# Safety: every run uses temp dirs for CLAUDE_MANAGED_DIR / CLAUDE_USER_DIR / HOME and sets
# CLAUDE_GATEWAY_TEST_ROOT, which makes the installer refuse (and never sudo) outside the temp tree.
# At the end the suite also checks that the real system/user settings locations were not modified.
HERE="$(cd "$(dirname "$0")" && pwd)"; CLIENT="$(dirname "$HERE")"; ROOT="$(dirname "$CLIENT")"
SRC="${CGS_SRC:-$CLIENT/claude-gateway-setup.sh}"; PKG="$ROOT/scripts/package-client.sh"
# CGS_SRC / CGS_OLD_STAMPED: maintainers can point the suite at an OLD installer to prove the regression tests below fail on it.
STAMPURL=""
mkstamped() {   # mkstamped <dir> [url]: build a company-stamped installer into <dir>; sets $STAMPURL
  STAMPURL="${2:-https://stamped.example.test}"
  if [ -n "${CGS_OLD_STAMPED:-}" ]; then mkdir -p "$1"; cp "$CGS_OLD_STAMPED" "$1/claude-gateway-setup.sh"; STAMPURL="${CGS_OLD_STAMPED_URL:-https://gw.corp.example.com}"
  else "$PKG" --gateway-url "$STAMPURL" --out "$1" >/dev/null 2>&1; fi
}
PORT=19350; DOWN_PORT=19351
PASS=0; FAIL=0; N=0; CUR=""
T="$(mktemp -d "${TMPDIR:-/tmp}/cgs-test.XXXXXX")" || exit 2; T="$(cd "$T" && pwd -P)"; mkdir -p "$T/tmp" "$T/bin"
GWPID=""
cleanup() { [ -n "$GWPID" ] && { kill "$GWPID" 2>/dev/null; wait "$GWPID" 2>/dev/null; }; rm -rf "$T"; }
trap cleanup EXIT

# --- the real locations that must never change ---
REAL_PATHS=("/Library/Application Support/ClaudeCode" "/etc/claude-code" "$HOME/.claude")
snapshot() { python3 -I - "${REAL_PATHS[@]}" <<'PY'
import glob, hashlib, os, sys
# Only the files the installer could ever write: policy files + backups, and user settings.
for base in sys.argv[1:]:
    cands = glob.glob(os.path.join(base, "managed-settings.json*")) + [os.path.join(base, "settings.json")]
    for p in sorted(cands):
        try: print(p, hashlib.sha256(open(p, "rb").read()).hexdigest())
        except OSError: print(p, "absent")
PY
}
BEFORE="$(snapshot)"

# --- fake claude binaries ---
printf '#!/bin/sh\necho "2.1.300 (Claude Code)"\n' > "$T/bin/claude"; chmod +x "$T/bin/claude"
mkdir -p "$T/old"; printf '#!/bin/sh\necho "2.0.1 (Claude Code)"\n' > "$T/old/claude"; chmod +x "$T/old/claude"

# --- fake gateway: /readyz -> 200 ---
cat > "$T/fakegw.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/readyz" else 404); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
if curl -s --max-time 1 "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then echo "port $PORT is already in use; refusing to run"; exit 2; fi
python3 -I "$T/fakegw.py" "$PORT" >/dev/null 2>&1 &
GWPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do curl -s --max-time 1 "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1 && break; sleep 0.25; done

# ---------------- harness ----------------
section() { CUR="$1"; printf '\n== %s\n' "$1"; }
pass() { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL %s [%s]\n' "$1" "$CUR"; [ -n "${2:-}" ] && printf '%s\n' "$2" | head -12 | sed 's/^/       | /'; }
fresh() {   # new sandbox: $D, $M (managed dir), $U (user dir), $S (script dir with only the script)
  N=$((N+1)); D="$T/c$N"; M="$D/managed"; U="$D/user"; S="$D/bin"; mkdir -p "$S" "$D/home"; cp "$SRC" "$S/"; EXTRA=(); CB="$T/bin/claude"
  SH="$S/claude-gateway-setup.sh"
}
run() {     # run <args...>  -> $OUT (stdout+stderr), $RC
  OUT="$(env -i PATH="$PATH" HOME="$D/home" TMPDIR="$T/tmp" CLAUDE_MANAGED_DIR="$M" CLAUDE_USER_DIR="$U" CLAUDE_GATEWAY_TEST_ROOT="$T" \
        CLAUDE_GATEWAY_NO_DNS=1 NO_PROXY=127.0.0.1,localhost CLAUDE_BIN="$CB" "${EXTRA[@]}" bash "$SH" "$@" 2>&1)"; RC=$?
}
run_out() { # stdout only
  OUT="$(env -i PATH="$PATH" HOME="$D/home" TMPDIR="$T/tmp" CLAUDE_MANAGED_DIR="$M" CLAUDE_USER_DIR="$U" CLAUDE_GATEWAY_TEST_ROOT="$T" \
        CLAUDE_GATEWAY_NO_DNS=1 CLAUDE_BIN="$CB" "${EXTRA[@]}" bash "$SH" "$@" 2>/dev/null)"; RC=$?
}
rc_is()    { if [ "$RC" = "$1" ]; then pass "$2"; else fail "$2 (exit $RC, wanted $1)" "$OUT"; fi; }
rc_fails() { if [ "$RC" != 0 ]; then pass "$1"; else fail "$1 (exit 0, wanted failure)" "$OUT"; fi; }
has()      { if printf '%s' "$OUT" | grep -qF -- "$1"; then pass "${2:-output has: $1}"; else fail "${2:-output has: $1}" "$OUT"; fi; }
lacks()    { if printf '%s' "$OUT" | grep -qF -- "$1"; then fail "${2:-output lacks: $1}" "$OUT"; else pass "${2:-output lacks: $1}"; fi; }
jv()       { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); v=eval(sys.argv[2]); print(v if isinstance(v,str) else json.dumps(v))' "$1" "$2" 2>&1; }
json_is()  { local got; got="$(jv "$1" "$2")"; if [ "$got" = "$3" ]; then pass "${4:-$2 == $3}"; else fail "${4:-$2 == $3} (got: $got)"; fi; }
exists()   { if [ -e "$1" ]; then pass "$2"; else fail "$2 (missing $1)"; fi; }
absent()   { if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (found $1)"; fi; }
baks()     { ls "$M"/managed-settings.json.bak.* 2>/dev/null | wc -l | tr -d ' '; }
equal()    { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', wanted '$2')"; fi; }
SONNET=claude-sonnet-5-5; OPUS=claude-opus-5-5; HAIKU=claude-haiku-5-5; SONNET46=claude-sonnet-4-6; OPUS46=claude-opus-4-6
MF() { echo "$M/managed-settings.json"; }; UF() { echo "$U/settings.json"; }

# ================= tests =================
section "sandbox safety"
fresh; run paths
has "managed=$M/managed-settings.json" "paths resolve inside the temp sandbox"
has "user=$U/settings.json"
OUT="$(env -i PATH="$PATH" HOME="$D/home" CLAUDE_GATEWAY_TEST_ROOT="$T" bash "$SH" paths 2>&1)"; RC=$?
rc_fails "guard refuses default system paths when no sandbox dir is given"; has "TEST GUARD"
OUT="$(env -i PATH="$PATH" HOME="/nonexistent-cgs-home" CLAUDE_MANAGED_DIR="$M" CLAUDE_GATEWAY_TEST_ROOT="$T" bash "$SH" paths 2>&1)"; RC=$?
rc_fails "guard refuses a default ~/.claude that is outside the test root"; has "TEST GUARD"

section "no-argument install from defaults.json"
fresh; printf '{"gatewayUrl":"https://gw.example.test","effortLevel":"medium","userSettings":{}}' > "$S/defaults.json"
run install --yes
rc_is 0 "install with no arguments succeeds"; has "from $S/defaults.json" "reports the gateway came from defaults.json"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' "https://gw.example.test" "policy gateway URL from defaults.json"
json_is "$(MF)" 'd["forceLoginMethod"]' gateway "forceLoginMethod is gateway"
json_is "$(MF)" 'd["parentSettingsBehavior"]' merge "parentSettingsBehavior merge"
json_is "$(MF)" 'd["allowedProviders"]' '["gateway"]' "allowedProviders is gateway only"
json_is "$(MF)" 'd["availableModels"]' "[\"$HAIKU\", \"$SONNET\", \"$OPUS\", \"$SONNET46\", \"$OPUS46\"]" "availableModels default-first from the catalog"
json_is "$(MF)" 'd["enforceAvailableModels"]' true "enforceAvailableModels"
json_is "$(MF)" 'd["env"]' "{\"ANTHROPIC_DEFAULT_SONNET_MODEL\": \"$SONNET46\", \"ANTHROPIC_DEFAULT_OPUS_MODEL\": \"$OPUS\", \"ANTHROPIC_DEFAULT_HAIKU_MODEL\": \"$HAIKU\"}" "model pins generated from the catalog"
json_is "$(UF)" 'd["model"]' "$HAIKU" "user default model is the catalog default (Haiku 5.5)"
json_is "$(UF)" 'd["effortLevel"]' medium "user default effort is medium"
has "/login" "next steps mention /login"; has "Cloud gateway" "next steps mention Cloud gateway"
# defaults.json "model" overrides the catalog default (policy starting model and the user's setting); the pins do not move
fresh; printf '{"gatewayUrl":"https://gw.example.test","model":"sonnet-4-6","effortLevel":"medium","userSettings":{}}' > "$S/defaults.json"
run install --yes; rc_is 0 "install with a model in defaults.json"
json_is "$(MF)" 'd["availableModels"]' "[\"$SONNET46\", \"$SONNET\", \"$OPUS\", \"$HAIKU\", \"$OPUS46\"]" "defaults.json model is first in availableModels, the rest follow the catalog order"
json_is "$(UF)" 'd["model"]' "$SONNET46" "and is the user's starting model"
json_is "$(MF)" 'd["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"]' "$SONNET46" "the pins still come from the catalog"

section "gateway resolution: env, stamped, precedence"
fresh; EXTRA=(CLAUDE_GATEWAY_URL=https://env.example.test); run install --yes
rc_is 0 "install via CLAUDE_GATEWAY_URL"; json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://env.example.test "env URL used"; has "CLAUDE_GATEWAY_URL" "reports env as the source"
fresh; D2="$D/dist"; mkstamped "$D2" https://stamped.example.test; S="$D2"; SH="$S/claude-gateway-setup.sh"
run install --yes; rc_is 0 "stamped build installs with no arguments"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' "$STAMPURL" "stamped URL used"; has "stamped" "reports stamped as the source"
rm -rf "$M" "$U"; printf '{"gatewayUrl":"https://defaults.example.test"}' > "$S/defaults.json"; run install --yes --dev
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://defaults.example.test "[changed: needs --dev] defaults.json beats the stamped URL only with --dev"
rm -rf "$M" "$U"; EXTRA=(CLAUDE_GATEWAY_URL=https://env.example.test); run install --yes --dev
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://env.example.test "[changed: needs --dev] env beats defaults.json only with --dev"
rm -rf "$M" "$U"; run install --yes --gateway-url https://flag.example.test/
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://flag.example.test "flag beats env (trailing slash trimmed)"
rm -rf "$M" "$U"; EXTRA=(); rm -f "$S/defaults.json"
printf '{"gatewayUrl":"https://f.example.test","model":"opus","effortLevel":"high"}' > "$D/other-defaults.json"
run install --yes --defaults "$D/other-defaults.json"; rc_is 0 "--defaults <file> works with no gateway flag"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://f.example.test "--defaults file supplies the URL"
json_is "$(MF)" 'd["availableModels"][0]' "$OPUS" "--defaults model is first in availableModels"
json_is "$(UF)" 'd["effortLevel"]' high "--defaults effort applied"

section "missing gateway"
fresh; run install --yes
rc_fails "install with no gateway source fails"; has "Ask your admin" "tells the engineer to ask their admin" 
has "package-client.sh --gateway-url" "prints the admin command"; absent "$M" "nothing written"
fresh; run print-managed; rc_fails "print-managed with no gateway fails"

section "URL validation"
fresh
run install --yes --gateway-url http://gateway.example.com; rc_fails "plain http to a non-loopback host is refused"; has "http is only accepted for localhost"
run install --yes --gateway-url https://gw.example.test/some/path; rc_fails "path is refused"; has "origin only"
run install --yes --gateway-url "https://gw.example.test?x=1"; rc_fails "query is refused"
run install --yes --gateway-url ftp://gw.example.test; rc_fails "non-http scheme refused"
run install --yes --gateway-url notaurl; rc_fails "garbage refused"
run install --yes --gateway-url https://user:pw@gw.example.test; rc_fails "credentials in URL refused"
absent "$M" "none of the refused URLs wrote anything"
run install --yes --gateway-url http://localhost:19350; rc_is 0 "http://localhost accepted"
rm -rf "$M" "$U"; run install --yes --gateway-url http://127.0.0.1:19350; rc_is 0 "http://127.0.0.1 accepted"
rm -rf "$M" "$U"; run install --yes --gateway-url https://gw.example.test:8443; rc_is 0 "https with a port accepted"
rm -rf "$M" "$U"; run install --yes --gateway-url https://8.8.8.8; has "public address" "public address gets a clear warning"
rm -rf "$M" "$U"; run install --yes --gateway-url https://10.1.2.3; has "loopback/private" "private address is accepted"

section "user settings merge"
fresh; mkdir -p "$U"
printf '{"theme":"dark","env":{"FOO":"1"},"permissions":{"allow":["Bash(ls)"]},"model":"%s"}' "$OPUS" > "$(UF)"
printf '{"gatewayUrl":"https://gw.example.test","userSettings":{"cleanupPeriodDays":30,"theme":"light","verbose":true}}' > "$S/defaults.json"
run install --yes; rc_is 0 "install over existing user settings"
json_is "$(UF)" 'd["theme"]' dark "your own value wins over the admin's userSettings"
json_is "$(UF)" 'd["cleanupPeriodDays"]' 30 "admin userSettings fill in missing keys"
json_is "$(UF)" 'd["verbose"]' true "[changed: no nested/permissions merge any more] a second allowed key fills in"
json_is "$(UF)" 'd["permissions"]' '{"allow": ["Bash(ls)"]}' "your own permissions are left exactly as they were"
json_is "$(UF)" 'd["env"]' '{"FOO": "1"}' "unrelated env preserved"
json_is "$(UF)" 'd["model"]' "$OPUS" "an allowed model you chose earlier is kept"
json_is "$(UF)" 'd["effortLevel"]' medium "missing effort filled with the default"
printf '{"model":"claude-opus-4-1","effortLevel":"ludicrous"}' > "$(UF)"; run install --yes
json_is "$(UF)" 'd["model"]' "$HAIKU" "a model outside the catalog is replaced by the default"
json_is "$(UF)" 'd["effortLevel"]' medium "an invalid effort is replaced"
printf '{ not json' > "$(UF)"; run install --yes; rc_fails "invalid user settings JSON is refused, not overwritten"; has "not valid JSON"
equal "$(cat "$(UF)")" "{ not json" "invalid file left untouched"
fresh; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes --no-user-settings
rc_is 0 "--no-user-settings"; exists "$(MF)" "policy still written"; absent "$U" "user dir not created"; has "skipped your user settings"

section "managed policy merge, backup, idempotence"
fresh; mkdir -p "$M"; printf '{"permissions":{"deny":["WebFetch"]},"env":{"KEEP_ME":"1"},"forceLoginMethod":"claudeai"}' > "$(MF)"
run install --yes --gateway-url https://gw.example.test; rc_is 0 "install over an existing policy"
json_is "$(MF)" 'd["permissions"]' '{"deny": ["WebFetch"]}' "unrelated managed keys preserved"
json_is "$(MF)" 'd["env"]["KEEP_ME"]' 1 "unrelated managed env preserved"
json_is "$(MF)" 'd["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"]' "$SONNET46" "pins merged into env"
json_is "$(MF)" 'd["forceLoginMethod"]' gateway "owned key corrected"
equal "$(baks)" 1 "a backup was kept because the policy changed"
equal "$(python3 -I -c 'import json,glob,sys; print(json.load(open(glob.glob(sys.argv[1]+"/managed-settings.json.bak.*")[0]))["forceLoginMethod"])' "$M")" claudeai "the backup holds the previous policy"
cp "$(MF)" "$D/before.json"; run install --yes --gateway-url https://gw.example.test
rc_is 0 "second install"; has "already up to date" "says it is already up to date"; equal "$(baks)" 1 "no new backup when nothing changed"
equal "$(cat "$(MF)")" "$(cat "$D/before.json")" "policy file byte-identical"
run install --yes --gateway-url https://gw2.example.test; equal "$(baks)" 2 "rotating the gateway URL keeps another backup"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://gw2.example.test "URL rotated"

section "dry run"
fresh; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"
run install --dry-run; rc_is 0 "dry-run install"; absent "$M" "dry run created no managed dir"; absent "$U" "dry run created no user dir"
has "forceLoginGatewayUrl" "prints the policy it would write"; has "would write $M/managed-settings.json" "prints the target path"; has "would write $U/settings.json"
has "claude-sonnet-5-5" "prints the model ids"
run install --yes; cp "$(MF)" "$D/p.json"; cp "$(UF)" "$D/u.json"
run install --dry-run --gateway-url https://other.example.test; equal "$(cat "$(MF)")" "$(cat "$D/p.json")" "dry run leaves an existing policy alone"; equal "$(baks)" 0 "dry run makes no backup"
run model opus --dry-run; equal "$(cat "$(UF)")" "$(cat "$D/u.json")" "dry-run model leaves settings alone"
run uninstall --dry-run; exists "$(MF)" "dry-run uninstall keeps the policy"
run update --dry-run; rc_is 0 "dry-run update"

section "catalog drift, update, catalog changes"
fresh; printf '{"gatewayUrl":"http://127.0.0.1:%s"}' "$PORT" > "$S/defaults.json"; run install --yes; rc_is 0 "install"
run status; rc_is 0 "status passes after install against the fake gateway"; has "policy matches the model catalog" "no drift reported"
python3 -I - "$(MF)" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["availableModels"] = ["claude-sonnet-5-5"]; d["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"] = "claude-opus-4-0"
d["permissions"] = {"deny": ["x"]}; json.dump(d, open(p, "w"), indent=2)
PY
run status; rc_fails "status fails on drift"; has "out of date" "status reports drift"; has "availableModels" "names the drifted key"; has "ANTHROPIC_DEFAULT_OPUS_MODEL" "names the drifted pin"
run update --yes; rc_is 0 "update"; has "changed" "update lists what it changed"
json_is "$(MF)" 'd["availableModels"]' "[\"$HAIKU\", \"$SONNET\", \"$OPUS\", \"$SONNET46\", \"$OPUS46\"]" "update restored availableModels"
json_is "$(MF)" 'd["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"]' "$OPUS" "update restored the pin"
json_is "$(MF)" 'd["permissions"]' '{"deny": ["x"]}' "update kept unrelated keys"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' "http://127.0.0.1:$PORT" "update kept the installed gateway URL"
run status; rc_is 0 "status passes again after update"
run update --yes; has "nothing to do" "update is idempotent"
fresh; run update --yes; rc_fails "update before install fails"; has "run:" "and says what to run"
# catalog changes: a new model, a disabled model, a different default
fresh; python3 -I - "$ROOT/config/models.json" "$S/models.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c["models"].append({"alias": "mythos", "id": "claude-mythos-5-5", "label": "Mythos 5.5", "tier": "premium", "enabled": True})
c["models"].append({"alias": "retired", "id": "claude-retired-5-5", "label": "Retired", "tier": "x", "enabled": False})
json.dump(c, open(sys.argv[2], "w"), indent=2)
PY
printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes; rc_is 0 "install with an extended catalog"
json_is "$(MF)" 'd["availableModels"]' "[\"$HAIKU\", \"$SONNET\", \"$OPUS\", \"$SONNET46\", \"$OPUS46\", \"claude-mythos-5-5\"]" "new model flows into availableModels, disabled one does not"
run model mythos; rc_is 0 "model <new alias> works"; json_is "$(UF)" 'd["model"]' claude-mythos-5-5 "new model written as its id"
run model claude-mythos-5-5; rc_is 0 "model <new id> works"
run model retired; rc_fails "a disabled model is rejected"
run reset; json_is "$(UF)" 'd["model"]' "$HAIKU" "reset returns to the default"
run model mythos --models "$ROOT/config/models.json"; rc_fails "--models <other catalog> overrides models.json next to the script"
fresh; cp "$ROOT/config/models.json" "$D/cat.json"; EXTRA=(CLAUDE_GATEWAY_MODELS="$D/cat.json"); run install --yes --gateway-url https://gw.example.test; rc_is 0 "CLAUDE_GATEWAY_MODELS catalog"
fresh; printf '{"models":[]}' > "$S/models.json"; run install --yes --gateway-url https://gw.example.test; rc_fails "an empty catalog is rejected"
fresh; printf 'nope' > "$S/models.json"; run install --yes --gateway-url https://gw.example.test; rc_fails "a broken catalog is rejected"; absent "$M" "and nothing was written"
fresh; printf '{"model":"nonexistent"}' > "$S/defaults.json"; run install --yes --gateway-url https://gw.example.test; rc_fails "defaults naming a model outside the catalog is rejected"
fresh; printf '{"effortLevel":"turbo"}' > "$S/defaults.json"; run install --yes --gateway-url https://gw.example.test; rc_fails "defaults with a bad effort is rejected"
fresh; python3 -I - "$ROOT/config/models.json" "$S/models.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); c["models"] = [m for m in c["models"] if m["tier"] != "upgrade"]; json.dump(c, open(sys.argv[2], "w"))
PY
run upgrade; rc_fails "upgrade with no upgrade-tier model says so"; has "no model with tier 'upgrade'"

section "upgrade / downgrade / model / effort / reset"
fresh; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes
run upgrade; rc_is 0 "upgrade"; json_is "$(UF)" 'd["model"]' "$OPUS" "upgrade -> opus (catalog upgrade tier)"; json_is "$(UF)" 'd["effortLevel"]' medium "effort untouched by upgrade"
run downgrade; rc_is 0 "downgrade"; json_is "$(UF)" 'd["model"]' "$HAIKU" "downgrade -> default model"
run model haiku; json_is "$(UF)" 'd["model"]' "$HAIKU" "model <alias>"
run model "$OPUS"; json_is "$(UF)" 'd["model"]' "$OPUS" "model <catalog id>"
run effort xhigh; rc_is 0 "effort xhigh"; json_is "$(UF)" 'd["effortLevel"]' xhigh "effort written"
run model gpt-5; rc_fails "unknown model rejected"; has "unknown model"; json_is "$(UF)" 'd["model"]' "$OPUS" "rejected model changes nothing"
run model claude-opus-4-1; rc_fails "an id that is not in the catalog is rejected"
run model; rc_fails "model with no name fails"
run effort ultra; rc_fails "unknown effort rejected"; run effort max; rc_fails "effort max is session-only"; run effort; rc_fails "effort with no level fails"
json_is "$(UF)" 'd["effortLevel"]' xhigh "rejected effort changes nothing"
run reset; rc_is 0 "reset"; json_is "$(UF)" 'd["model"]' "$HAIKU" "reset model"; json_is "$(UF)" 'd["effortLevel"]' medium "reset effort"
printf '{"theme":"dark","model":"%s"}' "$OPUS" > "$(UF)"; run reset; json_is "$(UF)" 'd["theme"]' dark "reset keeps your other settings"
fresh; printf '{"gatewayUrl":"https://gw.example.test","model":"opus","effortLevel":"high"}' > "$S/defaults.json"; run install --yes
run model haiku; run effort low; run reset; json_is "$(UF)" 'd["model"]' "$OPUS" "reset goes to the admin's default model (opus here)"; json_is "$(UF)" 'd["effortLevel"]' high "reset goes to the admin's default effort"
run downgrade; json_is "$(UF)" 'd["model"]' "$OPUS" "downgrade goes to the admin's default model"

section "status: ready, down, not signed in, versions"
fresh; run install --yes --gateway-url "http://127.0.0.1:$PORT"; run status
rc_is 0 "status ready"; has "gateway reachable and ready"; has "sign-in is forced through the gateway"; has "Claude Code 2.1.300"
fresh; run install --yes --gateway-url "http://127.0.0.1:$DOWN_PORT"; run status
rc_fails "status fails when the gateway is down"; has "cannot reach http://127.0.0.1:$DOWN_PORT/readyz"
fresh; run status; rc_fails "status with nothing installed fails"; has "no system policy"
fresh; CB="$T/old/claude"; run install --force-old-claude --gateway-url "http://127.0.0.1:$PORT"; has "older than" "[changed: needs --force-old-claude] install warns about a too-old Claude Code"
run status; rc_fails "status fails on a too-old Claude Code"; has "claude update"
fresh; CB="$T/does-not-exist"; run install --yes --gateway-url "http://127.0.0.1:$PORT"; has "isn't installed yet" "install notes a missing Claude Code"; run status; rc_fails "status fails without Claude Code"; has "not found"
fresh; run install --yes --gateway-url "http://127.0.0.1:$PORT"; printf '{"model":"claude-opus-4-1"}' > "$(UF)"; run status
rc_fails "status fails when the user's model was removed from the catalog"; has "reset"
fresh; run install --yes --gateway-url "http://127.0.0.1:$PORT"; EXTRA=(CLAUDE_GATEWAY_URL=https://other.example.test); run status
rc_fails "status flags an installed gateway that differs from the installer's"; has "differs from this installer"
fresh; run install --yes --gateway-url "http://127.0.0.1:$PORT"; printf '{ broken' > "$(MF)"; run status; rc_fails "status copes with a corrupt policy file"; has "not valid JSON"

section "leftover credentials"
fresh; EXTRA=(ANTHROPIC_API_KEY=sk-ant-FAKE-noprint ANTHROPIC_BASE_URL=https://x.example.test CLAUDE_CODE_USE_VERTEX=1)
run install --yes --gateway-url https://gw.example.test; rc_is 0 "install still succeeds"
has "ANTHROPIC_API_KEY" "warns about ANTHROPIC_API_KEY"; has "ANTHROPIC_BASE_URL" "warns about ANTHROPIC_BASE_URL"; has "CLAUDE_CODE_USE_VERTEX"
lacks "sk-ant-FAKE" "never prints the key value"
EXTRA=(); printf '{"env":{"ANTHROPIC_API_KEY":"sk-ant-FAKE-in-file"},"apiKeyHelper":"/bin/key"}' > "$(UF)"; run install --yes --gateway-url https://gw.example.test
has "$U/settings.json" "warns about credentials stored in user settings"; has "apiKeyHelper"; lacks "sk-ant-FAKE" "never prints the stored key"
json_is "$(UF)" 'd["env"]["ANTHROPIC_API_KEY"]' sk-ant-FAKE-in-file "does not silently delete your settings"
fresh; run install --yes --gateway-url https://gw.example.test; has "no leftover API keys" "a clean machine says so"

section "uninstall"
fresh; mkdir -p "$M" "$U"; printf '{"permissions":{"deny":["WebFetch"]},"env":{"KEEP_ME":"1"}}' > "$(MF)"; printf '{"theme":"dark"}' > "$(UF)"
run install --yes --gateway-url https://gw.example.test; run uninstall --yes; rc_is 0 "uninstall"
json_is "$(MF)" 'sorted(d.keys())' '["env", "permissions"]' "only what install added is removed from the policy"
json_is "$(MF)" 'd["env"]' '{"KEEP_ME": "1"}' "unrelated managed env kept"
json_is "$(UF)" 'd["theme"]' dark "user settings left alone"; json_is "$(UF)" 'd["model"]' "$HAIKU" "user model left alone"
fresh; run install --yes --gateway-url https://gw.example.test; run uninstall --yes
absent "$(MF)" "a policy that only held our keys is removed entirely"; equal "$(baks)" 1 "with a backup"
run uninstall --yes; rc_is 0 "uninstall when nothing is installed is harmless"; has "no system policy"

section "print-managed"
fresh; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"
run_out print-managed; rc_is 0 "print-managed"
printf '%s' "$OUT" > "$D/pm.json"; json_is "$D/pm.json" 'd["forceLoginGatewayUrl"]' https://gw.example.test "stdout is valid JSON with the URL"
json_is "$D/pm.json" 'sorted(d.keys())' '["allowedProviders", "availableModels", "enforceAvailableModels", "env", "forceLoginGatewayUrl", "forceLoginMethod", "parentSettingsBehavior"]' "has every policy key"
absent "$M" "print-managed writes nothing"
run install --yes; equal "$(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True))' "$D/pm.json")" "$(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])),sort_keys=True))' "$(MF)")" "print-managed equals what install writes on a clean machine"
run_out print-managed --gateway-url http://gateway.example.com; rc_fails "print-managed validates the URL"

section "package-client.sh"
fresh; P="$D/dist"
OUT="$("$PKG" --gateway-url https://pkg.example.test --out "$P" 2>&1)"; RC=$?; rc_is 0 "package build"
exists "$P/claude-gateway-setup.sh" "installer produced"; exists "$P/SHA256SUMS" "checksum file produced"; exists "$P/claude-gateway-setup.ps1" "PowerShell installer produced"
(cd "$P" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) && pass "checksums verify" || fail "checksums verify"
cp "$P/claude-gateway-setup.sh" "$D/tampered.sh"; echo "# tamper" >> "$P/claude-gateway-setup.sh"
(cd "$P" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) && fail "a tampered installer must fail its checksum" || pass "a tampered installer fails its checksum"
cp "$D/tampered.sh" "$P/claude-gateway-setup.sh"
equal "$(LC_ALL=C ls "$P" | tr '\n' ' ')" "SHA256SUMS claude-gateway-setup.ps1 claude-gateway-setup.sh " "output folder holds only the three expected files"
S="$P"; SH="$P/claude-gateway-setup.sh"; run install --yes
rc_is 0 "packaged installer installs with no arguments and no side files"; json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://pkg.example.test "packaged URL"
json_is "$(MF)" 'd["availableModels"]' "[\"$HAIKU\", \"$SONNET\", \"$OPUS\", \"$SONNET46\", \"$OPUS46\"]" "packaged catalog"; json_is "$(UF)" 'd["model"]' "$HAIKU" "packaged default model"
has "stamped" "says where the gateway came from"
if grep -q 'sk-\|BEGIN .*PRIVATE' "$P/claude-gateway-setup.sh"; then fail "no secrets in the stamped file"; else pass "no secrets in the stamped file"; fi
grep -q '^STAMP_GATEWAY_URL_B64=""' "$SRC" && pass "the source installer has no stamped URL" || fail "the source installer must keep STAMP_GATEWAY_URL_B64 empty"
# custom catalog + defaults
fresh; P="$D/dist"
python3 -I - "$ROOT/config/models.json" "$D/cat.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); c["models"].append({"alias": "mythos", "id": "claude-mythos-5-5", "label": "Mythos", "tier": "premium", "enabled": True}); json.dump(c, open(sys.argv[2], "w"))
PY
printf '{"gatewayUrl":"https://should-be-ignored.example.test","model":"opus","effortLevel":"high","userSettings":{"cleanupPeriodDays":14}}' > "$D/def.json"
OUT="$("$PKG" --gateway-url https://pkg2.example.test --models "$D/cat.json" --defaults "$D/def.json" --out "$P" 2>&1)"; RC=$?; rc_is 0 "package with custom catalog and defaults"
S="$P"; SH="$P/claude-gateway-setup.sh"; run install --yes
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://pkg2.example.test "the --gateway-url given to the packager wins over defaults.gatewayUrl"
json_is "$(MF)" 'd["availableModels"]' "[\"$OPUS\", \"$SONNET\", \"$HAIKU\", \"$SONNET46\", \"$OPUS46\", \"claude-mythos-5-5\"]" "embedded catalog and default (opus first)"
json_is "$(UF)" 'd["effortLevel"]' high "embedded effort"; json_is "$(UF)" 'd["cleanupPeriodDays"]' 14 "embedded userSettings"
run model mythos; rc_is 0 "embedded catalog supports model <new>"
fresh; P="$D/dist"
OUT="$("$PKG" --gateway-url http://gateway.example.com --out "$P" 2>&1)"; RC=$?; rc_fails "package refuses a plain-http URL"; absent "$P" "and builds nothing"
OUT="$("$PKG" --gateway-url https://gw.example.test/path --out "$P" 2>&1)"; RC=$?; rc_fails "package refuses a URL with a path"
OUT="$("$PKG" --out "$P" 2>&1)"; RC=$?; rc_fails "package needs --gateway-url"
printf '{"gatewayUrl":"","apiKey":"abc"}' > "$D/bad.json"; OUT="$("$PKG" --gateway-url https://gw.example.test --defaults "$D/bad.json" --out "$P" 2>&1)"; RC=$?; rc_fails "package refuses a defaults file with an apiKey"; has "apiKey" "[changed: now the unknown-key check fires first] and names the key"
python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); c["models"][0]["apiKey"]="abc"; json.dump(c,open(sys.argv[2],"w"))' "$ROOT/config/models.json" "$D/badcat.json"
OUT="$("$PKG" --gateway-url https://gw.example.test --models "$D/badcat.json" --out "$P" 2>&1)"; RC=$?; rc_fails "package refuses a catalog that looks like it holds a secret"; has "secret"
printf '{"userSettings":{"theme":"%s"}}' "sk-ant-api03-abcdefghij""klmnopqrstuvwxyz" > "$D/bad2.json"; OUT="$("$PKG" --gateway-url https://gw.example.test --defaults "$D/bad2.json" --out "$P" 2>&1)"; RC=$?; rc_fails "package refuses a credential-looking value"
lacks "sk-ant-api03" "and does not echo it"
OUT="$("$PKG" --gateway-url https://gw.example.test --models "$D/nope.json" --out "$P" 2>&1)"; RC=$?; rc_fails "package refuses a missing catalog"
absent "$P" "nothing built after refusals"

# ===================== hardening regression tests (adversarial review findings M3, M4, L3-L6) =====================
modeof() { python3 -I -c 'import os,sys; print("%o" % (os.stat(sys.argv[1]).st_mode & 0o777))' "$1"; }
same_file() { if cmp -s "$1" "$2"; then pass "$3"; else fail "$3 (file changed)"; fi; }

section "M3 trust model: a stamped installer ignores sibling files and environment"
fresh; mkstamped "$D/dist"; S="$D/dist"; SH="$S/claude-gateway-setup.sh"
printf '{"gatewayUrl":"https://evil.example.test","userSettings":{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch %s/PWNED"}]}]},"env":{"ANTHROPIC_BASE_URL":"https://evil.example.test"},"statusLine":{"type":"command","command":"x"}}}' "$D" > "$S/defaults.json"
python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); c["models"].append({"alias":"evil","id":"claude-evil-5-5","label":"Evil","tier":"x","enabled":True}); json.dump(c,open(sys.argv[2],"w"))' "$ROOT/config/models.json" "$S/models.json"
cp "$S/models.json" "$D/envmodels.json"
EXTRA=(CLAUDE_GATEWAY_URL=https://evil-env.example.test CLAUDE_GATEWAY_MODELS="$D/envmodels.json")
run install --yes; rc_is 0 "stamped install still succeeds with hostile side files and environment present"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' "$STAMPURL" "gateway stays the stamped one (sibling defaults.json and CLAUDE_GATEWAY_URL ignored)"
json_is "$(MF)" '"claude-evil-5-5" in d["availableModels"]' false "sibling models.json and CLAUDE_GATEWAY_MODELS do not change the model allow-list"
json_is "$(UF)" '"hooks" in d or "statusLine" in d or "env" in d' false "no hooks / statusLine / env from a stray defaults.json reach ~/.claude/settings.json"
has "ignoring" "a visible notice says the side files/environment were ignored"; has "--dev" "and says how to use them on purpose"
absent "$D/PWNED" "nothing was executed"
EXTRA=(); rm -rf "$M" "$U"; run install --yes --dev; rc_fails "--dev with a defaults.json that carries hooks/statusLine/env is refused by the allow-list"
has "not allowed" "with a clear error"; absent "$M" "and nothing was written"
printf '{"gatewayUrl":"https://dev.example.test","userSettings":{"theme":"light"}}' > "$S/defaults.json"; rm -f "$S/models.json"
run install --yes --dev; rc_is 0 "--dev lets a stamped installer use a sibling defaults.json"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://dev.example.test "the override is used"; has "OVERRIDE" "and announced"
rm -rf "$M" "$U"; run install --yes --allow-overrides; rc_is 0 "--allow-overrides is an alias"
rm -rf "$M" "$U"; EXTRA=(CLAUDE_GATEWAY_URL=https://env.example.test); rm -f "$S/defaults.json"; run install --yes --dev
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://env.example.test "--dev honours CLAUDE_GATEWAY_URL"; has "OVERRIDE" "and announces it"
EXTRA=(); rm -rf "$M" "$U"; run install --yes --gateway-url https://flag.example.test; rc_is 0 "an explicit --gateway-url still works on a stamped installer"; has "OVERRIDE" "but is announced"

section "M3 allow-list for userSettings"
for key in hooks statusLine apiKeyHelper env permissions mcpServers enabledPlugins fooBar; do
  fresh; printf '{"gatewayUrl":"https://gw.example.test","userSettings":{"%s":{"x":"y"}}}' "$key" > "$S/defaults.json"
  run install --yes; if [ "$RC" != 0 ] && printf '%s' "$OUT" | grep -q "userSettings key '$key'" && [ ! -e "$M" ] && [ ! -e "$U" ]; then pass "userSettings.$key is refused with a clear error and nothing is written"; else fail "userSettings.$key must be refused" "$OUT"; fi
done
fresh; printf '{"gatewayUrl":"https://gw.example.test","userSettings":{"hooks":{}}}' > "$D/d.json"
run print-managed --defaults "$D/d.json"; rc_fails "the same allow-list applies to --defaults files"
fresh; printf '{"gatewayUrl":"https://gw.example.test","userSettings":{"theme":{"a":1}}}' > "$S/defaults.json"; run install --yes; rc_fails "a harmless key with an object value is refused (scalars only)"
fresh; printf '{"gatewayUrl":"https://gw.example.test","hooks":{}}' > "$S/defaults.json"; run install --yes; rc_fails "an unknown top-level defaults key is refused"
fresh; printf '{"gatewayUrl":"https://gw.example.test","userSettings":{"theme":"dark","verbose":false,"alwaysThinkingEnabled":true,"includeCoAuthoredBy":false,"cleanupPeriodDays":20,"outputStyle":"default","editorMode":"vim"}}' > "$S/defaults.json"
run install --yes; rc_is 0 "every allow-listed key is accepted"; json_is "$(UF)" 'sorted(d.keys())' '["alwaysThinkingEnabled", "cleanupPeriodDays", "editorMode", "effortLevel", "includeCoAuthoredBy", "model", "outputStyle", "theme", "verbose"]' "and merged"
fresh; P="$D/dist"; printf '{"userSettings":{"hooks":{"Stop":[]}}}' > "$D/h.json"
OUT="$("$PKG" --gateway-url https://gw.example.test --defaults "$D/h.json" --out "$P" 2>&1)"; RC=$?; rc_fails "package-client.sh refuses defaults whose userSettings hold hooks"; has "hooks"; absent "$P" "and builds nothing"
printf '{"userSettings":{"env":{"ANTHROPIC_BASE_URL":"https://evil.example.test"}}}' > "$D/h.json"
OUT="$("$PKG" --gateway-url https://gw.example.test --defaults "$D/h.json" --out "$P" 2>&1)"; RC=$?; rc_fails "package-client.sh refuses userSettings.env"; absent "$P" "and builds nothing"

section "M3 optional detached signature (openssl, opt-in)"
if command -v openssl >/dev/null 2>&1 && openssl genrsa -out "$T/k1.pem" 2048 >/dev/null 2>&1 && openssl genrsa -out "$T/k2.pem" 2048 >/dev/null 2>&1; then
  openssl pkey -in "$T/k1.pem" -pubout -out "$T/k1.pub" 2>/dev/null; openssl pkey -in "$T/k2.pem" -pubout -out "$T/k2.pub" 2>/dev/null
  fresh; P="$D/dist"; OUT="$("$PKG" --gateway-url https://sig.example.test --sign-key "$T/k1.pem" --out "$P" 2>&1)"; RC=$?; rc_is 0 "build with --sign-key"
  exists "$P/claude-gateway-setup.sh.sig" "signature for the shell installer"; exists "$P/claude-gateway-setup.ps1.sig" "signature for the PowerShell installer"
  has "fingerprint" "prints the public key fingerprint to publish out of band"
  openssl dgst -sha256 -verify "$T/k1.pub" -signature "$P/claude-gateway-setup.sh.sig" "$P/claude-gateway-setup.sh" >/dev/null 2>&1 && pass "signature verifies with the matching public key" || fail "signature verifies"
  openssl dgst -sha256 -verify "$T/k2.pub" -signature "$P/claude-gateway-setup.sh.sig" "$P/claude-gateway-setup.sh" >/dev/null 2>&1 && fail "a different key must not verify" || pass "a different key does not verify"
  cp "$P/claude-gateway-setup.sh" "$D/orig.sh"; echo "# tamper" >> "$P/claude-gateway-setup.sh"
  openssl dgst -sha256 -verify "$T/k1.pub" -signature "$P/claude-gateway-setup.sh.sig" "$P/claude-gateway-setup.sh" >/dev/null 2>&1 && fail "a tampered installer must not verify (SHA256SUMS could simply be regenerated)" || pass "a tampered installer fails signature verification"
  OUT="$("$PKG" --gateway-url https://sig.example.test --sign-key "$D/nokey.pem" --out "$D/dist2" 2>&1)"; RC=$?; rc_fails "a missing signing key is an error"; absent "$D/dist2" "and builds nothing"
  fresh; P="$D/dist"; "$PKG" --gateway-url https://sig.example.test --out "$P" >/dev/null 2>&1; absent "$P/claude-gateway-setup.sh.sig" "no signature unless asked for"
else printf '  NOTE openssl not available: signature tests skipped\n'; fi

section "M4 a failed JSON read is never 'empty content = delete the file'"
for c in install update uninstall; do
  fresh; mkdir -p "$M"; printf '{\n  // admin comment\n  "permissions": {"deny": ["WebFetch"]}\n}\n' > "$(MF)"; cp "$(MF)" "$D/orig.json"
  run "$c" --yes --gateway-url https://gw.example.test
  rc_fails "$c with a managed-settings.json that is not valid JSON fails"; has "not valid JSON" "$c says why"; lacks "Next steps" "$c prints no 'Next steps'"
  same_file "$(MF)" "$D/orig.json" "$c leaves the original file byte-identical"; equal "$(baks)" 0 "$c made no backup and moved nothing"; absent "$U" "$c created no user settings"
done
fresh; mkdir -p "$M"; printf '[]' > "$(MF)"; run install --yes --gateway-url https://gw.example.test; rc_fails "a managed file holding a JSON array is refused"; equal "$(cat "$(MF)")" "[]" "and left alone"
fresh; run install --yes --gateway-url https://gw.example.test; cp "$(MF)" "$D/good.json"; printf '{ "model": oops' > "$(UF)"; cp "$(UF)" "$D/baduser.json"
run install --yes --gateway-url https://gw2.example.test; rc_fails "install with corrupt user settings fails"; lacks "Next steps" "and prints no 'Next steps'"
same_file "$(MF)" "$D/good.json" "the system policy was NOT changed either (nothing is half-applied)"; same_file "$(UF)" "$D/baduser.json" "corrupt user settings left byte-identical"
fresh; run install --yes --gateway-url https://gw.example.test; printf '{ "model": oops' > "$(UF)"; cp "$(UF)" "$D/baduser.json"
for c in "model haiku" "effort high" reset upgrade downgrade; do
  run $c; rc_fails "'$c' with corrupt user settings fails"; same_file "$(UF)" "$D/baduser.json" "'$c' leaves the corrupt file untouched"
done
fresh; mkdir -p "$U"; printf '{ "model": oops' > "$(UF)"; run install --yes --no-user-settings --gateway-url https://gw.example.test; rc_is 0 "--no-user-settings never reads the user file, so a corrupt one does not block the policy"

section "L3 the policy is never staged in a user-writable temp file"
fresh; mkdir -p "$T/fakebin"; REALMK="$(command -v mktemp)"
printf '#!/bin/sh\necho "$@" >> "$MKTEMP_LOG"\nexec "%s" "$@"\n' "$REALMK" > "$T/fakebin/mktemp"; chmod +x "$T/fakebin/mktemp"
EXTRA=(PATH="$T/fakebin:$PATH" MKTEMP_LOG="$D/mktemp.log"); : > "$D/mktemp.log"
run install --yes --no-user-settings --gateway-url https://gw.example.test; rc_is 0 "install with --no-user-settings"
equal "$(wc -c < "$D/mktemp.log" | tr -d ' ')" 0 "no temp file was created at all for the system policy"
equal "$(ls -A "$T/tmp" | wc -l | tr -d ' ')" 0 "nothing was left in TMPDIR"
run install --yes --gateway-url https://gw2.example.test; equal "$(grep -vc "^$U/" "$D/mktemp.log" | tr -d ' ')" 0 "the only temp files are next to the user's own settings file"
equal "$(modeof "$(MF)")" 644 "policy file is 0644"
json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://gw2.example.test "and holds the new content (written through stdin)"

section "L4 explicit modes regardless of umask"
fresh; OLDUM="$(umask)"; umask 077; run install --yes --gateway-url https://gw.example.test; umask "$OLDUM"; rc_is 0 "install under umask 077"
equal "$(modeof "$M")" 755 "policy directory is 0755"; equal "$(modeof "$(MF)")" 644 "policy file is 0644 (readable by the engineer)"
fresh; mkdir -p "$M"; chmod 700 "$M"; umask 077; run install --yes --gateway-url https://gw.example.test; umask "$OLDUM"; equal "$(modeof "$M")" 755 "an existing 0700 policy directory is repaired to 0755"
umask 077; run install --yes --gateway-url https://gw2.example.test; umask "$OLDUM"; equal "$(modeof "$(MF)")" 644 "a rewrite under umask 077 keeps the file 0644"

section "L5 URL injection"
INJ="$D/PWNED"; PAYLOADS=( 'https://gw.example.com$(touch @@)' 'https://gw.example.com`touch @@`' 'https://gw.example.com touch' 'https://gw.example.com"' "https://gw.example.com'" $'https://gw.example.com\ntouch @@' $'https://gw.example.com\r' 'https://gw.example.com;touch @@' 'https://gw.example.com(x)' 'https://gw.example.com)' 'https://gw.example.com$HOME' 'https://gw.example.com\' 'https://gw.example.com|x' 'https://gw.example.com&x' 'https://gw.example.com<x' 'https://gw_x.example.com' 'https://-a.example.com' 'https://a-.example.com' 'https://a..example.com' 'https://256.1.1.1' 'https://1.2.3.4.5' 'https://[zzzz]' 'https://[::1%25eth0]' 'https://gw.example.com:99999' 'https://gw.example.com:8x' )
fresh; INJ="$D/PWNED"; bad=""; badp=""
for u in "${PAYLOADS[@]}"; do
  u="${u//@@/$INJ}"
  OUT="$(env -i PATH="$PATH" HOME="$D/home" CLAUDE_MANAGED_DIR="$M" CLAUDE_USER_DIR="$U" CLAUDE_GATEWAY_TEST_ROOT="$T" CLAUDE_GATEWAY_NO_DNS=1 CLAUDE_BIN="$CB" bash "$SH" install --yes --gateway-url "$u" 2>&1)"; RC=$?
  [ "$RC" != 0 ] && [ ! -e "$INJ" ] && [ ! -e "$M" ] || bad="$bad [$u]"
  OUT="$("$PKG" --gateway-url "$u" --out "$D/pk-$RANDOM" 2>&1)"; RCP=$?
  [ "$RCP" != 0 ] && [ ! -e "$INJ" ] && [ -z "$(ls -d "$D"/pk-* 2>/dev/null)" ] || badp="$badp [$u]"
done
[ -z "$bad" ] && pass "install rejects every hostile gateway URL, executes nothing and writes nothing (${#PAYLOADS[@]} payloads)" || fail "install must reject:$bad"
[ -z "$badp" ] && pass "package-client.sh rejects every hostile gateway URL, executes nothing and builds nothing" || fail "package-client.sh must reject:$badp"
fresh; EXTRA=(CLAUDE_GATEWAY_URL="https://gw.example.com\$(touch $INJ)"); run install --yes; rc_fails "the same validator guards CLAUDE_GATEWAY_URL"; absent "$INJ" "nothing executed"
EXTRA=(); printf '{"gatewayUrl":"https://gw.example.com$(touch %s)"}' "$INJ" > "$S/defaults.json"; run install --yes; rc_fails "and defaults.json gatewayUrl"; absent "$INJ" "nothing executed"
for u in https://gw-1.corp.example.com https://10.1.2.3:8443 'https://[fd00::1]:8443' http://127.0.0.1:19350 'http://[::1]:19350' https://GW.Example.COM; do
  fresh; run install --yes --gateway-url "$u"; rc_is 0 "valid form accepted: $u"
done
fresh; P="$D/dist"; "$PKG" --gateway-url https://pkg3.example.test --out "$P" >/dev/null 2>&1
if grep -q 'pkg3.example.test' "$P/claude-gateway-setup.sh"; then fail "the stamped .sh must not contain the URL as raw text (base64 only)"; else pass "the stamped .sh holds the URL only as base64"; fi
if grep -q 'pkg3.example.test' "$P/claude-gateway-setup.ps1"; then fail "the stamped .ps1 must not contain the URL as raw text"; else pass "the stamped .ps1 holds the URL only as base64"; fi
grep -Eq "^\\\$StampGatewayUrlB64 = '[A-Za-z0-9+/=]+'\$" "$P/claude-gateway-setup.ps1" && pass ".ps1 stamps are base64 inside single quotes" || fail ".ps1 stamps must be single-quoted base64"
grep -Eq '^STAMP_GATEWAY_URL_B64="[A-Za-z0-9+/=]+"$' "$P/claude-gateway-setup.sh" && pass ".sh stamps are plain base64" || fail ".sh stamps must be base64"
equal "$(sed -n 's/^STAMP_GATEWAY_URL_B64="\(.*\)"$/\1/p' "$P/claude-gateway-setup.sh" | python3 -I -c 'import base64,sys; print(base64.b64decode(sys.stdin.read()).decode())')" https://pkg3.example.test "and decodes to the URL"

section "L6 old Claude Code, symlinked settings, temp files, backups, uninstall, recovery"
fresh; CB="$T/old/claude"; run install --gateway-url "http://127.0.0.1:$PORT"
rc_fails "install with Claude Code older than the minimum exits non-zero"; has "force-old-claude" "and says how to override"; absent "$M" "and writes nothing"
run install --force-old-claude --gateway-url "http://127.0.0.1:$PORT"; rc_is 0 "--force-old-claude installs anyway"; has "INEFFECTIVE" "with a loud warning that the lock does not work"
rm -rf "$M" "$U"; run install --yes --gateway-url "http://127.0.0.1:$PORT"; rc_fails "[changed: round 2] --yes alone never overrides the old-Claude block"; absent "$M" "and writes nothing"
fresh; mkdir -p "$U" "$D/real"; printf '{"theme":"dark"}' > "$D/real/settings.json"; chmod 644 "$D/real/settings.json"; ln -s "$D/real/settings.json" "$(UF)"
run install --yes --gateway-url https://gw.example.test; rc_is 0 "install over a symlinked settings.json"
if [ -L "$(UF)" ]; then pass "the symlink is preserved"; else fail "the symlink was replaced by a regular file"; fi
json_is "$D/real/settings.json" 'd["model"]' "$HAIKU" "the link target received the settings"; json_is "$D/real/settings.json" 'd["theme"]' dark "and kept the existing ones"
equal "$(modeof "$D/real/settings.json")" 644 "the target's file mode is preserved"
run model haiku; if [ -L "$(UF)" ]; then pass "still a symlink after 'model'"; else fail "symlink replaced by 'model'"; fi; json_is "$D/real/settings.json" 'd["model"]' "$HAIKU" "'model' wrote through the link"
equal "$(find "$U" "$D/real" -name '.settings.*' | wc -l | tr -d ' ')" 0 "no temp files left behind"
fresh; mkdir -p "$T/fakebin2"; printf '#!/bin/sh\nfor a; do l="$a"; done\ncase "$l" in *settings.json) exit 1;; esac\nexec /bin/mv "$@"\n' > "$T/fakebin2/mv"; chmod +x "$T/fakebin2/mv"
EXTRA=(PATH="$T/fakebin2:$PATH"); run install --yes --gateway-url https://gw.example.test
rc_fails "a failure while finishing the user settings write exits non-zero"
equal "$(ls -A "$U" 2>/dev/null | wc -l | tr -d ' ')" 0 "the exit trap removed the temp file on the failure path"
EXTRA=()
fresh; run install --yes --gateway-url https://gw0.example.test
for i in 1 2 3 4 5 6 7 8; do run install --yes --gateway-url "https://gw$i.example.test"; done
equal "$(baks)" 5 "backups are capped at the newest 5"
newest="$(ls -1t "$M"/managed-settings.json.bak.* | head -1)"; json_is "$newest" 'd["forceLoginGatewayUrl"]' https://gw7.example.test "the newest backup holds the previous policy"
badn=0; badm=0; for f in "$M"/managed-settings.json.bak.*; do printf '%s' "${f##*/}" | grep -Eq '^managed-settings\.json\.bak\.[0-9]{14}\.[0-9a-f]{8}$' || badn=$((badn+1)); [ "$(modeof "$f")" = 600 ] || badm=$((badm+1)); done
equal "$badn" 0 "backup names carry a random suffix"; equal "$badm" 0 "backups are mode 600"
fresh; run install --yes --gateway-url https://gw.example.test
python3 -I - "$(MF)" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["availableModels"] = ["claude-sonnet-5-5"]; d["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"] = "my-custom-opus"; d["forceLoginMethod"] = "claudeai"
json.dump(d, open(p, "w"), indent=2)
PY
run uninstall --yes; rc_is 0 "uninstall over an admin-customised policy"; has "left alone" "says which values it left alone"; has "availableModels" "names them"
json_is "$(MF)" 'd["availableModels"]' '["claude-sonnet-5-5"]' "the customised availableModels is kept"; json_is "$(MF)" 'd["env"]' '{"ANTHROPIC_DEFAULT_OPUS_MODEL": "my-custom-opus"}' "the customised pin is kept and the other pins are removed"
json_is "$(MF)" 'd["forceLoginMethod"]' claudeai "the customised forceLoginMethod is kept"; json_is "$(MF)" '"allowedProviders" in d or "forceLoginGatewayUrl" in d' false "values that still match are removed"
run uninstall --yes --force; rc_is 0 "uninstall --force"; absent "$(MF)" "removes the rest"
fresh; run print-lock-recovery; rc_is 0 "print-lock-recovery"; has "sudo bash" "prints the recovery command"; has "uninstall" "which is uninstall"
run --print-lock-recovery; rc_is 0 "--print-lock-recovery works as a flag too"
fresh; run install --yes --gateway-url "http://127.0.0.1:$DOWN_PORT"; run status; rc_fails "status with an unreachable gateway fails"; has "sudo bash" "and tells the engineer how to recover"; has "print-lock-recovery" "pointing at the recovery help"

section "round 2 N6: the version gate fails closed"
mkdir -p "$T/vc"
fakeclaude() { printf '#!/bin/sh\n%s\n' "$2" > "$T/vc/$1"; chmod +x "$T/vc/$1"; }
fakeclaude boom 'echo "Error: boom"'; fakeclaude garbage 'echo "garbage 2.0.0"'; fakeclaude empty 'exit 0'; fakeclaude crash 'echo "2.1.300" >&2; exit 3'
fakeclaude exact 'echo "2.1.285 (Claude Code)"'; fakeclaude pre 'echo "2.1.300-beta.1 (Claude Code)"'; fakeclaude oldx 'echo "2.1.284 (Claude Code)"'
for v in boom garbage empty crash oldx; do
  fresh; CB="$T/vc/$v"
  run install --yes --gateway-url "http://127.0.0.1:$PORT"; rc_fails "version '$v': install --yes exits non-zero"; absent "$M" "version '$v': nothing written"; has "force-old-claude" "version '$v': says how to override"
  run install --yes --force-old-claude --gateway-url "http://127.0.0.1:$PORT"; rc_is 0 "version '$v': --force-old-claude overrides"; has "INEFFECTIVE" "version '$v': loud warning"
  run status; rc_fails "version '$v': status fails"
done
for v in exact pre; do fresh; CB="$T/vc/$v"; run install --yes --gateway-url "http://127.0.0.1:$PORT"; rc_is 0 "version '$v' passes the gate"; done

section "round 2 N7: per-key userSettings validation and strict JSON"
us_bad() { fresh; printf '{"gatewayUrl":"https://gw.example.test","userSettings":%s}' "$1" > "$S/defaults.json"; run install --yes
  if [ "$RC" != 0 ] && [ ! -e "$M" ] && [ ! -e "$U" ]; then pass "refused: userSettings $1"; else fail "must refuse userSettings $1" "$OUT"; fi; }
us_ok() { fresh; printf '{"gatewayUrl":"https://gw.example.test","userSettings":%s}' "$1" > "$S/defaults.json"; run install --yes; rc_is 0 "accepted: userSettings $1"; }
for b in '{"cleanupPeriodDays":NaN}' '{"cleanupPeriodDays":Infinity}' '{"cleanupPeriodDays":-Infinity}' '{"cleanupPeriodDays":0}' '{"cleanupPeriodDays":-5}' '{"cleanupPeriodDays":1.5}' '{"cleanupPeriodDays":30.0}' '{"cleanupPeriodDays":1e3}' '{"cleanupPeriodDays":"30"}' '{"cleanupPeriodDays":true}' '{"cleanupPeriodDays":3651}' '{"cleanupPeriodDays":null}' \
         '{"verbose":"true"}' '{"verbose":1}' '{"alwaysThinkingEnabled":"yes"}' '{"theme":5}' '{"theme":true}' '{"theme":"Dark Theme!"}' '{"theme":"dark\nx"}' '{"editorMode":"emacs"}' '{"outputStyle":"a\nb"}' '{"outputStyle":["x"]}'; do us_bad "$b"; done
for b in '{"cleanupPeriodDays":1}' '{"cleanupPeriodDays":3650}' '{"verbose":false,"alwaysThinkingEnabled":true}' '{"theme":"dark-daltonized"}' '{"editorMode":"vim"}' '{"outputStyle":"Explanatory"}'; do us_ok "$b"; done
fresh; mkdir -p "$U"; printf '{"model":"%s","cleanupPeriodDays":NaN}' "$SONNET" > "$(UF)"; cp "$(UF)" "$D/nan.json"
run install --yes --gateway-url https://gw.example.test; rc_fails "a user settings file with NaN is refused (never rewritten as invalid JSON)"; has "not valid JSON"; same_file "$(UF)" "$D/nan.json" "and left byte-identical"
run model haiku; rc_fails "'model' refuses it too"
fresh; mkdir -p "$M"; printf '{"x":Infinity}' > "$(MF)"; cp "$(MF)" "$D/inf.json"; run install --yes --gateway-url https://gw.example.test; rc_fails "a managed file with Infinity is refused"; same_file "$(MF)" "$D/inf.json" "and left byte-identical"
fresh; run install --yes --gateway-url https://gw.example.test; ALLVALID=1
for f in "$(MF)" "$(UF)"; do python3 -I -c 'import json,sys; json.loads(open(sys.argv[1]).read(), parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))' "$f" || ALLVALID=0; done
equal "$ALLVALID" 1 "everything the installer writes is strict JSON"

section "round 2 N7: model catalog names"
cat_bad() { fresh; python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); exec(sys.argv[3]); json.dump(c,open(sys.argv[2],"w"))' "$ROOT/config/models.json" "$D/cat.json" "$1"
  run print-managed --gateway-url https://gw.example.test --models "$D/cat.json"; rc_fails "installer refuses catalog edit: $1"; lacks "Traceback" "no traceback: $1"
  OUT="$("$PKG" --gateway-url https://gw.example.test --models "$D/cat.json" --out "$D/pk" 2>&1)"; RC=$?; rc_fails "package-client.sh refuses it too: $1"; absent "$D/pk" "and builds nothing: $1"; }
cat_bad 'c["models"][0]["id"]={"x":1}'; cat_bad 'c["models"][0]["id"]="a b"'; cat_bad 'c["models"][0]["id"]="a\nb"'; cat_bad 'c["models"][0]["alias"]="x y"'
cat_bad 'c["models"][0]["alias"]="a"*65'; cat_bad 'c["models"][0]["id"]="-lead"'; cat_bad 'c["models"][0]["id"]=["a"]'; cat_bad 'c["models"][0]["alias"]=5'
cat_bad 'c["models"][1]["id"]="x$(touch y)"'; cat_bad 'c["models"][0]["label"]="a\nb"'; cat_bad 'c["default"]={"a":1}'
fresh; python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); c["models"][2]["enabled"]=False; c["models"][2]["id"]="bad id"; json.dump(c,open(sys.argv[2],"w"))' "$ROOT/config/models.json" "$D/cat.json"
run print-managed --gateway-url https://gw.example.test --models "$D/cat.json"; rc_fails "a disabled model's names are validated too"
printf '{"models":[{"alias":"a","id":"a","x":NaN}]}' > "$D/cat.json"; run print-managed --gateway-url https://gw.example.test --models "$D/cat.json"; rc_fails "NaN in a catalog is refused"
OUT="$("$PKG" --gateway-url https://gw.example.test --models "$D/cat.json" --out "$D/pk" 2>&1)"; RC=$?; rc_fails "package-client.sh refuses NaN in a catalog"

section "round 2 N7: URL edge cases and normalisation"
fresh
for u in 'https://gw.example.com:' 'https://gw.example.com:/' 'http://127.0.0.1:' 'https://[::1' 'https://[::1]:' 'https://[' 'https://]' 'https://[::1]x' 'https://gw.example.com:+80'; do
  OUT="$(env -i PATH="$PATH" HOME="$D/home" CLAUDE_GATEWAY_NO_DNS=1 bash "$SH" print-managed --gateway-url "$u" 2>&1)"; RC=$?
  if [ "$RC" != 0 ] && ! printf '%s' "$OUT" | grep -q Traceback && printf '%s' "$OUT" | grep -q '^error:'; then pass "clean error for $u"; else fail "clean error for $u (rc $RC)" "$OUT"; fi
  OUT="$("$PKG" --gateway-url "$u" --out "$D/pk" 2>&1)"; RC=$?; [ "$RC" != 0 ] && ! printf '%s' "$OUT" | grep -q Traceback && [ ! -e "$D/pk" ] && pass "package-client.sh: clean refusal for $u" || fail "package-client.sh must cleanly refuse $u" "$OUT"
done
run_out print-managed --gateway-url 'HTTPS://GW.Example.COM:8443/'; printf '%s' "$OUT" > "$D/pm.json"; json_is "$D/pm.json" 'd["forceLoginGatewayUrl"]' https://gw.example.com:8443 "print-managed canonicalises to lower case"
run install --yes --gateway-url 'HTTPS://GW.Example.COM'; json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://gw.example.com "install writes the lower-case form"
run update --yes --gateway-url 'HTTPS://GW2.Example.COM'; json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://gw2.example.com "update writes the lower-case form"
run install --yes --gateway-url 'HTTPS://[FD00::1]:8443'; json_is "$(MF)" 'd["forceLoginGatewayUrl"]' 'https://[fd00::1]:8443' "IPv6 literal is lower-cased"
fresh; P="$D/dist"; OUT="$("$PKG" --gateway-url 'HTTPS://GW.Example.COM:8443/' --out "$P" 2>&1)"; RC=$?; rc_is 0 "package with an upper-case URL"
equal "$(sed -n 's/^STAMP_GATEWAY_URL_B64="\(.*\)"$/\1/p' "$P/claude-gateway-setup.sh" | python3 -I -c 'import base64,sys; print(base64.b64decode(sys.stdin.read()).decode())')" https://gw.example.com:8443 "the stamped form is the normalised one"
has "Built installer for https://gw.example.com:8443" "and the build reports it"
S="$P"; SH="$P/claude-gateway-setup.sh"; run install --yes; json_is "$(MF)" 'd["forceLoginGatewayUrl"]' https://gw.example.com:8443 "the stamped installer installs the normalised URL"

section "round 2: stale signatures and checksums from a previous build"
fresh; P="$D/dist"; mkdir -p "$P"; : > "$P/claude-gateway-setup.sh.sig"; : > "$P/claude-gateway-setup.ps1.sig"; : > "$P/old.sha256"; : > "$P/other.sig"; echo "deadbeef  claude-gateway-setup.sh" > "$P/SHA256SUMS"
OUT="$("$PKG" --gateway-url https://gw.example.test --out "$P" 2>&1)"; RC=$?; rc_is 0 "rebuild into a folder with leftovers"
equal "$(LC_ALL=C ls "$P" | tr '\n' ' ')" "SHA256SUMS claude-gateway-setup.ps1 claude-gateway-setup.sh " "stale .sig/.sha256 files are gone"
(cd "$P" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) && pass "and SHA256SUMS is the fresh one" || fail "SHA256SUMS must be fresh"
if command -v openssl >/dev/null 2>&1 && [ -f "$T/k1.pem" ]; then
  OUT="$("$PKG" --gateway-url https://gw.example.test --sign-key "$T/k1.pem" --out "$P" 2>&1)"; RC=$?; exists "$P/claude-gateway-setup.sh.sig" "signed build has a signature"
  OUT="$("$PKG" --gateway-url https://gw2.example.test --out "$P" 2>&1)"; RC=$?; absent "$P/claude-gateway-setup.sh.sig" "a later unsigned build does not keep the old signature"
fi

section "models: Claude 4.6 in the catalog, family/pin rules, the 4.6-default recipe"
catmod() { python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); exec(sys.argv[3]); json.dump(c,open(sys.argv[2],"w"))' "$ROOT/config/models.json" "$2" "$1"; }
RECIPE='c["default"]="sonnet-4-6"
for m in c["models"]:
    if m["alias"] in ("sonnet", "opus"): m["pin"]=False
    if m["alias"] in ("sonnet-4-6", "opus-4-6"): m["pin"]=True'
LEGACY='c["default"]="sonnet"
for m in c["models"]:
    if m["alias"]=="sonnet": m["pin"]=True
    if m["alias"]=="sonnet-4-6": m["pin"]=False'
fresh; printf '{"gatewayUrl":"http://127.0.0.1:%s"}' "$PORT" > "$S/defaults.json"; run install --yes; rc_is 0 "install with the shipped catalog"
json_is "$(MF)" 'sorted(d["env"].items())' "[[\"ANTHROPIC_DEFAULT_HAIKU_MODEL\", \"$HAIKU\"], [\"ANTHROPIC_DEFAULT_OPUS_MODEL\", \"$OPUS\"], [\"ANTHROPIC_DEFAULT_SONNET_MODEL\", \"$SONNET46\"]]" "Sonnet 4.6 is the Sonnet pin; Opus 4.6 is allowed but not pinned (Opus stays on 5.5)"
run model sonnet-4-6; rc_is 0 "model sonnet-4-6"; json_is "$(UF)" 'd["model"]' "$SONNET46" "model <4.6 alias> writes the id (the setting the model command always uses)"
run model sonnet; rc_is 0 "model sonnet (the 5.5 entry, by alias)"; json_is "$(UF)" 'd["model"]' "$SONNET" "writes the 5.5 id"
has "Sonnet 5.5" "names the model"; has "not the company default" "explains the previous tier"; has "gateway policy sets a starting model" "says a policy starting model outranks the setting"
json_is "$(MF)" 'd["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"]' "$SONNET46" "choosing 5.5 does not touch the policy pin"
run model OPUS-4-6; rc_is 0 "model <alias> is case-insensitive"; json_is "$(UF)" 'd["model"]' "$OPUS46" "opus 4.6 written as its id"
run model "$SONNET46"; rc_is 0 "model <4.6 id>"; json_is "$(UF)" 'd["model"]' "$SONNET46" "4.6 id accepted"
run model sonnet; run status; rc_is 0 "status accepts a non-default choice"; has "default model setting: Sonnet 5.5 (not the company default, Haiku 5.5" "status shows a 5.5 setting as not the company default"
lacks "your choice" "and no longer claims the engineer chose it"
run downgrade; json_is "$(UF)" 'd["model"]' "$HAIKU" "downgrade goes back to the company default"
run upgrade; json_is "$(UF)" 'd["model"]' "$OPUS" "upgrade still means the upgrade tier (Opus 5.5), not a 4.6 entry"
fresh; run install --yes --gateway-url https://gw.example.test --model sonnet-4-6; rc_is 0 "install --model sonnet-4-6"
json_is "$(UF)" 'd["model"]' "$SONNET46" "install --model sets the user's model"; has "from --model" "and says so"
json_is "$(MF)" 'd["availableModels"][0]' "$HAIKU" "policy default unchanged by --model"
run install --yes --gateway-url https://gw.example.test; json_is "$(UF)" 'd["model"]' "$SONNET46" "a later plain install keeps that choice"
run install --yes --gateway-url https://gw.example.test --model=claude-opus-4-6; rc_is 0 "install --model=<id> replaces an existing choice"; json_is "$(UF)" 'd["model"]' "$OPUS46" "and wins over it"
fresh; run install --yes --gateway-url https://gw.example.test --model gpt-5; rc_fails "install --model with an unknown model fails"; has "unknown model"; absent "$M" "and writes nothing"; absent "$U" "not even user settings"
run install --yes --gateway-url https://gw.example.test --model; rc_fails "--model needs a value"
run install --yes --gateway-url https://gw.example.test --model sonnet-4-6 --no-user-settings; rc_fails "--model with --no-user-settings is refused"; absent "$M" "and nothing is written"
run status --model sonnet-4-6; rc_fails "--model on a command other than install is refused"
run install --dry-run --yes --gateway-url https://gw.example.test --model opus-4-6; rc_is 0 "dry run with --model"; has "$OPUS46" "shows the model it would write"; absent "$U" "writes nothing"
# the built-in fallback table (no models.json next to the script) matches the shipped catalog
fresh; run_out print-managed --gateway-url https://gw.example.test; printf '%s' "$OUT" > "$T/builtin.json"
fresh; run_out print-managed --gateway-url https://gw.example.test --models "$ROOT/config/models.json"; printf '%s' "$OUT" > "$T/shipped.json"
equal "$(cat "$T/builtin.json")" "$(cat "$T/shipped.json")" "the built-in fallback catalog produces the same policy as config/models.json"
json_is "$T/builtin.json" '"claude-opus-4-6" in d["availableModels"] and "claude-sonnet-4-6" in d["availableModels"]' true "fallback allows both 4.6 ids"
# recipe: run 4.6 as the default for everyone
fresh; catmod "$RECIPE" "$S/models.json"; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes; rc_is 0 "install with the 4.6-default recipe"
json_is "$(MF)" 'd["availableModels"]' "[\"$SONNET46\", \"$SONNET\", \"$OPUS\", \"$HAIKU\", \"$OPUS46\"]" "recipe: 4.6 default is first, every enabled model is still allowed"
json_is "$(MF)" 'sorted(d["env"].items())' "[[\"ANTHROPIC_DEFAULT_HAIKU_MODEL\", \"$HAIKU\"], [\"ANTHROPIC_DEFAULT_OPUS_MODEL\", \"$OPUS46\"], [\"ANTHROPIC_DEFAULT_SONNET_MODEL\", \"$SONNET46\"]]" "recipe: the sonnet and opus pins are the 4.6 ids"
json_is "$(UF)" 'd["model"]' "$SONNET46" "recipe: a new engineer starts on Sonnet 4.6 (the catalog default, no defaults.json model needed)"
run model sonnet; rc_is 0 "recipe: the 5.5 entries can still be chosen"; json_is "$(UF)" 'd["model"]' "$SONNET" "recipe: sonnet means the 5.5 entry by alias, 4.6 by pin"
run reset; json_is "$(UF)" 'd["model"]' "$SONNET46" "recipe: reset goes to 4.6"
# a machine installed before the recipe sees drift and update repairs it
fresh; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes; catmod "$RECIPE" "$S/models.json"
run status; rc_fails "switching the catalog to the recipe shows up as drift"; has "ANTHROPIC_DEFAULT_OPUS_MODEL" "names the pin that moved"
run update --yes; rc_is 0 "update applies the recipe"; json_is "$(MF)" 'd["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"]' "$OPUS46" "opus pin moved to 4.6"
json_is "$(MF)" 'd["availableModels"][0]' "$SONNET46" "default moved to 4.6"
# docs/INSTALL.md "make Sonnet 4.6 the default": the default and the tiers change, the pins stay where they are
S46DEF='c["default"]="sonnet-4-6"
for m in c["models"]:
    if m["alias"]=="sonnet-4-6": m["tier"]="default"
    if m["alias"]=="haiku": m["tier"]="fast"'
fresh; catmod "$S46DEF" "$S/models.json"; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes; rc_is 0 "install with the Sonnet 4.6-default recipe"
json_is "$(MF)" 'd["availableModels"]' "[\"$SONNET46\", \"$SONNET\", \"$OPUS\", \"$HAIKU\", \"$OPUS46\"]" "Sonnet 4.6 default is first, every enabled model is still allowed"
json_is "$(MF)" 'sorted(d["env"].items())' "[[\"ANTHROPIC_DEFAULT_HAIKU_MODEL\", \"$HAIKU\"], [\"ANTHROPIC_DEFAULT_OPUS_MODEL\", \"$OPUS\"], [\"ANTHROPIC_DEFAULT_SONNET_MODEL\", \"$SONNET46\"]]" "the pins do not move"
json_is "$(UF)" 'd["model"]' "$SONNET46" "a new engineer starts on Sonnet 4.6"
run model haiku; rc_is 0 "Haiku can still be chosen by name"; json_is "$(UF)" 'd["model"]' "$HAIKU" "and writes its id"; has "fastest and cheapest" "the fast tier is explained"
run downgrade; json_is "$(UF)" 'd["model"]' "$SONNET46" "downgrade goes to the new company default"
# a disabled implicit pin does not collide with an explicit one
fresh; catmod 'c["default"]="sonnet-4-6"
for m in c["models"]:
    if m["alias"]=="sonnet": m["enabled"]=False
    if m["alias"]=="sonnet-4-6": m["pin"]=True' "$S/models.json"
run_out print-managed --gateway-url https://gw.example.test; rc_is 0 "disabling the old entry is an alternative to pin:false"
printf '%s' "$OUT" > "$D/pm.json"; json_is "$D/pm.json" 'd["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"]' "$SONNET46" "and the pin follows the enabled entry"
# a family and a pin on an entry that is not named like its family
fresh; catmod 'c["models"].append({"alias":"fast-sonnet","id":"claude-sonnet-x","family":"sonnet","tier":"x"})
c["default"]="fast-sonnet"
for m in c["models"]:
    if m["alias"] in ("sonnet", "sonnet-4-6"): m["pin"]=False
c["models"][-1]["pin"]=True' "$S/models.json"
run_out print-managed --gateway-url https://gw.example.test; printf '%s' "$OUT" > "$D/pm.json"; json_is "$D/pm.json" 'd["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"]' claude-sonnet-x "a custom alias can pin a family when given family and pin"
# invalid catalogs are refused, loudly, and never leave the machine half-configured or unlocked
bad_cat() {   # bad_cat <python edit> <expected words>
  fresh; catmod "$1" "$S/models.json"
  run install --yes --gateway-url https://gw.example.test; rc_fails "install refuses: $1"; has "$2" "says why: $2"; lacks "Traceback" "no traceback: $1"; absent "$M" "nothing written: $1"; absent "$U" "no user settings either: $1"
  run_out print-managed --gateway-url https://gw.example.test; rc_fails "print-managed refuses: $1"
  OUT="$("$PKG" --gateway-url https://gw.example.test --models "$S/models.json" --out "$D/pk" 2>&1)"; RC=$?; rc_fails "package-client.sh refuses: $1"; absent "$D/pk" "builds nothing: $1"
}
bad_cat 'c["models"][3]["alias"]="sonnet"' "aliases must be unique"
bad_cat 'c["models"][3]["alias"]="SONNET"' "aliases must be unique"
bad_cat 'c["models"][3]["id"]=c["models"][0]["id"]' "ids must be unique"
bad_cat 'c["models"][0]["pin"]=True' "more than one model pins the sonnet family"
bad_cat 'c["models"][3]["family"]="sonnet"; c["models"][4]["family"]="sonnet"; c["models"][4]["pin"]=True; c["models"][3]["pin"]=True; c["models"][0]["pin"]=False' "more than one model pins the sonnet family"
bad_cat 'c["default"]="nope"' "must be the alias or id of a model"
bad_cat 'c["default"]="opus-4-6"; c["models"][4]["enabled"]=False' "must be enabled"
bad_cat 'c["models"][3]["enabled"]=False; c["models"][3]["pin"]=True; c["models"][0]["pin"]=False' "pinned but disabled"
bad_cat 'c["models"][3].pop("family"); c["models"][3]["pin"]=True' "has no family"
bad_cat 'c["models"][3]["family"]="gpt"' "family"
bad_cat 'c["models"][3]["pin"]="yes"' "pin"
bad_cat 'c["models"][3]["family"]=5' "family"
# fail closed on a machine that already has a policy: a bad catalog must not rewrite or remove it
fresh; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"; run install --yes; cp "$(MF)" "$D/before.json"; cp "$(UF)" "$D/ubefore.json"
catmod 'c["models"][0]["pin"]=True' "$S/models.json"
run update --yes; rc_fails "update with an invalid catalog fails"; equal "$(cat "$(MF)")" "$(cat "$D/before.json")" "the installed policy is untouched (still locked down)"
run model sonnet-4-6; rc_fails "model with an invalid catalog fails"; equal "$(cat "$(UF)")" "$(cat "$D/ubefore.json")" "user settings untouched"
run status; rc_fails "status with an invalid catalog fails"
run uninstall --yes; rc_fails "uninstall refuses to run on an invalid catalog rather than guess"; exists "$(MF)" "the policy is still there"

section "round 4: address classification (what Claude Code's /login accepts)"
fresh
for u in https://10.1.2.3 https://172.16.0.9 https://172.31.255.1 https://192.168.1.1 https://169.254.1.1 https://100.64.1.5 https://100.127.255.254 'https://[fd00::1]' 'https://[fe80::1]' http://127.0.0.1:19350; do
  run install --dry-run --yes --gateway-url "$u"; has "loopback/private" "accepted as private: $u"; lacks "public address" "no public warning: $u"
done
for u in https://203.0.113.9 https://198.51.100.7 https://192.0.2.1 https://198.18.0.5 https://8.8.8.8 https://172.32.0.1 https://100.128.0.1 https://100.63.255.255 https://240.0.0.1 https://0.1.2.3 'https://[2001:db8::1]'; do
  run install --dry-run --yes --gateway-url "$u"; has "resolves to a public address" "treated as public: $u"; lacks "loopback/private, which" "not called private: $u"
done
has "gatewayInternalNetworks" "the public-address warning names the managed setting that fixes it"

section "round 4: gatewayInternalNetworks (managed setting; declared in defaults.json, validated like Claude Code does)"
fresh; printf '{"gatewayUrl":"https://198.51.101.7","gatewayInternalNetworks":["198.51.101.0/24","192.0.9.0/24"]}' > "$S/defaults.json"
run install --yes; rc_is 0 "a declared block is accepted"; has "inside a gatewayInternalNetworks block" "a gateway inside the block is reported as declared, not public"; lacks "resolves to a public address" "no public warning"
json_is "$(MF)" 'd["gatewayInternalNetworks"]' '["198.51.101.0/24", "192.0.9.0/24"]' "the blocks are written into the managed policy"
run status; has "policy matches the model catalog" "status is happy with the policy"
printf '{"gatewayUrl":"https://198.51.101.7","gatewayInternalNetworks":["198.51.101.0/24"]}' > "$S/defaults.json"; run status; rc_fails "status sees drift when the declared blocks changed"; has "gatewayInternalNetworks" "and names the key"
run update --yes; rc_is 0 "update rewrites the blocks"; json_is "$(MF)" 'd["gatewayInternalNetworks"]' '["198.51.101.0/24"]' "the new block list is installed"
run uninstall --yes; rc_is 0 "uninstall"; absent "$(MF)" "uninstall removes the blocks it wrote (and with them the whole file: nothing else was in it)"
run_out print-managed; printf '%s' "$OUT" > "$D/pm.json"; json_is "$D/pm.json" 'd["gatewayInternalNetworks"]' '["198.51.101.0/24"]' "print-managed (for MDM) carries the blocks"
# no declaration in defaults: an MDM-delivered key is neither added, nor removed, nor overwritten, and still silences the public warning
fresh; mkdir -p "$M"; printf '{"gatewayInternalNetworks":["198.51.101.0/24"]}' > "$(MF)"
run install --yes --gateway-url https://198.51.101.7; rc_is 0 "install next to an MDM-delivered key"; has "inside a gatewayInternalNetworks block" "the MDM key counts"
json_is "$(MF)" 'd["gatewayInternalNetworks"]' '["198.51.101.0/24"]' "and survives install"
run uninstall --yes; json_is "$(MF)" 'd["gatewayInternalNetworks"]' '["198.51.101.0/24"]' "and survives uninstall (not ours)"
run uninstall --yes --force; json_is "$(MF)" 'd["gatewayInternalNetworks"]' '["198.51.101.0/24"]' "even with --force (only keys our defaults declare are owned)"
fresh; run install --dry-run --yes --gateway-url https://198.51.101.7; has "resolves to a public address" "without any declaration the same address is public"
bad_gin() {   # bad_gin <json list> <words>
  fresh; printf '{"gatewayUrl":"https://gw.example.test","gatewayInternalNetworks":%s}' "$1" > "$S/defaults.json"
  run install --yes; rc_fails "refused: gatewayInternalNetworks $1"; has "$2" "says why: $2"; lacks Traceback "no traceback"; absent "$M" "nothing written"
  OUT="$("$PKG" --gateway-url https://gw.example.test --defaults "$S/defaults.json" --out "$D/pk" 2>&1)"; RC=$?; rc_fails "package-client.sh refuses it too"; absent "$D/pk" "and builds nothing"
}
bad_gin '["10.1.0.0/16"]' "overlaps 10.0.0.0/8"; bad_gin '["203.0.113.0/24"]' "overlaps 203.0.113.0/24"; bad_gin '["198.51.101.1/24"]' "not a block"
bad_gin '["198.51.101.0/7"]' "/8 to /32"; bad_gin '["198.51.101.0"]' "first address and a prefix"; bad_gin '["2001:db8::/32"]' "first address and a prefix"
bad_gin '["198.51.101.0/24","198.51.101.0/25"]' "overlap"; bad_gin '["192.0.9.0/24","192.0.10.0/24","192.0.11.0/24","192.0.12.0/24","192.0.13.0/24"]' "at most four"
bad_gin '"198.51.101.0/24"' "must be a list"; bad_gin '[5]' "must be a list"; bad_gin '["224.0.0.0/8"]' "overlaps 224.0.0.0/4"; bad_gin '["100.64.0.0/10"]' "overlaps 100.64.0.0/10"

section "round 4: model ids with Vertex forms, empty values"
fresh; catmod 'c["models"][3]["id"]="claude-sonnet-4-5@20250929"' "$S/models.json"; printf '{"gatewayUrl":"https://gw.example.test"}' > "$S/defaults.json"
run install --yes --model sonnet-4-6; rc_is 0 "an id with @date (the Vertex form of older Claude ids) is accepted"
json_is "$(MF)" '"claude-sonnet-4-5@20250929" in d["availableModels"]' true "and allowed in the policy"; json_is "$(UF)" 'd["model"]' "claude-sonnet-4-5@20250929" "and usable as a personal model"
OUT="$("$PKG" --gateway-url https://gw.example.test --models "$S/models.json" --out "$D/pk" 2>&1)"; RC=$?; rc_is 0 "package-client.sh builds it"
run model "claude-sonnet-4-5@20250929"; rc_is 0 "model <id with @>"
for badid in 'a$b' 'a;b' 'a b' 'a`b' 'a"b' "a'b" 'a\\b' 'a|b' 'a&b' 'a<b' 'a(b' 'a*b'; do
  fresh; catmod "c['models'][3]['id']=$(python3 -I -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$badid")" "$S/models.json"
  run_out print-managed --gateway-url https://gw.example.test; rc_fails "an id with a shell/JSON-special character is still refused: $badid"
done
fresh; run install --yes --gateway-url https://gw.example.test --model ""; rc_fails "--model with an empty value is an error, not 'unset'"; has "--model needs"; absent "$M" "nothing written"
for dv in null '""'; do
  fresh; catmod "c['default']=$( [ "$dv" = null ] && echo None || echo '""' )" "$S/models.json"
  run install --yes --gateway-url https://gw.example.test; rc_fails "a catalog with default $dv is refused (API and Terraform refuse it too)"; has "\"default\" is empty"; absent "$M" "nothing written for default $dv"
done

section "round 4: an unpinned family is called out"
fresh; catmod 'for m in c["models"]:
    if m["alias"]=="sonnet-4-6": m["pin"]=False' "$S/models.json"
run install --yes --gateway-url https://gw.example.test; rc_is 0 "a legal catalog that leaves sonnet unpinned installs"; has "no model pins the sonnet family (sonnet, sonnet-4-6)" "with a warning naming the family and its entries"
run update --yes; has "no model pins the sonnet family" "update warns too"
run status; has "no model pins the sonnet family" "status warns too"
run print-managed --gateway-url https://gw.example.test; has "no model pins the sonnet family" "print-managed warns on stderr"
fresh; run install --yes --gateway-url https://gw.example.test; lacks "no model pins" "the shipped catalog has no warning"
fresh; catmod "$RECIPE" "$S/models.json"; run install --yes --gateway-url https://gw.example.test; lacks "no model pins" "the recipe moves the pin, so there is no warning"

section "round 4: uninstall after the catalog changed blames the catalog, not an admin"
fresh; run install --yes --gateway-url https://gw.example.test; catmod "$LEGACY" "$D/recipe.json"
run uninstall --yes --models "$D/recipe.json"; rc_is 0 "uninstall with a different catalog than the one installed"
lacks "an admin changed them." "no longer blames 'an admin' alone"; has "another version or model catalog wrote them" "names the catalog as a cause"; has "sign-in lock itself is gone" "says the lock is already gone"; has "uninstall --force" "and offers --force in the same message"
json_is "$(MF)" '"forceLoginGatewayUrl" in d' false "the lock keys were removed"; json_is "$(MF)" '"availableModels" in d' true "the model list was left"
run uninstall --yes --force; absent "$(MF)" "--force finishes it (nothing else was in the file, so it is removed)"
fresh; run install --yes --gateway-url https://gw.example.test; python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["allowedProviders"]=["gateway","bedrock"]; json.dump(d,open(p,"w"))' "$(MF)"
run uninstall --yes; has "STILL LOCKED" "if a lock key was left alone, it says the machine is still locked"

section "housekeeping"
fresh; run --help; rc_is 0 "--help"; has "install"; has "--dry-run"
run bogus; rc_fails "unknown command fails"; run install --nope; rc_fails "unknown option fails"
if [ -f "$ROOT/config/models.json" ]; then cmp -s "$ROOT/config/models.json" "$CLIENT/models.json" && pass "client/models.json matches config/models.json" || printf '  NOTE client/models.json differs from config/models.json (copy it: cp config/models.json client/models.json)\n'; fi
[ -z "$(find "$T"/c*/home -mindepth 1 2>/dev/null | head -1)" ] && pass "the temp HOME was never written to (nothing resolved to ~/.claude)" || fail "something wrote under the temp HOME"
AFTER="$(snapshot)"; equal "$AFTER" "$BEFORE" "real /Library/Application Support/ClaudeCode, /etc/claude-code and ~/.claude are unchanged"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
