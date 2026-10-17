#!/usr/bin/env bash
# Build the engineer installer for YOUR gateway: one self-contained file with the gateway URL, the model
# catalog and the defaults stamped in, plus a SHA-256 checksum file. Host the output folder internally;
# engineers then run it with no arguments.
#
#   scripts/package-client.sh --gateway-url https://gateway.internal.example.com \
#       [--models config/models.json] [--defaults client/defaults.json] [--out dist/client] [--sign-key key.pem]
#
# Output (in --out):
#   claude-gateway-setup.sh     stamped installer (macOS/Linux)
#   claude-gateway-setup.ps1    stamped installer (Windows PowerShell; UNTESTED)
#   SHA256SUMS                  integrity only (detects a damaged download). It proves NOTHING about who made the
#                               files: anyone who can replace the installer can replace this file too.
#   *.sig                       only with --sign-key: detached openssl signatures (see client/README.md, "Trust model")
# The gateway URL, catalog and defaults are stamped in as base64 (never pasted into shell/PowerShell source), the URL
# must be a plain https host name or IP, and `userSettings` may only hold the allow-listed harmless keys.
# Nothing secret is embedded; the build refuses catalogs/defaults that look like they hold credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL=""; SIGN_KEY=""; MODELS="$ROOT/config/models.json"; DEFAULTS="$ROOT/client/defaults.json"; OUT="$ROOT/dist/client"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --gateway-url) [ $# -ge 2 ] || die "--gateway-url needs a value"; URL="$2"; shift 2;;
    --gateway-url=*) URL="${1#*=}"; shift;;
    --models) [ $# -ge 2 ] || die "--models needs a file"; MODELS="$2"; shift 2;;
    --models=*) MODELS="${1#*=}"; shift;;
    --defaults) [ $# -ge 2 ] || die "--defaults needs a file"; DEFAULTS="$2"; shift 2;;
    --defaults=*) DEFAULTS="${1#*=}"; shift;;
    --out) [ $# -ge 2 ] || die "--out needs a folder"; OUT="$2"; shift 2;;
    --out=*) OUT="${1#*=}"; shift;;
    --sign-key) [ $# -ge 2 ] || die "--sign-key needs a private key file"; SIGN_KEY="$2"; shift 2;;
    --sign-key=*) SIGN_KEY="${1#*=}"; shift;;
    -h|--help) usage; exit 0;;
    *) die "unknown argument '$1' (see --help)";;
  esac
done
[ -n "$URL" ] || { usage >&2; die "--gateway-url is required"; }
URL="${URL%/}"
[ -f "$MODELS" ] || die "model catalog not found: $MODELS"
[ -f "$DEFAULTS" ] || die "defaults file not found: $DEFAULTS"
command -v python3 >/dev/null || die "python3 is required"
if [ -n "$SIGN_KEY" ]; then
  [ -f "$SIGN_KEY" ] || die "signing key not found: $SIGN_KEY"
  command -v openssl >/dev/null || die "--sign-key needs openssl"
  openssl pkey -passin pass: -in "$SIGN_KEY" -noout >/dev/null 2>&1 || die "$SIGN_KEY is not a usable private key (PEM, RSA or EC; it must not need a passphrase prompt)"
fi
SRC_SH="$ROOT/client/claude-gateway-setup.sh"; SRC_PS="$ROOT/client/claude-gateway-setup.ps1"
[ -f "$SRC_SH" ] || die "missing $SRC_SH"

# Validate with the installer's own rules (URL shape, catalog, defaults); nothing is read or written on this machine.
# The installer prints the policy with the URL in its canonical (lower-case) form; that normalised form is what gets stamped.
POLICY="$(env -u CLAUDE_GATEWAY_URL -u CLAUDE_GATEWAY_MODELS "$SRC_SH" print-managed --gateway-url "$URL" --models "$MODELS" --defaults "$DEFAULTS")" \
  || die "the gateway URL, model catalog or defaults are not valid (see above)"
URL="$(printf '%s' "$POLICY" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["forceLoginGatewayUrl"])')" || die "could not read the validated gateway URL"
# A previous build in the same --out must not leave stale signatures or checksums that would now vouch for different bytes.
if [ -d "$OUT" ]; then rm -f -- "$OUT"/claude-gateway-setup.sh.sig "$OUT"/claude-gateway-setup.ps1.sig "$OUT"/SHA256SUMS "$OUT"/*.sig "$OUT"/*.sha256; fi

python3 -I - "$URL" "$MODELS" "$DEFAULTS" "$OUT" "$SRC_SH" "$SRC_PS" <<'PY'
import base64, json, os, re, sys
url, models, defaults, out, src_sh, src_ps = sys.argv[1:7]
# Belt and braces: the installer already refused anything but a plain host, but nothing below may ever see a
# character that matters to a shell or PowerShell. The value is also stamped base64-encoded, never as raw text.
if not re.fullmatch(r"https?://[A-Za-z0-9.:\[\]-]+", url): sys.exit("error: refusing to stamp a gateway URL with unexpected characters")
SECRET_KEY = re.compile(r"(secret|passw|api[_-]?key|auth[_-]?token|access[_-]?token|bearer|credential|private[_-]?key)", re.I)
SECRET_VAL = re.compile(r"(sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{16,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]+)")
def scan(node, where):
    if isinstance(node, dict):
        for k, v in node.items():
            if SECRET_KEY.search(k): sys.exit("error: %s has a key named '%s'; refusing to embed anything that looks like a secret" % (where, k))
            scan(v, where)
    elif isinstance(node, list):
        for v in node: scan(v, where)
    elif isinstance(node, str) and SECRET_VAL.search(node): sys.exit("error: %s holds a value that looks like a credential; refusing to embed it" % where)
def _no_const(c): raise ValueError("%s is not valid JSON" % c)
def load(path):
    try: return json.loads(open(path).read(), parse_constant=_no_const)
    except Exception as e: sys.exit("error: %s: %s" % (path, e))
cat = load(models); d = load(defaults)
ALIAS = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z"); ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}\Z")   # same as the installer
for m in (cat.get("models") if isinstance(cat, dict) and isinstance(cat.get("models"), list) else []):
    if not isinstance(m, dict) or not isinstance(m.get("alias"), str) or not ALIAS.match(m["alias"]): sys.exit("error: %s: every model alias must be plain text matching [A-Za-z0-9][A-Za-z0-9._-]{0,63}" % models)
    if not isinstance(m.get("id"), str) or not ID.match(m["id"]): sys.exit("error: %s: every model id must be plain text matching [A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}" % models)
scan(cat, models); scan(d, defaults)
os.makedirs(out, exist_ok=True)
d = {k: v for k, v in d.items() if k not in ("gatewayUrl", "_comment")}      # the URL is stamped separately
b64 = lambda o: base64.b64encode(json.dumps(o, separators=(",", ":"), allow_nan=False).encode()).decode()
catb, defb = b64(cat), b64(d)
urlb = base64.b64encode(url.encode()).decode()

def stamp(src, dst, patterns):
    s = open(src).read()
    for pat, val in patterns:
        if not re.fullmatch(r"[A-Za-z0-9+/=]*", val): sys.exit("error: internal: stamped value is not base64")
        q = "'" if "'" in pat else '"'
        s, n = re.subn(pat, lambda m: m.group(1) + val + q, s, count=1, flags=re.M)
        if n != 1: sys.exit("error: could not find the stamp marker %r in %s" % (pat, src))
    open(dst, "w").write(s)
    os.chmod(dst, 0o755)
stamp(src_sh, os.path.join(out, "claude-gateway-setup.sh"), [
    (r'^(STAMP_GATEWAY_URL_B64=")[^"]*"', urlb), (r'^(STAMP_MODELS_B64=")[^"]*"', catb), (r'^(STAMP_DEFAULTS_B64=")[^"]*"', defb)])
if os.path.exists(src_ps):
    stamp(src_ps, os.path.join(out, "claude-gateway-setup.ps1"), [
        (r"^(\$StampGatewayUrlB64 = ')[^']*'", urlb), (r"^(\$StampModelsB64 = ')[^']*'", catb), (r"^(\$StampDefaultsB64 = ')[^']*'", defb)])
PY

( cd "$OUT"
  files="claude-gateway-setup.sh"; [ -f claude-gateway-setup.ps1 ] && files="$files claude-gateway-setup.ps1"
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 $files > SHA256SUMS; else sha256sum $files > SHA256SUMS; fi )

if [ -n "$SIGN_KEY" ]; then
  for f in claude-gateway-setup.sh claude-gateway-setup.ps1; do
    [ -f "$OUT/$f" ] || continue
    openssl dgst -sha256 -passin pass: -sign "$SIGN_KEY" -out "$OUT/$f.sig" "$OUT/$f" || die "signing $f failed"
  done
fi

# Prove the stamped file resolves its gateway on its own (prints policy JSON only; installs nothing).
got="$(env -u CLAUDE_GATEWAY_URL -u CLAUDE_GATEWAY_MODELS "$OUT/claude-gateway-setup.sh" print-managed 2>&1 | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["forceLoginGatewayUrl"])')" \
  || die "the stamped installer failed its self-check"
[ "$got" = "$URL" ] || die "the stamped installer resolved '$got', expected '$URL'"

echo "Built installer for $URL in $OUT"
if [ "$MODELS" = "$ROOT/config/models.json" ] && [ -f "$ROOT/client/models.json" ] && ! cmp -s "$ROOT/config/models.json" "$ROOT/client/models.json"; then
  echo "note: client/models.json differs from config/models.json (this installer used config/models.json). Keep them identical: cp config/models.json client/models.json" >&2
fi
sed 's/^/  /' "$OUT/SHA256SUMS"
if [ -n "$SIGN_KEY" ]; then
  echo "Signed with $SIGN_KEY (detached .sig files). Publish this public-key fingerprint OUT OF BAND (not next to the files):"
  echo "  $(openssl pkey -in "$SIGN_KEY" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
  echo "Engineers verify with their copy of the public key:"
  echo "  openssl dgst -sha256 -verify company-installer.pub -signature claude-gateway-setup.sh.sig claude-gateway-setup.sh"
fi
cat <<EOF

SHA256SUMS only detects a damaged download; it says nothing about WHO produced the files. Host the folder on your own
HTTPS site (or push the installer with MDM), and publish the installer's SHA-256 out of band (intranet page, ticket,
chat) or sign it with --sign-key. See client/README.md, "Trust model". Engineers then run (no arguments):
  curl -fsSLO https://<your-host>/claude-gateway-setup.sh
  shasum -a 256 claude-gateway-setup.sh        # compare with the hash your admin published elsewhere
  bash claude-gateway-setup.sh install
EOF
