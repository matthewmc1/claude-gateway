#!/usr/bin/env bash
# Point Claude Code at the company Claude apps gateway, and manage the two things engineers may change:
# which 5.5 model they use, and how much thinking effort it applies.
#
#   claude-gateway-setup.sh install --gateway-url <url>   one-time setup (asks for sudo to write the system policy)
#   claude-gateway-setup.sh status                         check this machine end to end
#   claude-gateway-setup.sh upgrade                        explicit step up: default model -> Opus 5.5
#   claude-gateway-setup.sh model <sonnet|opus|haiku>      choose the default model (sonnet is the baseline)
#   claude-gateway-setup.sh effort <low|medium|high|xhigh> thinking effort (medium is the default)
#   claude-gateway-setup.sh print-managed --gateway-url <url>   print the system policy JSON (for Jamf/Intune/Group Policy)
#   claude-gateway-setup.sh uninstall                      remove what install added
#
# Two layers, on purpose:
#   SYSTEM policy (managed-settings.json, admin-owned, users can't override): sign in through the gateway
#     only, no direct Anthropic/Vertex/Bedrock/API-key access, and only the 5.5 models.
#   USER settings (~/.claude/settings.json, yours to change): which 5.5 model and what effort you start with.
# macOS and Linux. Windows: run print-managed and deploy the JSON with your device management tool.
set -euo pipefail

MIN_VERSION="2.1.285"        # first release with allowedProviders; the gateway sign-in itself needs 2.1.195+
SONNET="claude-sonnet-5-5"; OPUS="claude-opus-5-5"; HAIKU="claude-haiku-5-5"
DEFAULT_MODEL="$SONNET"; DEFAULT_EFFORT="medium"

case "$(uname -s)" in
  Darwin) SYS_DIR_DEFAULT="/Library/Application Support/ClaudeCode" ;;
  Linux)  SYS_DIR_DEFAULT="/etc/claude-code" ;;
  *)      SYS_DIR_DEFAULT="" ;;
esac
SYS_DIR="${CLAUDE_MANAGED_DIR:-$SYS_DIR_DEFAULT}"            # overridable for testing
USER_DIR="${CLAUDE_USER_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
MANAGED_FILE="$SYS_DIR/managed-settings.json"
USER_FILE="$USER_DIR/settings.json"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
FAILED=0

command -v python3 >/dev/null || die "python3 is required (used to merge JSON safely)."

# ---------- helpers ----------
gateway_url_arg() {   # parse --gateway-url from "$@"
  while [ $# -gt 0 ]; do case "$1" in --gateway-url) echo "${2:-}"; return;; --gateway-url=*) echo "${1#*=}"; return;; esac; shift; done
}
validate_url() {
  python3 - "$1" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); h = p.hostname or ""
loop = h in ("localhost", "127.0.0.1", "::1")
if p.scheme not in ("http", "https") or not h: sys.exit("not a valid URL: " + sys.argv[1])
if p.scheme == "http" and not loop: sys.exit("http is only accepted for localhost; use the gateway's https:// address")
if p.path not in ("", "/") : sys.exit("give the gateway origin only, with no path")
PY
}
host_kind() {   # prints: loopback | private | public
  python3 - "$1" <<'PY'
import sys, ipaddress, socket, urllib.parse as u
h = u.urlparse(sys.argv[1]).hostname
try: ip = ipaddress.ip_address(h)
except ValueError:
    try: ip = ipaddress.ip_address(socket.gethostbyname(h))
    except Exception: print("unresolved"); sys.exit()
print("loopback" if ip.is_loopback else "private" if ip.is_private else "public")
PY
}
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }   # version_ge have want
claude_version() { command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | awk '{print $1}' || true; }

managed_json() {   # desired system policy for a gateway URL
  python3 - "$1" "$SONNET" "$OPUS" "$HAIKU" <<'PY'
import json, sys
url, sonnet, opus, haiku = sys.argv[1:5]
print(json.dumps({
  "forceLoginMethod": "gateway",
  "forceLoginGatewayUrl": url,
  "parentSettingsBehavior": "merge",
  "allowedProviders": ["gateway"],
  "availableModels": [sonnet, opus, haiku],     # first entry is what "Default" resolves to
  "enforceAvailableModels": True,
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL": sonnet,
    "ANTHROPIC_DEFAULT_OPUS_MODEL": opus,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku,
  },
}, indent=2))
PY
}

merge_json() {   # merge_json <file> <overlay-json>  -> merged JSON on stdout (existing keys we don't own are kept)
  python3 - "$1" "$2" <<'PY'
import json, os, sys
path, overlay = sys.argv[1], json.loads(sys.argv[2])
cur = {}
if os.path.exists(path):
    try: cur = json.load(open(path))
    except Exception as e: sys.exit(f"{path} is not valid JSON ({e}); fix or move it first")
    if not isinstance(cur, dict): sys.exit(f"{path} must hold a JSON object")
for k, v in overlay.items():
    if k == "env" and isinstance(cur.get("env"), dict): cur["env"].update(v)
    else: cur[k] = v
print(json.dumps(cur, indent=2))
PY
}

json_kv() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@"; }   # json_kv k v [k v ...]

priv() { if [ -w "$SYS_DIR" ] || { [ ! -e "$SYS_DIR" ] && [ -w "$(dirname "$SYS_DIR")" ]; } || [ "$(id -u)" = 0 ]; then "$@"; else say "  (needs administrator rights to write $SYS_DIR)"; sudo "$@"; fi; }

write_system() {   # write_system <merged-json>
  local tmp; tmp="$(mktemp)"; printf '%s\n' "$1" > "$tmp"
  priv mkdir -p "$SYS_DIR"
  if [ -f "$MANAGED_FILE" ] && ! cmp -s "$tmp" "$MANAGED_FILE"; then
    priv cp "$MANAGED_FILE" "$MANAGED_FILE.bak.$(date +%Y%m%d%H%M%S)"; ok "kept a backup of the previous policy"
  fi
  priv install -m 644 "$tmp" "$MANAGED_FILE"; rm -f "$tmp"
}
write_user() {     # write_user <overlay-json>
  mkdir -p "$USER_DIR"
  local merged; merged="$(merge_json "$USER_FILE" "$1")"
  printf '%s\n' "$merged" > "$USER_FILE.tmp" && mv "$USER_FILE.tmp" "$USER_FILE"
}
user_get() { python3 - "$USER_FILE" "$1" <<'PY'
import json, os, sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))
except Exception: print("")
PY
}
resolve_model() {
  case "$1" in
    sonnet|"$SONNET") echo "$SONNET";; opus|"$OPUS") echo "$OPUS";; haiku|"$HAIKU") echo "$HAIKU";;
    *) die "unknown model '$1'. Choose sonnet, opus or haiku (the 5.5 models this company allows).";;
  esac
}
bypass_vars() {
  for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_FOUNDRY; do
    [ -n "${!v:-}" ] && printf '%s ' "$v"
  done; true
}

# ---------- commands ----------
cmd_install() {
  [ -n "$SYS_DIR" ] || die "unsupported OS here; run 'print-managed' and deploy the JSON with your device-management tool."
  local url; url="$(gateway_url_arg "$@")"; [ -n "$url" ] || die "usage: install --gateway-url https://<gateway>"
  url="${url%/}"; validate_url "$url"
  say "Claude Code gateway setup"
  local ver; ver="$(claude_version)"
  if [ -z "$ver" ]; then warn "Claude Code isn't installed yet (https://code.claude.com/docs/en/setup). Continuing; settings apply once it is."
  elif version_ge "$ver" "$MIN_VERSION"; then ok "Claude Code $ver"
  else warn "Claude Code $ver is older than $MIN_VERSION; the provider lock needs $MIN_VERSION+. Run: claude update"; fi

  case "$(host_kind "$url")" in
    loopback|private) ok "gateway address is loopback/private, which Claude Code accepts";;
    public) warn "$url resolves to a public address. Claude Code refuses to sign in to those; use the gateway's private address.";;
    *) warn "could not resolve $url from here";;
  esac

  write_system "$(merge_json "$MANAGED_FILE" "$(managed_json "$url")")"
  ok "system policy written: $MANAGED_FILE"
  local prev; prev="$(user_get model)"
  write_user "$(json_kv model "$DEFAULT_MODEL" effortLevel "$DEFAULT_EFFORT")"
  ok "your defaults: model $DEFAULT_MODEL, effort $DEFAULT_EFFORT${prev:+ (was: $prev)}"
  local b; b="$(bypass_vars)"; [ -n "$b" ] && warn "these environment variables are set in this shell and are ignored/blocked by the policy; remove them from your shell profile: $b"
  say ""
  say "Next: start Claude Code and run /login, press Enter on 'Cloud gateway', and sign in with your work account."
  say "If you used another login before, run /logout first. Check anything with: $0 status"
}

cmd_model() {
  local m; m="$(resolve_model "${1:-}")"
  write_user "$(json_kv model "$m")"
  ok "default model is now $m (applies to new sessions; inside a session use /model)"
  [ "$m" = "$OPUS" ] && say "  Opus 5.5 costs more per request; it counts against your weekly and monthly budget faster. Go back with: $0 model sonnet"
  [ "$m" = "$HAIKU" ] && say "  Haiku 5.5 is the fastest and cheapest; use it for simple, high-volume tasks."
  true
}
cmd_upgrade() {
  say "Upgrading your default model to Opus 5.5 (explicit step; Sonnet 5.5 stays the company baseline)."
  cmd_model opus
  say "  Effort stays at $(user_get effortLevel); change it with: $0 effort <low|medium|high|xhigh>"
}
cmd_effort() {
  case "${1:-}" in low|medium|high|xhigh) ;; *) die "usage: effort <low|medium|high|xhigh>   (max is session-only: /effort max)";; esac
  write_user "$(json_kv effortLevel "$1")"
  ok "thinking effort set to $1 for new sessions (inside a session use /effort)"
}

cmd_status() {
  say "Claude Code gateway status"
  local ver; ver="$(claude_version)"
  if [ -z "$ver" ]; then bad "Claude Code not found on PATH"
  elif version_ge "$ver" "$MIN_VERSION"; then ok "Claude Code $ver (>= $MIN_VERSION)"; else bad "Claude Code $ver is older than $MIN_VERSION (run: claude update)"; fi

  if [ -f "$MANAGED_FILE" ]; then
    local url; url="$(python3 - "$MANAGED_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); out = []
out.append("login=" + str(d.get("forceLoginMethod")))
out.append("providers=" + ",".join(d.get("allowedProviders", [])))
out.append("models=" + ",".join(d.get("availableModels", [])))
print(d.get("forceLoginGatewayUrl", "")); print(" ".join(out))
PY
)"
    local gw info; gw="$(printf '%s\n' "$url" | sed -n 1p)"; info="$(printf '%s\n' "$url" | sed -n 2p)"
    case "$info" in *login=gateway*) ok "sign-in forced through the gateway";; *) bad "forceLoginMethod is not 'gateway' in $MANAGED_FILE";; esac
    case "$info" in *providers=gateway*) ok "other providers blocked (allowedProviders = gateway only)";; *) bad "allowedProviders does not lock to the gateway";; esac
    case "$info" in *"$SONNET"*) ok "allowed models: $(printf '%s' "$info" | sed 's/.*models=//')";; *) bad "model allow-list missing $SONNET";; esac
    [ -n "$gw" ] && ok "gateway URL: $gw" || bad "no gateway URL in policy"
    if [ -n "$gw" ]; then
      if curl -fsS --max-time 5 "$gw/readyz" >/dev/null 2>&1; then ok "gateway reachable and ready"; else bad "cannot reach $gw/readyz (is the VPN/proxy up?)"; fi
    fi
  else bad "no system policy at $MANAGED_FILE (run: install --gateway-url ...)"; fi

  local m e; m="$(user_get model)"; e="$(user_get effortLevel)"
  [ "$m" = "$SONNET" ] && ok "default model: Sonnet 5.5 (baseline)" || { [ -n "$m" ] && ok "default model: $m (changed by you)" || warn "no default model set; policy default applies ($SONNET)"; }
  [ -n "$e" ] && ok "effort: $e" || warn "effort not set; 5.5 models default to medium"
  local b; b="$(bypass_vars)"; [ -n "$b" ] && warn "set in this shell (ignored by policy, remove them): $b" || ok "no direct-access environment variables set"
  say ""; say "Inside Claude Code, run /status: 'Login method' should read the Cloud gateway and show your work email."
  [ "$FAILED" = 0 ] || exit 1
}

cmd_uninstall() {
  if [ -f "$MANAGED_FILE" ]; then
    local cleaned; cleaned="$(python3 - "$MANAGED_FILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in ("forceLoginMethod", "forceLoginGatewayUrl", "parentSettingsBehavior", "allowedProviders", "availableModels", "enforceAvailableModels"): d.pop(k, None)
env = d.get("env", {})
for k in ("ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"): env.pop(k, None)
if env: d["env"] = env
else: d.pop("env", None)
print(json.dumps(d, indent=2) if d else "")
PY
)"
    if [ -z "$cleaned" ]; then priv rm -f "$MANAGED_FILE"; else write_system "$cleaned"; fi
    ok "removed gateway policy from $MANAGED_FILE"
  else warn "no system policy found"; fi
  say "  Your user settings were left alone. Run /logout in Claude Code to drop the gateway session."
}

case "${1:-}" in
  install)        shift; cmd_install "$@";;
  status)         cmd_status;;
  upgrade)        cmd_upgrade;;
  model)          shift; cmd_model "${1:-}";;
  effort)         shift; cmd_effort "${1:-}";;
  print-managed)  shift; u="$(gateway_url_arg "$@")"; [ -n "$u" ] || die "usage: print-managed --gateway-url <url>"; validate_url "${u%/}"; managed_json "${u%/}";;
  uninstall)      cmd_uninstall;;
  *)              sed -n '2,19p' "$0"; exit 1;;
esac
