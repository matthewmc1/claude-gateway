#!/usr/bin/env bash
# Point Claude Code at the company Claude gateway and manage the two things engineers may change:
# which model they start on, and how much thinking effort it applies.
#
# For engineers the whole setup is:   ./claude-gateway-setup.sh install      (no arguments needed)
# The admin's defaults (gateway URL, model, effort, model catalog) are read from files next to this
# script, or are stamped into it by scripts/package-client.sh. Run with --help for every command.
#
# Two layers, on purpose:
#   SYSTEM policy (managed-settings.json, admin-owned, users cannot override): sign in through the
#     gateway only, no direct Anthropic/Vertex/Bedrock/API-key access, only the catalog's models.
#   USER settings (~/.claude/settings.json, yours to change): which model and effort you start with.
# macOS and Linux. Windows: claude-gateway-setup.ps1 (untested) or `print-managed` + your MDM tool.
#
# Trust model: an installer built by scripts/package-client.sh carries its gateway URL, model catalog and defaults
# inside. That stamped copy IGNORES a defaults.json / models.json next to it and the CLAUDE_GATEWAY_URL /
# CLAUDE_GATEWAY_MODELS environment variables, unless you pass --dev (or --allow-overrides), and then it says so.
# Only plain UI preferences from the admin's `userSettings` are ever merged into ~/.claude/settings.json.
set -euo pipefail

MIN_VERSION="2.1.285"        # first release with allowedProviders; the gateway sign-in itself needs 2.1.195+
SELF="claude-gateway-setup.sh"
MAX_BACKUPS=5

# --- stamped by scripts/package-client.sh (these stay empty in the source tree) ---
STAMP_GATEWAY_URL_B64=""
STAMP_MODELS_B64=""
STAMP_DEFAULTS_B64=""
# --- end stamped ---

SELF_PATH="${BASH_SOURCE[0]:-$0}"
if [ -f "$SELF_PATH" ]; then SCRIPT_DIR="$(cd "$(dirname "$SELF_PATH")" && pwd)"; else SCRIPT_DIR=""; fi

case "$(uname -s)" in
  Darwin) SYS_DIR_DEFAULT="/Library/Application Support/ClaudeCode" ;;
  Linux)  SYS_DIR_DEFAULT="/etc/claude-code" ;;
  *)      SYS_DIR_DEFAULT="" ;;
esac
SYS_DIR="${CLAUDE_MANAGED_DIR:-$SYS_DIR_DEFAULT}"            # overridable for testing
USER_DIR="${CLAUDE_USER_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
MANAGED_FILE="$SYS_DIR/managed-settings.json"
USER_FILE="$USER_DIR/settings.json"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; Z=$'\033[0m'; else G=""; R=""; Y=""; Z=""; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$Z" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$Z" "$*"; FAILED=1; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
FAILED=0
TMPFILES=()
cleanup_tmp() { local f; for f in "${TMPFILES[@]:-}"; do [ -n "$f" ] && rm -f -- "$f"; done; return 0; }
trap cleanup_tmp EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

command -v python3 >/dev/null || die "python3 is required (used to merge JSON safely)."

# Test guard: when the test suite sets CLAUDE_GATEWAY_TEST_ROOT, refuse to touch anything outside it
# and never escalate to sudo. The guard is inert for normal use.
if [ -n "${CLAUDE_GATEWAY_TEST_ROOT:-}" ]; then
  for _p in "$MANAGED_FILE" "$USER_FILE"; do
    case "$_p" in "$CLAUDE_GATEWAY_TEST_ROOT"/*) ;; *) die "TEST GUARD: $_p is outside $CLAUDE_GATEWAY_TEST_ROOT; refusing to continue";; esac
  done
fi

# ---------- the JSON engine (one python program; every JSON decision is made here) ----------
read -r -d '' PYSRC <<'PY' || true
import json, os, sys, re, ipaddress, socket
import urllib.parse as up

EFFORTS = ("low", "medium", "high", "xhigh")
PIN_ENV = (("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"), ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"), ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"))
OWNED_TOP = ("forceLoginMethod", "forceLoginGatewayUrl", "parentSettingsBehavior", "allowedProviders", "availableModels", "enforceAvailableModels")
BYPASS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY")
BUILTIN_CATALOG = {"default": "sonnet", "models": [
    {"alias": "sonnet", "id": "claude-sonnet-5-5", "label": "Sonnet 5.5", "tier": "default", "enabled": True},
    {"alias": "opus", "id": "claude-opus-5-5", "label": "Opus 5.5", "tier": "upgrade", "enabled": True},
    {"alias": "haiku", "id": "claude-haiku-5-5", "label": "Haiku 5.5", "tier": "fast", "enabled": True}]}
BUILTIN_DEFAULTS = {"gatewayUrl": "", "model": "sonnet", "effortLevel": "medium", "userSettings": {}}
DEFAULTS_KEYS = ("gatewayUrl", "model", "effortLevel", "userSettings")
# The ONLY user-level settings an admin's defaults may add to ~/.claude/settings.json. Harmless UI/behaviour
# preferences with plain scalar values. Anything that can run a command, redirect traffic or widen what
# Claude may do (hooks, statusLine, apiKeyHelper, env, permissions, mcpServers, enabledPlugins, ...) is refused.
ALLOWED_USER_KEYS = ("theme", "verbose", "alwaysThinkingEnabled", "includeCoAuthoredBy", "cleanupPeriodDays",
                     "outputStyle", "editorMode", "spinnerTipsEnabled", "prefersReducedMotion", "model", "effortLevel")
DANGEROUS_USER_KEYS = ("hooks", "statusLine", "apiKeyHelper", "env", "permissions", "mcpServers", "enabledPlugins",
                       "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "enableAllProjectMcpServers")

def die(msg):
    sys.stderr.write("error: %s\n" % msg); sys.exit(1)

def _no_const(c): raise ValueError("%s is not valid JSON" % c)       # NaN / Infinity are not JSON
def loads(s): return json.loads(s, parse_constant=_no_const)

def dumps(o, **kw):                                                   # never emit NaN/Infinity: the output must always be valid JSON
    try: return json.dumps(o, allow_nan=False, **kw)
    except ValueError as e: die("refusing to write invalid JSON (%s)" % e)

def env_json(name, src, fallback):
    s = os.environ.get(name, "")
    if not s.strip(): return fallback
    try: v = loads(s)
    except Exception as e: die("%s is not valid JSON (%s)" % (os.environ.get(src, name), e))
    return v

def load_file(path):
    if not os.path.exists(path): return {}
    try: cur = loads(open(path).read())
    except Exception as e: die("%s is not valid JSON (%s); fix or move it first" % (path, e))
    if not isinstance(cur, dict): die("%s must hold a JSON object" % path)
    return cur

NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")

def catalog():
    c = env_json("GW_CATALOG", "GW_CATALOG_SRC", BUILTIN_CATALOG)
    src = os.environ.get("GW_CATALOG_SRC", "model catalog")
    if isinstance(c, dict) and "default" in c and not (isinstance(c["default"], str) and NAME_RE.match(c["default"])): die("%s: \"default\" must be a model alias or id" % src)
    ms = c.get("models") if isinstance(c, dict) else None
    if not isinstance(ms, list) or not ms: die("%s has no \"models\" list" % src)
    out = []
    for m in ms:
        if not isinstance(m, dict) or not m.get("alias") or not m.get("id"): die("%s: every model needs an alias and an id" % src)
        for f in ("alias", "id"):
            if not isinstance(m[f], str) or not NAME_RE.match(m[f]):
                die("%s: model %s must be plain text of letters, digits, '.', '_' or '-' (1-64 characters, starting with a letter or digit)" % (src, f))
        for f in ("label", "tier"):
            if f in m and not (isinstance(m[f], str) and len(m[f]) <= 80 and m[f].isprintable()): die("%s: model %s must be short plain text on one line" % (src, f))
        if "enabled" in m and not isinstance(m["enabled"], bool): die("%s: model enabled must be true or false" % src)
        if m.get("enabled", True) is False: continue
        out.append(m)
    if not out: die("%s has no enabled models" % src)
    return c, out

BOOL_KEYS = ("verbose", "alwaysThinkingEnabled", "includeCoAuthoredBy", "spinnerTipsEnabled", "prefersReducedMotion")
ENUM_KEYS = {"editorMode": ("normal", "vim")}
TEXT_KEYS = {"theme": re.compile(r"[a-z][a-z0-9-]{0,31}\Z"), "outputStyle": re.compile(r"[A-Za-z][A-Za-z0-9 _-]{0,31}\Z"),
             "model": NAME_RE}

def check_user_settings(us, src):
    for k, v in us.items():
        if k in DANGEROUS_USER_KEYS:
            die("%s: userSettings key '%s' is not allowed: it can run commands or redirect Claude Code on every engineer's machine. "
                "Allowed keys: %s" % (src, k, ", ".join(ALLOWED_USER_KEYS)))
        if k not in ALLOWED_USER_KEYS:
            die("%s: userSettings key '%s' is not on the allow-list. Allowed keys: %s" % (src, k, ", ".join(ALLOWED_USER_KEYS)))
        if k in BOOL_KEYS:
            if not isinstance(v, bool): die("%s: userSettings.%s must be true or false" % (src, k))
        elif k == "cleanupPeriodDays":
            if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 3650:
                die("%s: userSettings.cleanupPeriodDays must be a whole number of days between 1 and 3650" % src)
        elif k == "effortLevel":
            if v not in EFFORTS: die("%s: userSettings.effortLevel must be one of %s" % (src, ", ".join(EFFORTS)))
        elif k in ENUM_KEYS:
            if v not in ENUM_KEYS[k]: die("%s: userSettings.%s must be one of %s" % (src, k, ", ".join(ENUM_KEYS[k])))
        else:
            if not (isinstance(v, str) and TEXT_KEYS[k].match(v)): die("%s: userSettings.%s must be short plain text (letters, digits, '-')" % (src, k))

def defaults():
    raw = env_json("GW_DEFAULTS", "GW_DEFAULTS_SRC", {})
    src = os.environ.get("GW_DEFAULTS_SRC", "defaults")
    if not isinstance(raw, dict): die("%s must hold a JSON object" % src)
    for k in raw:
        if not k.startswith("_") and k not in DEFAULTS_KEYS:
            die("%s: unknown key '%s' (allowed: %s)" % (src, k, ", ".join(DEFAULTS_KEYS)))
    d = dict(BUILTIN_DEFAULTS); d.update({k: v for k, v in raw.items() if not k.startswith("_")})
    if d["effortLevel"] not in EFFORTS: die("%s: effortLevel must be one of %s" % (src, ", ".join(EFFORTS)))
    if not isinstance(d["userSettings"], dict): die("%s: userSettings must be an object" % src)
    check_user_settings(d["userSettings"], src)
    if not isinstance(d["gatewayUrl"], str): die("%s: gatewayUrl must be a string" % src)
    return d

def find_model(x):
    if not isinstance(x, str): return None
    _, ms = catalog(); x = x.strip()
    for m in ms:
        if x == m["id"] or x.lower() == m["alias"].lower(): return m
    return None

def resolve(x):
    m = find_model(x)
    if m: return m
    _, ms = catalog()
    die("unknown model '%s'. Choose one of: %s (or its full id). These are the models this company allows." % (x, ", ".join(a["alias"] for a in ms)))

def default_model():
    c, ms = catalog(); d = defaults()
    want = d.get("model") or c.get("default") or ms[0]["alias"]
    m = find_model(want)
    if not m: die("the default model '%s' is not an enabled model in the catalog (%s)" % (want, ", ".join(a["alias"] for a in ms)))
    return m

def policy(url):
    _, ms = catalog(); dm = default_model()
    ids = [dm["id"]] + [m["id"] for m in ms if m["id"] != dm["id"]]
    env = {}
    for alias, key in PIN_ENV:
        for m in ms:
            if m["alias"] == alias: env[key] = m["id"]
    p = {"forceLoginMethod": "gateway", "forceLoginGatewayUrl": url, "parentSettingsBehavior": "merge",
         "allowedProviders": ["gateway"], "availableModels": ids, "enforceAvailableModels": True}
    if env: p["env"] = env
    return p

def deep(dst, src, fill):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict): deep(dst[k], v, fill)
        elif fill and k in dst: continue
        else: dst[k] = v

def show(v):
    if v is None: return "(missing)"
    if isinstance(v, list): return "[" + ", ".join(str(i) for i in v) + "]"
    return str(v)

def diff(d, want):
    out = []
    for k, v in want.items():
        if k != "env" and d.get(k) != v: out.append((k, "%s: installed %s, expected %s" % (k, show(d.get(k)), show(v))))
    de = d.get("env") if isinstance(d.get("env"), dict) else {}
    we = want.get("env", {})
    for _, k in PIN_ENV:
        if de.get(k) != we.get(k): out.append((k, "env.%s: installed %s, expected %s" % (k, de.get(k, "(unset)"), we.get(k, "(unset)"))))
    return out

def emit(d): print(dumps(d, indent=2))

def c_check(): catalog(); defaults(); default_model()

HOST_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z")

def bad_url(u, why):
    die("not a valid gateway URL (%s). Use https://host[:port] with letters, digits, dots and hyphens only." % why)

NETLOC_RE = re.compile(r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?\Z")

def normalize_url(u):
    """Validate a gateway origin and return it in canonical (lower-case, no trailing slash) form; die with a clean message otherwise."""
    if "@" in u: die("the gateway URL must not contain a username or password")
    # Strict allow-list on the raw text FIRST (urlparse silently drops tabs/newlines and tolerates shell metacharacters).
    if not re.fullmatch(r"[A-Za-z0-9.:/\[\]-]+", u): bad_url(u, "it contains characters that are not allowed in a host name")
    try:
        p = up.urlparse(u); h = p.hostname or ""; port = p.port
    except ValueError: bad_url(u, "bad address or port")
    scheme = p.scheme.lower()
    if scheme not in ("http", "https") or not h: bad_url(u, "needs an http(s):// scheme and a host")
    if not NETLOC_RE.match(p.netloc): bad_url(u, "bad host or port (an empty port is not allowed)")
    if port is not None and not (1 <= port <= 65535): bad_url(u, "port out of range")
    h = h.lower()
    if p.netloc.startswith("["):                                   # IPv6 literal
        try: ipaddress.IPv6Address(h)
        except ValueError: bad_url(u, "bad IPv6 address")
    elif re.fullmatch(r"[0-9.]+", h):                              # IPv4 literal (digits and dots only)
        try: ipaddress.IPv4Address(h)
        except ValueError: bad_url(u, "bad IPv4 address")
    else:                                                          # DNS name
        if len(h) > 253 or not all(HOST_LABEL.match(l) for l in h.split(".")): bad_url(u, "bad host name")
    loop = h in ("localhost", "127.0.0.1", "::1")
    if scheme == "http" and not loop: die("http is only accepted for localhost; use the gateway's https:// address")
    if p.path not in ("", "/") or p.query or p.fragment or p.params: die("give the gateway origin only (https://host[:port]), with no path")
    return "%s://%s%s" % (scheme, ("[%s]" % h) if p.netloc.startswith("[") else h, (":%d" % port) if port is not None else "")

def c_validate_url(u): normalize_url(u)
def c_normalize_url(u): print(normalize_url(u))

def c_host_kind(u):
    h = up.urlparse(u).hostname
    try: ip = ipaddress.ip_address(h)
    except ValueError:
        if os.environ.get("CLAUDE_GATEWAY_NO_DNS"): print("unchecked"); return
        try: ip = ipaddress.ip_address(socket.gethostbyname(h))
        except Exception: print("unresolved"); return
    print("loopback" if ip.is_loopback else "private" if ip.is_private else "public")

def tsv(m): print("\t".join([m["id"], m.get("label") or m["alias"], m.get("tier") or ""]))

def c_upgrade_model():
    _, ms = catalog()
    for m in ms:
        if m.get("tier") == "upgrade": tsv(m); return
    die("the model catalog has no model with tier 'upgrade'; ask your admin, or choose one with: model <name>")

def c_merge_managed(path, url):
    cur = load_file(path); want = policy(url)
    env = cur.get("env") if isinstance(cur.get("env"), dict) else {}
    for _, k in PIN_ENV: env.pop(k, None)
    if env or "env" in cur: cur["env"] = env
    for k, v in want.items():
        if k == "env": cur.setdefault("env", {}).update(v)
        else: cur[k] = v
    if cur.get("env") == {}: cur.pop("env")
    emit(cur)

def c_user_install(path, no_user_settings):
    cur = load_file(path); d = defaults()
    if no_user_settings != "1":
        extra = {k: v for k, v in d["userSettings"].items() if k not in ("model", "effortLevel")}
        deep(cur, extra, True)
    if not find_model(cur.get("model")): cur["model"] = default_model()["id"]
    if cur.get("effortLevel") not in EFFORTS: cur["effortLevel"] = d["effortLevel"]
    emit(cur)

def c_user_set(path, *kv):
    cur = load_file(path)
    for k, v in zip(kv[0::2], kv[1::2]): cur[k] = v
    emit(cur)

def c_user_reset(path, which):
    cur = load_file(path)
    cur["model"] = default_model()["id"]
    if which == "all": cur["effortLevel"] = defaults()["effortLevel"]
    emit(cur)

def c_drift(path, url):
    for _, line in diff(load_file(path), policy(url)): print(line)

def c_status_policy(path):
    d = load_file(path)
    print("url:" + str(d.get("forceLoginGatewayUrl", "")))
    print(("ok:" if d.get("forceLoginMethod") == "gateway" else "bad:") + ("sign-in is forced through the gateway" if d.get("forceLoginMethod") == "gateway" else "forceLoginMethod is not 'gateway'"))
    print(("ok:other providers are blocked (allowedProviders = gateway only)" if d.get("allowedProviders") == ["gateway"] else "bad:allowedProviders does not lock to the gateway"))
    if not d.get("forceLoginGatewayUrl"): print("bad:no gateway URL in the policy")
    skip = ("forceLoginMethod", "allowedProviders", "forceLoginGatewayUrl")
    lines = [l for k, l in diff(d, policy(d.get("forceLoginGatewayUrl") or "https://unset.invalid")) if k not in skip]
    if lines:
        for l in lines: print("bad:policy is out of date with the model catalog/defaults, " + l)
        print("bad:refresh it with: update")
    else:
        print("ok:policy matches the model catalog. Allowed models: " + ", ".join(d.get("availableModels", [])))

def c_status_user(path):
    d = load_file(path); m = d.get("model"); dm = default_model()
    if not m: print("warn:no default model set; the policy default applies (%s)" % dm["id"])
    else:
        f = find_model(m)
        if not f: print("bad:your default model '%s' is not in the company catalog, so the policy blocks it. Fix with: reset" % m)
        elif f["id"] == dm["id"]: print("ok:default model: %s (company default)" % f.get("label", f["id"]))
        else: print("ok:default model: %s (your choice; company default is %s)" % (f.get("label", f["id"]), dm.get("label", dm["id"])))
    e = d.get("effortLevel")
    print(("ok:effort: " + e) if e else "warn:effort not set; Claude's default applies")

def _unmanage(path, force):
    """Return (new content dict, [owned keys left alone]). Without force only values that still equal what the installer
    writes are removed; anything an admin changed since is left alone."""
    d = load_file(path); left = []
    def good_url(v):
        try: sys.stderr = open(os.devnull, "w"); c_validate_url(v); return True
        except SystemExit: return False
        finally: sys.stderr = sys.__stderr__
    want = {}
    if not force:
        url = d.get("forceLoginGatewayUrl")
        try: want = policy(url if isinstance(url, str) and good_url(url) else "https://unset.invalid")
        except SystemExit: want = {}
    same = {"forceLoginMethod": lambda v: v == "gateway", "parentSettingsBehavior": lambda v: v == "merge",
            "allowedProviders": lambda v: v == ["gateway"], "enforceAvailableModels": lambda v: v is True,
            "forceLoginGatewayUrl": lambda v: isinstance(v, str) and good_url(v),
            "availableModels": lambda v: v == want.get("availableModels")}
    for k in OWNED_TOP:
        if k not in d: continue
        if force or same[k](d[k]): d.pop(k)
        else: left.append(k)
    env = d.get("env") if isinstance(d.get("env"), dict) else {}
    we = want.get("env", {})
    for _, k in PIN_ENV:
        if k not in env: continue
        if force or env[k] == we.get(k): env.pop(k)
        else: left.append("env." + k)
    if env: d["env"] = env
    else: d.pop("env", None)
    return d, left

def c_unmanage(path, force="0"):
    d, _ = _unmanage(path, force == "1")
    print(dumps(d, indent=2) if d else "{}")        # "{}" = nothing left: the caller removes the file (explicit, never empty)

def c_unmanage_left(path, force="0"):
    for k in _unmanage(path, force == "1")[1]: print(k)

def c_realpath(path): print(os.path.realpath(path))
def c_filemode(path):
    try: print("%o" % (os.stat(path).st_mode & 0o777))
    except OSError: print("")

def c_getkey(key):
    try: v = loads(sys.stdin.read()).get(key, "")
    except Exception: v = ""
    print(v if isinstance(v, str) else dumps(v))

def c_getfile(path, key):
    v = load_file(path).get(key, "")
    print(v if isinstance(v, str) else dumps(v))

def c_defaults_get(key):
    v = defaults().get(key, ""); print(v if isinstance(v, str) else dumps(v))

def c_bypass(path):
    d = load_file(path); env = d.get("env") if isinstance(d.get("env"), dict) else {}
    names = [k for k in BYPASS if k in env]
    if "apiKeyHelper" in d: names.append("apiKeyHelper")
    print(" ".join(names))

def c_default_effort(): print(defaults()["effortLevel"])
def c_default_model(): tsv(default_model())
def c_resolve(x): tsv(resolve(x))
def c_policy(url): emit(policy(url))
def c_b64(s):
    import base64; sys.stdout.write(base64.b64decode(s).decode())

cmd = sys.argv[1].replace("-", "_")
globals()["c_" + cmd](*sys.argv[2:])
PY
py() { python3 -I -c "$PYSRC" "$@"; }

# ---------- helpers ----------
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }   # version_ge have want
# Prints: nothing when Claude Code is not installed; "?" when it is installed but its version cannot be read
# (an unparseable answer must never pass the gate); otherwise the version number.
claude_version() {
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || return 0
  local out first; out="$("$CLAUDE_BIN" --version 2>/dev/null || true)"; first="$(printf '%s\n' "$out" | head -1 | awk '{print $1}')"
  if printf '%s' "$first" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.+-]*)?$'; then printf '%s\n' "${first%%[-+]*}"; else echo "?"; fi
}

usage() {
  cat <<EOF
Claude Code gateway setup

  $SELF install            set everything up (admin defaults are built in; no arguments needed)
  $SELF update             refresh the system policy from the model catalog
  $SELF status             check this machine end to end (also reports drift)
  $SELF upgrade            explicit step up to the catalog's upgrade model (e.g. Opus)
  $SELF downgrade          back to the company default model
  $SELF reset              back to the company default model and effort
  $SELF model <name|id>    choose your default model (sonnet, opus, haiku, or a catalog id)
  $SELF effort <level>     thinking effort: low | medium | high | xhigh
  $SELF print-managed      print the system policy JSON (for Jamf / Intune / Group Policy)
  $SELF uninstall          remove what install added to the system policy (values an admin changed since are left alone)
  $SELF print-lock-recovery  how to get Claude Code working again if the gateway is gone for good

Options:
  --gateway-url <url>      gateway origin; beats \$CLAUDE_GATEWAY_URL, defaults.json and the stamped value
  --defaults <file>        use this defaults file instead of defaults.json next to the script
  --models <file>          use this model catalog instead of models.json next to the script
  --dry-run                print exactly what would be written; change nothing
  --yes, -y                do not ask questions
  --no-user-settings       write the system policy only; leave ~/.claude/settings.json alone
  --force-old-claude       install even though Claude Code is older than $MIN_VERSION or its version cannot be read (the provider lock will NOT work on it; --yes does not override this)
  --force                  uninstall: also remove policy values that no longer match what this installer writes
  --dev, --allow-overrides let a company-stamped installer use a defaults.json/models.json next to it and the
                           CLAUDE_GATEWAY_URL / CLAUDE_GATEWAY_MODELS variables (for testing; a notice is printed)
EOF
}

# ---------- arguments ----------
FLAG_URL=""; FLAG_DEFAULTS=""; FLAG_MODELS=""; DRY=0; YES=0; NO_USER=0; DEV=0; FORCE_OLD=0; FORCE=0; ARG1=""; ARG2=""; NPOS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --gateway-url)      [ $# -ge 2 ] || die "--gateway-url needs a value"; FLAG_URL="$2"; shift 2;;
    --gateway-url=*)    FLAG_URL="${1#*=}"; shift;;
    --defaults)         [ $# -ge 2 ] || die "--defaults needs a file"; FLAG_DEFAULTS="$2"; shift 2;;
    --defaults=*)       FLAG_DEFAULTS="${1#*=}"; shift;;
    --models)           [ $# -ge 2 ] || die "--models needs a file"; FLAG_MODELS="$2"; shift 2;;
    --models=*)         FLAG_MODELS="${1#*=}"; shift;;
    --dry-run)          DRY=1; shift;;
    --yes|-y)           YES=1; shift;;
    --no-user-settings) NO_USER=1; shift;;
    --dev|--allow-overrides) DEV=1; shift;;
    --force-old-claude) FORCE_OLD=1; shift;;
    --force)            FORCE=1; shift;;
    --print-lock-recovery) ARG1="print-lock-recovery"; NPOS=$((NPOS+1)); shift;;
    -h|--help)          usage; exit 0;;
    -*)                 die "unknown option '$1' (see --help)";;
    *)                  NPOS=$((NPOS+1)); if [ "$NPOS" = 1 ]; then ARG1="$1"; elif [ "$NPOS" = 2 ]; then ARG2="$1"; else die "unexpected argument '$1'"; fi; shift;;
  esac
done
[ -n "$ARG1" ] || { usage; exit 1; }

# ---------- sources: model catalog, defaults, gateway ----------
# Trust model: a STAMPED installer (built by package-client.sh) ignores sibling files and environment overrides
# unless --dev/--allow-overrides is given; every override that is in use is announced on stderr.
STAMPED=0; [ -n "$STAMP_GATEWAY_URL_B64$STAMP_MODELS_B64$STAMP_DEFAULTS_B64" ] && STAMPED=1
USE_SIBLINGS=1; USE_ENV=1
if [ "$STAMPED" = 1 ] && [ "$DEV" != 1 ]; then USE_SIBLINGS=0; USE_ENV=0; fi
notice() { printf '  %s!%s %s\n' "$Y" "$Z" "$*" >&2; }
if [ "$STAMPED" = 1 ] && [ "$DEV" != 1 ]; then
  for _f in defaults.json models.json; do
    [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$_f" ] && notice "ignoring $SCRIPT_DIR/$_f: this is your admin's installer and its built-in settings win (use --dev to test with local files)."
  done
  [ -n "${CLAUDE_GATEWAY_URL:-}" ] && notice "ignoring the CLAUDE_GATEWAY_URL environment variable: this installer's gateway is built in (use --dev to override)."
  [ -n "${CLAUDE_GATEWAY_MODELS:-}" ] && notice "ignoring the CLAUDE_GATEWAY_MODELS environment variable: this installer's model catalog is built in (use --dev to override)."
fi
CATALOG_JSON=""; CATALOG_SRC="built-in table (claude-sonnet-5-5 / opus-5-5 / haiku-5-5)"; CATALOG_OVERRIDE=""
DEFAULTS_JSON=""; DEFAULTS_SRC="built-in defaults"; DEFAULTS_OVERRIDE=""
if [ -n "$FLAG_MODELS" ]; then [ -f "$FLAG_MODELS" ] || die "--models: no such file $FLAG_MODELS"; CATALOG_JSON="$(cat "$FLAG_MODELS")"; CATALOG_SRC="$FLAG_MODELS (--models)"; CATALOG_OVERRIDE=1
elif [ "$USE_ENV" = 1 ] && [ -n "${CLAUDE_GATEWAY_MODELS:-}" ]; then [ -f "$CLAUDE_GATEWAY_MODELS" ] || die "CLAUDE_GATEWAY_MODELS: no such file $CLAUDE_GATEWAY_MODELS"; CATALOG_JSON="$(cat "$CLAUDE_GATEWAY_MODELS")"; CATALOG_SRC="$CLAUDE_GATEWAY_MODELS (CLAUDE_GATEWAY_MODELS)"; CATALOG_OVERRIDE=1
elif [ "$USE_SIBLINGS" = 1 ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/models.json" ]; then CATALOG_JSON="$(cat "$SCRIPT_DIR/models.json")"; CATALOG_SRC="$SCRIPT_DIR/models.json"; CATALOG_OVERRIDE=1
elif [ -n "$STAMP_MODELS_B64" ]; then CATALOG_JSON="$(py b64 "$STAMP_MODELS_B64")" || die "the model catalog built into this installer is damaged"; CATALOG_SRC="the catalog built into this installer"
fi
if [ -n "$FLAG_DEFAULTS" ]; then [ -f "$FLAG_DEFAULTS" ] || die "--defaults: no such file $FLAG_DEFAULTS"; DEFAULTS_JSON="$(cat "$FLAG_DEFAULTS")"; DEFAULTS_SRC="$FLAG_DEFAULTS (--defaults)"; DEFAULTS_OVERRIDE=1
elif [ "$USE_SIBLINGS" = 1 ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/defaults.json" ]; then DEFAULTS_JSON="$(cat "$SCRIPT_DIR/defaults.json")"; DEFAULTS_SRC="$SCRIPT_DIR/defaults.json"; DEFAULTS_OVERRIDE=1
elif [ -n "$STAMP_DEFAULTS_B64" ]; then DEFAULTS_JSON="$(py b64 "$STAMP_DEFAULTS_B64")" || die "the defaults built into this installer are damaged"; DEFAULTS_SRC="the defaults built into this installer"
fi
if [ "$STAMPED" = 1 ]; then
  [ -n "$CATALOG_OVERRIDE" ] && notice "OVERRIDE: model catalog from $CATALOG_SRC instead of the one built into this installer."
  [ -n "$DEFAULTS_OVERRIDE" ] && notice "OVERRIDE: defaults from $DEFAULTS_SRC instead of the ones built into this installer."
fi
export GW_CATALOG="$CATALOG_JSON" GW_CATALOG_SRC="$CATALOG_SRC" GW_DEFAULTS="$DEFAULTS_JSON" GW_DEFAULTS_SRC="$DEFAULTS_SRC"
py check

GW_URL=""; GW_FROM=""
resolve_gateway() {   # first match wins: flag, env, defaults, stamped
  if [ -n "$FLAG_URL" ]; then GW_URL="$FLAG_URL"; GW_FROM="the --gateway-url flag"
    [ "$STAMPED" = 1 ] && notice "OVERRIDE: gateway from the --gateway-url flag instead of the one built into this installer."; return 0; fi
  if [ "$USE_ENV" = 1 ] && [ -n "${CLAUDE_GATEWAY_URL:-}" ]; then GW_URL="$CLAUDE_GATEWAY_URL"; GW_FROM="the CLAUDE_GATEWAY_URL environment variable"
    [ "$STAMPED" = 1 ] && notice "OVERRIDE: gateway from the CLAUDE_GATEWAY_URL environment variable (--dev) instead of the one built into this installer."; return 0; fi
  local d; d="$(py defaults-get gatewayUrl)"
  if [ -n "$d" ]; then GW_URL="$d"; GW_FROM="$DEFAULTS_SRC"
    [ "$STAMPED" = 1 ] && [ -n "$DEFAULTS_OVERRIDE" ] && notice "OVERRIDE: gateway from $DEFAULTS_SRC instead of the one built into this installer."; return 0; fi
  if [ -n "$STAMP_GATEWAY_URL_B64" ]; then GW_URL="$(py b64 "$STAMP_GATEWAY_URL_B64")" || die "the gateway address built into this installer is damaged"; GW_FROM="your admin (stamped into this installer)"; return 0; fi
}
need_gateway() {
  resolve_gateway
  [ -n "$GW_URL" ] || die "no gateway address is known for this installer.
       Ask your admin for the company installer, or give the address yourself:
         $SELF install --gateway-url https://<gateway>
       (Admins: scripts/package-client.sh --gateway-url https://<gateway> builds an installer with it built in.)"
  GW_URL="${GW_URL%/}"; GW_URL="$(py normalize-url "$GW_URL")" || exit 1   # lower-cased canonical form; the policy and everything stamped use it
}

# ---------- writing ----------
test_guard_path() { # test_guard_path <path>
  [ -n "${CLAUDE_GATEWAY_TEST_ROOT:-}" ] || return 0
  case "$1" in "$CLAUDE_GATEWAY_TEST_ROOT"/*) ;; *) die "TEST GUARD: $1 is outside $CLAUDE_GATEWAY_TEST_ROOT; refusing to continue";; esac
}
priv() {
  if [ -w "$SYS_DIR" ] || { [ ! -e "$SYS_DIR" ] && [ -w "$(dirname "$SYS_DIR")" ]; } || [ "$(id -u)" = 0 ]; then "$@"
  elif [ -n "${CLAUDE_GATEWAY_TEST_ROOT:-}" ]; then die "TEST GUARD: would need sudo for $SYS_DIR"
  else say "  (needs administrator rights to write $SYS_DIR)"; sudo "$@"; fi
}
confirm() {   # confirm <question>; yes without a terminal, with --yes, or on --dry-run
  if [ "$YES" = 1 ] || [ "$DRY" = 1 ] || [ ! -t 0 ]; then return 0; fi
  local a; printf '%s [Y/n] ' "$1"; read -r a || a=""
  case "$a" in ""|y|Y|yes|YES) return 0;; *) return 1;; esac
}
show_would() { say "  [dry run] would write $1:"; printf '%s\n' "$2" | sed 's/^/      /'; }

# The policy is handed to a root shell on STDIN and written into a root-owned directory (temp name there, then rename),
# so nothing a user can write sits between the sudo prompt and the final file. umask is fixed so the result is 0644.
PUT_SH='set -e; umask 022; t="$1.new.$$"; trap "rm -f \"\$t\"" EXIT; cat > "$t"; chmod 644 "$t"; mv -f "$t" "$1"'
rand_hex() { od -An -N4 -tx1 /dev/urandom | tr -d ' \n'; }
prune_backups() {   # keep the newest MAX_BACKUPS backups of the managed file
  local n=0 f
  while IFS= read -r f; do n=$((n+1)); [ "$n" -le "$MAX_BACKUPS" ] || priv rm -f -- "$f"; done < <(ls -1t "$MANAGED_FILE".bak.* 2>/dev/null || true)
}
backup_system() {   # backup name has a random suffix; mode 600
  BACKUP="$MANAGED_FILE.bak.$(date +%Y%m%d%H%M%S).$(rand_hex)"
  priv install -m 600 "$MANAGED_FILE" "$BACKUP" || die "could not back up $MANAGED_FILE; nothing was changed."
}
SYS_STATE=""; USER_STATE=""; BACKUP=""
write_system() {   # write_system <full file content>; empty content is refused (removal is remove_system, used only by a validated uninstall)
  local content="$1"
  [ -n "$content" ] || die "internal error: refusing to write an empty system policy; nothing was changed."
  if [ -f "$MANAGED_FILE" ] && [ "$(cat "$MANAGED_FILE")" = "$content" ]; then SYS_STATE=unchanged; return 0; fi
  if [ "$DRY" = 1 ]; then show_would "$MANAGED_FILE" "$content"; SYS_STATE=dry; return 0; fi
  ( umask 022; priv install -d -m 755 "$SYS_DIR" ) || die "could not create $SYS_DIR; nothing was changed."
  BACKUP=""
  if [ -f "$MANAGED_FILE" ]; then backup_system; SYS_STATE=updated; else SYS_STATE=created; fi
  printf '%s\n' "$content" | priv sh -c "$PUT_SH" sh "$MANAGED_FILE" || die "could not write $MANAGED_FILE."
  prune_backups
}
remove_system() {   # only for a validated uninstall whose result is explicitly "nothing left"
  if [ "$DRY" = 1 ]; then say "  [dry run] would remove $MANAGED_FILE (nothing else left in it)"; SYS_STATE=dry; return 0; fi
  backup_system; priv rm -f -- "$MANAGED_FILE"; SYS_STATE=removed; prune_backups
}
write_user() {     # write_user <full file content>; follows a symlinked settings.json and writes through to its target
  local content="$1" real tgtdir tmp mode
  [ -n "$content" ] || die "internal error: refusing to write empty user settings; nothing was changed."
  real="$USER_FILE"; [ -L "$USER_FILE" ] && real="$(py realpath "$USER_FILE")"
  test_guard_path "$real"
  if [ -f "$real" ] && [ "$(cat "$real")" = "$content" ]; then USER_STATE=unchanged; return 0; fi
  if [ "$DRY" = 1 ]; then show_would "$USER_FILE" "$content"; USER_STATE=dry; return 0; fi
  tgtdir="$(dirname "$real")"; mkdir -p "$tgtdir"
  tmp="$(mktemp "$tgtdir/.settings.XXXXXX")"; TMPFILES+=("$tmp")
  printf '%s\n' "$content" > "$tmp"
  mode="$(py filemode "$real")"; chmod "${mode:-600}" "$tmp"
  mv -f "$tmp" "$real"; USER_STATE=written
}
apply_user() {     # apply_user <command that prints the new settings...>; a failed command is an error, never "empty content"
  local c; c="$("$@")" || die "could not prepare $USER_FILE (see above); nothing was changed."
  write_user "$c"
}
user_get() { py getfile "$USER_FILE" "$1"; }

bypass_report() {
  local b="" v s
  for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_FOUNDRY; do
    [ -n "${!v:-}" ] && b="$b$v "
  done
  s="$(py bypass "$USER_FILE" 2>/dev/null || true)"
  [ -n "$b" ] && warn "set in this shell; the policy blocks them, remove them from your shell profile: $b"
  [ -n "$s" ] && warn "found in $USER_FILE (the policy blocks them; remove them from it): $s"
  [ -z "$b$s" ] && ok "no leftover API keys or direct-access settings found"
  return 0
}

# ---------- commands ----------
cmd_install() {
  [ -n "$SYS_DIR" ] || die "unsupported OS here; run 'print-managed' and deploy the JSON with your device-management tool."
  need_gateway
  say "Claude Code gateway setup"
  if [ "$DRY" = 1 ]; then say "(dry run: nothing will be written)"; fi
  say "  gateway   $GW_URL"
  say "            from $GW_FROM"
  say "  models    from $CATALOG_SRC"
  say "  defaults  from $DEFAULTS_SRC"
  local ver; ver="$(claude_version)"
  if [ -z "$ver" ]; then warn "Claude Code isn't installed yet (https://code.claude.com/docs/en/setup). Continuing; settings apply once it is."
  elif [ "$ver" != "?" ] && version_ge "$ver" "$MIN_VERSION"; then ok "Claude Code $ver"
  elif [ "$FORCE_OLD" = 1 ]; then warn "WARNING: Claude Code ${ver/\?/(version unreadable)} is older than $MIN_VERSION or unknown. The provider lock is INEFFECTIVE on it: other providers stay usable until it is updated. Continuing only because of --force-old-claude. Run: claude update"
  elif [ "$ver" = "?" ]; then die "could not read a version from '$CLAUDE_BIN --version', so the provider lock cannot be trusted to work. Nothing was changed.
       Run: claude update   (then install again), or install anyway with: $SELF install --force-old-claude   (--yes does not override this)"
  else die "Claude Code $ver is older than $MIN_VERSION, so the provider lock would be silently ineffective on it. Nothing was changed.
       Run: claude update   (then install again), or install anyway with: $SELF install --force-old-claude   (--yes does not override this)"; fi
  case "$(py host-kind "$GW_URL")" in
    loopback|private) ok "gateway address is loopback/private, which Claude Code accepts";;
    public) warn "$GW_URL resolves to a public address. Claude Code refuses to sign in to those; use the gateway's private address.";;
    unresolved) warn "could not resolve $GW_URL from here (VPN/proxy down?)";;
  esac
  # Build BOTH results before writing anything: a bad input (invalid JSON in either settings file) must stop the whole
  # install, never be mistaken for "empty content", and never leave the machine half-configured.
  local sys_c usr_c=""
  sys_c="$(py merge-managed "$MANAGED_FILE" "$GW_URL")" || die "could not prepare the system policy (see above); nothing was changed."
  [ -n "$sys_c" ] || die "the system policy came out empty; nothing was changed."
  if [ "$NO_USER" != 1 ]; then
    usr_c="$(py user-install "$USER_FILE" "$NO_USER")" || die "could not prepare your user settings (see above); nothing was changed."
    [ -n "$usr_c" ] || die "your user settings came out empty; nothing was changed."
  fi
  confirm "Write the system policy to $MANAGED_FILE (administrator rights may be needed)?" || die "cancelled; nothing was changed."

  write_system "$sys_c"
  case "$SYS_STATE" in
    created)   ok "system policy written: $MANAGED_FILE";;
    updated)   ok "system policy updated: $MANAGED_FILE (previous version kept as ${BACKUP##*/})";;
    unchanged) ok "system policy already up to date: $MANAGED_FILE";;
  esac
  local dmodel dlabel dtier before after
  IFS=$'\t' read -r dmodel dlabel dtier <<<"$(py default-model)"
  if [ "$NO_USER" = 1 ]; then say "  - skipped your user settings (--no-user-settings)"
  else
    before="$(user_get model)"
    write_user "$usr_c"
    after="$(printf '%s' "$usr_c" | py getkey model)"
    case "$USER_STATE" in
      unchanged) ok "your settings already match: $USER_FILE (model ${after:-$dmodel})";;
      written)   ok "your defaults written to $USER_FILE: model ${after:-$dmodel}, effort $(printf '%s' "$usr_c" | py getkey effortLevel)${before:+; kept your existing model choice if it is allowed}";;
    esac
  fi
  bypass_report
  say ""
  say "Next steps:"
  say "  1. Start Claude Code:  claude"
  say "  2. Run /login, press Enter on 'Cloud gateway', and sign in with your work account"
  say "     (if you used another login before, run /logout first)"
  say "  3. Check anything, any time:  $SELF status"
  say "  If the gateway is ever gone for good:  sudo bash $SELF uninstall   (see: $SELF print-lock-recovery)"
  [ "$DRY" = 1 ] && say "(dry run: nothing was written)"
  return 0
}

cmd_update() {
  [ -f "$MANAGED_FILE" ] || die "no system policy at $MANAGED_FILE yet; run: $SELF install"
  local inst url; inst="$(py getfile "$MANAGED_FILE" forceLoginGatewayUrl)" || die "could not read $MANAGED_FILE (see above); nothing was changed."
  if [ -n "$FLAG_URL" ]; then GW_URL="$(py normalize-url "${FLAG_URL%/}")" || exit 1; url="$GW_URL"; GW_FROM="the --gateway-url flag"
  elif [ -n "$inst" ]; then url="$(py normalize-url "${inst%/}")" || die "the gateway address in $MANAGED_FILE is not a valid origin (see above); nothing was changed."
  else need_gateway; url="$GW_URL"; fi
  say "Refreshing the system policy from $CATALOG_SRC"
  local d; d="$(py drift "$MANAGED_FILE" "$url")" || die "could not read $MANAGED_FILE (see above); nothing was changed."
  [ -n "$d" ] && printf '%s\n' "$d" | sed 's/^/  changed  /'
  [ -n "$FLAG_URL" ] && [ "$inst" != "$url" ] && say "  changed  gateway URL: $inst -> $url"
  confirm "Update $MANAGED_FILE?" || die "cancelled; nothing was changed."
  local c; c="$(py merge-managed "$MANAGED_FILE" "$url")" || die "could not prepare the system policy (see above); nothing was changed."
  write_system "$c"
  case "$SYS_STATE" in
    updated)   ok "system policy updated (previous version kept as ${BACKUP##*/})";;
    unchanged) ok "system policy already matches the catalog and defaults; nothing to do";;
  esac
  py status-user "$USER_FILE" 2>/dev/null | grep '^bad:' | sed 's/^bad:/  ! /' || true
  return 0
}

set_model() {   # set_model <alias|id>
  local info id label tier; info="$(py resolve "$1")"; IFS=$'\t' read -r id label tier <<<"$info"
  apply_user py user-set "$USER_FILE" model "$id"
  ok "default model is now $label ($id); applies to new sessions (inside a session use /model)"
  case "$tier" in
    upgrade) say "    $label costs more per request and uses your weekly/monthly budget faster. Go back with: $SELF downgrade";;
    fast)    say "    $label is the fastest and cheapest; use it for simple, high-volume tasks.";;
  esac
}
cmd_model() { [ -n "$ARG2" ] || die "usage: $SELF model <name|id>   (see: $SELF status)"; set_model "$ARG2"; }
cmd_upgrade() {
  local id label tier; IFS=$'\t' read -r id label tier <<<"$(py upgrade-model)"
  say "Stepping up to $label (explicit step; the company default stays your baseline)."
  set_model "$id"
  say "    Effort stays at $(user_get effortLevel); change it with: $SELF effort <low|medium|high|xhigh>"
}
cmd_downgrade() {
  local id label tier; IFS=$'\t' read -r id label tier <<<"$(py default-model)"
  apply_user py user-reset "$USER_FILE" model
  ok "default model is back to the company default: $label ($id)"
}
cmd_reset() {
  local id label tier; IFS=$'\t' read -r id label tier <<<"$(py default-model)"
  apply_user py user-reset "$USER_FILE" all
  ok "back to the company defaults: $label ($id), effort $(py default-effort)"
}
cmd_effort() {
  case "$ARG2" in low|medium|high|xhigh) ;; *) die "usage: $SELF effort <low|medium|high|xhigh>   (max is session-only: /effort max)";; esac
  apply_user py user-set "$USER_FILE" effortLevel "$ARG2"
  ok "thinking effort set to $ARG2 for new sessions (inside a session use /effort)"
}

cmd_status() {
  say "Claude Code gateway status"
  local ver; ver="$(claude_version)"
  if [ -z "$ver" ]; then bad "Claude Code not found on PATH"
  elif [ "$ver" = "?" ]; then bad "could not read a version from '$CLAUDE_BIN --version' (run: claude update)"
  elif version_ge "$ver" "$MIN_VERSION"; then ok "Claude Code $ver (>= $MIN_VERSION)"
  else bad "Claude Code $ver is older than $MIN_VERSION (run: claude update)"; fi

  if [ -f "$MANAGED_FILE" ]; then
    local gw="" line pol
    pol="$(py status-policy "$MANAGED_FILE" 2>&1)" || { bad "${pol#error: }"; pol=""; }
    while IFS= read -r line; do
      case "$line" in
        url:*) gw="${line#url:}"; [ -n "$gw" ] && ok "gateway URL: $gw";;
        ok:*)  ok "${line#ok:}";;
        warn:*) warn "${line#warn:}";;
        bad:*) bad "${line#bad:}";;
      esac
    done <<EOF
$pol
EOF
    resolve_gateway
    if [ -n "$GW_URL" ] && [ -n "$gw" ] && [ "${GW_URL%/}" != "$gw" ]; then
      bad "the installed gateway ($gw) differs from this installer's ($GW_URL, from $GW_FROM); switch with: $SELF install"
    fi
    if [ -n "$gw" ]; then
      if curl -fsS --max-time 5 "$gw/readyz" >/dev/null 2>&1; then ok "gateway reachable and ready"; else bad "cannot reach $gw/readyz (is the VPN/proxy up?). Claude Code stays locked to this gateway: if it is gone for good, recover with: sudo bash $SELF uninstall   (details: $SELF print-lock-recovery)"; fi
    fi
  else bad "no system policy at $MANAGED_FILE (run: $SELF install)"; fi

  local line usr
  usr="$(py status-user "$USER_FILE" 2>&1)" || { bad "${usr#error: }"; usr=""; }
  while IFS= read -r line; do
    case "$line" in ok:*) ok "${line#ok:}";; warn:*) warn "${line#warn:}";; bad:*) bad "${line#bad:}";; esac
  done <<EOF
$usr
EOF
  bypass_report
  say ""; say "Inside Claude Code, run /status: 'Login method' should read the Cloud gateway and show your work email."
  [ "$FAILED" = 0 ] || exit 1
}

cmd_print_managed() { need_gateway; py policy "$GW_URL"; }

cmd_uninstall() {
  if [ -f "$MANAGED_FILE" ]; then
    # Validate and compute first. A policy file that cannot be parsed is an error, never "nothing left to keep".
    local new left
    new="$(py unmanage "$MANAGED_FILE" "$FORCE")" || die "could not read $MANAGED_FILE (see above); nothing was changed."
    left="$(py unmanage-left "$MANAGED_FILE" "$FORCE")" || die "could not read $MANAGED_FILE (see above); nothing was changed."
    [ -n "$new" ] || die "internal error: empty result while preparing the uninstall; nothing was changed."
    confirm "Remove the gateway policy from $MANAGED_FILE?" || die "cancelled; nothing was changed."
    if [ "$new" = "{}" ]; then remove_system; else write_system "$new"; fi
    if [ "$DRY" != 1 ]; then
      if [ "$SYS_STATE" = unchanged ]; then ok "nothing to remove: no gateway policy values this installer wrote are left in $MANAGED_FILE"
      else ok "removed the gateway policy from $MANAGED_FILE (other settings in it were kept; a backup was saved)"; fi
    fi
    [ -z "$left" ] || warn "left alone because they no longer match what this installer writes (an admin changed them): $(printf '%s' "$left" | tr '\n' ' ')
      Remove them too with: $SELF uninstall --force"
  else warn "no system policy found at $MANAGED_FILE"; fi
  say "  Your user settings were left alone. Run /logout in Claude Code to drop the gateway session."
}

cmd_print_lock_recovery() {
  cat <<TXT
Claude Code is locked to the company gateway by the system policy file:
  $MANAGED_FILE
If the gateway is gone for good (or unreachable and you cannot wait), get Claude Code working again with:
  sudo bash $SELF uninstall            remove what this installer added (a backup is kept next to the file)
  sudo bash $SELF uninstall --force    also remove values that were changed since install
Then run /logout inside Claude Code. Without this installer: restore or delete the policy file as root
  (sudo rm "$MANAGED_FILE" removes ALL admin settings in it; prefer restoring the newest ${MANAGED_FILE##*/}.bak.* copy).
A machine managed by MDM gets its policy back at the next sync; ask your admin to change the policy there.
TXT
}

case "$ARG1" in
  install)        cmd_install;;
  update)         cmd_update;;
  status)         cmd_status;;
  upgrade)        cmd_upgrade;;
  downgrade)      cmd_downgrade;;
  reset)          cmd_reset;;
  model)          cmd_model;;
  effort)         cmd_effort;;
  print-managed)  cmd_print_managed;;
  uninstall)      cmd_uninstall;;
  print-lock-recovery) cmd_print_lock_recovery;;
  paths)          say "managed=$MANAGED_FILE"; say "user=$USER_FILE";;   # used by the test suite
  help)           usage;;
  *)              usage; exit 1;;
esac
