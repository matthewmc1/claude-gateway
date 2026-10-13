#!/usr/bin/env bash
# Tests for deploy/: the release-signature verification (with locally generated throwaway keys, no network), static checks
# on build-push.sh and the Dockerfiles, and the proxy (deploy/test/proxy.test.mjs, loopback only, ports 19360-19379).
#
#   deploy/test/run.sh
#
# Needs: bash, gpg, jq, node 20+. Nothing here touches your own GnuPG keyring, gcloud or the network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
for c in gpg jq node; do command -v "$c" >/dev/null || { echo "missing tool: $c" >&2; exit 2; }; done

# Unix sockets (gpg-agent, terraform plugins) fail on macOS when the path is too long: fail fast with a clear message.
T="${TMPDIR:-/tmp}"; T="${T%/}"
if (( ${#T} > 70 )); then echo "TMPDIR ($T) is too long (${#T} chars, max 70): gpg-agent socket paths would break. Unset TMPDIR or point it at a short directory such as /tmp." >&2; exit 2; fi
S="$(mktemp -d "$T/dp-test.XXXXXX")"
cleanup() { for h in "$S"/gen "$S"/gen2; do GNUPGHOME="$h" gpgconf --kill all >/dev/null 2>&1 || true; done; rm -rf "$S"; }
trap cleanup EXIT
chmod 700 "$S"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }
# accepts <description> <command...>: must succeed;  rejects <description> <command...>: must fail
accepts() { local d="$1"; shift; if "$@" >"$S/last.out" 2>&1; then ok "$d"; else bad "$d  [$(head -c 300 "$S/last.out")]"; fi; }
rejects() { local d="$1"; shift; if "$@" >"$S/last.out" 2>&1; then bad "$d (it was ACCEPTED)"; else ok "$d"; fi; }

unset GNUPGHOME
# shellcheck source=../lib/verify-release.sh
. "$DEPLOY/lib/verify-release.sh"

# ============================================================================================================================
section "release signature: key binding (throwaway keys)"
G="$S/gen"; mkdir -m 700 "$G"
UID_STR='Anthropic Claude Code Release Signing <security@anthropic.com>'
g() { GNUPGHOME="$G" gpg --batch --no-tty --quiet "$@"; }
primaries() { GNUPGHOME="$G" gpg --batch --list-keys --with-colons 2>/dev/null | awk -F: '$1=="pub"{w=1;next} $1=="sub"{w=0;next} $1=="fpr"&&w{print $10;w=0}'; }
g --version >/dev/null 2>&1 || { echo "gpg not usable" >&2; exit 2; }
# P = the legitimate signer (certify-only primary + a signing SUBKEY, like a real release key can be)
g --yes --passphrase '' --quick-generate-key "$UID_STR" ed25519 cert never >/dev/null 2>&1
FP="$(primaries | head -1)"
g --yes --passphrase '' --quick-add-key "$FP" ed25519 sign never >/dev/null 2>&1
SUBFP="$(GNUPGHOME="$G" gpg --batch --list-keys --with-colons 2>/dev/null | awk -F: '$1=="sub"{s=1;next} $1=="fpr"&&s{print $10;exit}')"
# A = the attacker: SAME user id, different key
g --yes --passphrase '' --quick-generate-key "$UID_STR" ed25519 sign never >/dev/null 2>&1
FA="$(primaries | grep -vx "$FP" | head -1)"
[[ "$FP" =~ ^[0-9A-F]{40}$ && "$FA" =~ ^[0-9A-F]{40}$ && "$FP" != "$FA" && "$SUBFP" =~ ^[0-9A-F]{40}$ ]] && ok "generated a legit key (with signing subkey) and an attacker key with the same user id" || { bad "key generation ($FP / $FA / $SUBFP)"; exit 1; }

g --armor --export "0x$FP" >"$S/P.asc"; g --armor --export "0x$FA" >"$S/A.asc"
cat "$S/P.asc" "$S/A.asc" >"$S/PA.asc"; cat "$S/A.asc" "$S/P.asc" >"$S/AP.asc"
SUM="$(printf 'a%.0s' $(seq 1 64))"
printf '{"version":"9.9.9","platforms":{"linux-x64":{"checksum":"%s"}}}\n' "$SUM" >"$S/manifest.json"
sign() { g --local-user "0x$1" --yes --detach-sign "${@:3}" --output "$2" "$S/manifest.json" 2>/dev/null; }
sign "$FP" "$S/by-P.sig"; sign "$FA" "$S/by-A.sig"
g --armor --local-user "0x$FP" --yes --detach-sign --output "$S/by-P.asc.sig" "$S/manifest.json"
M="$S/manifest.json"
PIN_SPACED="$(printf '%s' "$FP" | sed 's/..../& /g; s/ $//' | tr 'A-F' 'a-f')"   # lower case with spaces, like the pin in build-push.sh

# the OLD check from build-push.sh, kept here to show the attack it allowed
LEGACY_PIN="$(printf '%s' "$FP" | sed -E 's/(.{4})/\1 /g; s/(([0-9A-F]{4} ){5})/\1 /; s/ +$//')"   # the display format the old grep expected
legacy_verify() {   # <keyfile> <manifest> <sig>   (uid + fingerprint grep, then any "Good signature")
  local H; H="$(mktemp -d "$T/lg.XXXXXX")"; chmod 700 "$H"
  ( export GNUPGHOME="$H"
    gpg --import "$1" >/dev/null 2>&1
    gpg --fingerprint security@anthropic.com 2>/dev/null | grep -q "$LEGACY_PIN" || exit 1
    gpg --verify "$3" "$2" 2>&1 | grep -q "Good signature" )
  local rc=$?; GNUPGHOME="$H" gpgconf --kill all >/dev/null 2>&1; rm -rf "$H"; return $rc
}
accepts "PoC: the OLD logic accepts a manifest signed by the attacker when the key file holds both keys" legacy_verify "$S/PA.asc" "$M" "$S/by-A.sig"

V() { verify_release_manifest "$1" "$2" "$3" "$4" "${5-9.9.9}"; }   # the generated manifest says version 9.9.9
accepts  "legit signature, key file holds only the pinned key"                         V "$S/P.asc"  "$M" "$S/by-P.sig" "$FP"
accepts  "legit signature (armored), key file holds both keys (legit first)"           V "$S/PA.asc" "$M" "$S/by-P.asc.sig" "$FP"
accepts  "legit signature, key file holds both keys (attacker first)"                  V "$S/AP.asc" "$M" "$S/by-P.sig" "$FP"
accepts  "pin written lower-case with spaces is normalised"                            V "$S/P.asc"  "$M" "$S/by-P.sig" "$PIN_SPACED"
rejects  "attacker-signed manifest, key file holds both keys (the old PoC)"            V "$S/PA.asc" "$M" "$S/by-A.sig" "$FP"
rejects  "attacker-signed manifest, key file holds both keys (attacker first)"         V "$S/AP.asc" "$M" "$S/by-A.sig" "$FP"
rejects  "attacker-signed manifest, key file holds only the legit key"                 V "$S/P.asc"  "$M" "$S/by-A.sig" "$FP"
rejects  "attacker supplies its own key file (only the attacker key) and signature"    V "$S/A.asc"  "$M" "$S/by-A.sig" "$FP"
rejects  "legit signature but the key file lacks the pinned key"                       V "$S/A.asc"  "$M" "$S/by-P.sig" "$FP"
rejects  "pin = the attacker's fingerprint is not satisfied by the legit signature"    V "$S/PA.asc" "$M" "$S/by-P.sig" "$FA"
rejects  "pin = a SUBKEY fingerprint is refused (only the primary fingerprint binds)"  V "$S/PA.asc" "$M" "$S/by-P.sig" "$SUBFP"
cp "$M" "$S/tampered.json"; printf ' ' >>"$S/tampered.json"
rejects  "tampered manifest (legit signature)"                                         V "$S/P.asc"  "$S/tampered.json" "$S/by-P.sig" "$FP"
rejects  "malformed pin (too short)"                                                   V "$S/P.asc"  "$M" "$S/by-P.sig" "ABCD"
rejects  "empty pin"                                                                   V "$S/P.asc"  "$M" "$S/by-P.sig" ""
: >"$S/empty"
rejects  "empty signature file"                                                        V "$S/P.asc"  "$M" "$S/empty" "$FP"
rejects  "empty key file"                                                              V "$S/empty"  "$M" "$S/by-P.sig" "$FP"
rejects  "missing manifest"                                                            V "$S/P.asc"  "$S/none" "$S/by-P.sig" "$FP"
printf 'not a pgp key\n' >"$S/junk.asc"
rejects  "garbage key file"                                                            V "$S/junk.asc" "$M" "$S/by-P.sig" "$FP"
head -c 20 "$S/by-P.sig" >"$S/trunc.sig"
rejects  "truncated signature"                                                         V "$S/P.asc"  "$M" "$S/trunc.sig" "$FP"
accepts  "the signing SUBKEY signature was really made by the subkey (VALIDSIG names subkey, primary = pin)" bash -c "GNUPGHOME='$G' gpg --batch --status-fd=1 --verify '$S/by-P.sig' '$M' 2>/dev/null | awk '\$2==\"VALIDSIG\"{ if (\$3 != \"$SUBFP\" || \$NF != \"$FP\") exit 1 }'"

# an expired signing key must not verify (the whole check fails closed). Generated and used with a faked system clock in 2020.
G2="$S/gen2"; mkdir -m 700 "$G2"
GNUPGHOME="$G2" gpg --batch --no-tty --quiet --faked-system-time 20200101T120000 --passphrase '' --quick-generate-key "$UID_STR" ed25519 sign 1d >/dev/null 2>&1
FE="$(GNUPGHOME="$G2" gpg --batch --list-keys --with-colons 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}')"
GNUPGHOME="$G2" gpg --batch --no-tty --quiet --armor --export "$FE" >"$S/E.asc"
GNUPGHOME="$G2" gpg --batch --no-tty --quiet --faked-system-time 20200101T130000 --local-user "$FE" --detach-sign --output "$S/by-E.sig" "$M" 2>/dev/null
rejects  "signature by an EXPIRED pinned key"                                            V "$S/E.asc" "$M" "$S/by-E.sig" "$FE"

# a key revoked by its owner (revocation certificate generated non-interactively through --command-fd)
GNUPGHOME="$G" gpg --batch --no-tty --quiet --passphrase '' --quick-generate-key 'Revoked <r@example.com>' ed25519 sign never >/dev/null 2>&1
RFP="$(primaries | grep -vx -e "$FP" -e "$FA" | head -1)"
GNUPGHOME="$G" gpg --batch --no-tty --quiet --local-user "$RFP" --yes --detach-sign --output "$S/by-R.sig" "$M" 2>/dev/null
GNUPGHOME="$G" gpg --no-tty --quiet --yes --command-fd 0 --output "$S/R.rev" --gen-revoke "$RFP" >/dev/null 2>&1 <<<$'y\n0\n\ny\n' || true
GNUPGHOME="$G" gpg --batch --no-tty --quiet --armor --export "$RFP" >"$S/R.pub.asc"
if [[ -s "$S/R.rev" ]]; then
  cat "$S/R.pub.asc" "$S/R.rev" >"$S/R.asc"
  rejects "signature by a REVOKED pinned key" V "$S/R.asc" "$M" "$S/by-R.sig" "$RFP"
else
  bad "could not generate a revocation certificate for the revoked-key test"
fi

# the real, published key and the real signed manifest of the pinned release (public data fetched once, kept as fixtures)
REALPIN="$(grep -E '^FINGERPRINT=' "$DEPLOY/build-push.sh" | head -1 | sed -E 's/^FINGERPRINT="(.*)"$/\1/')"
accepts "the REAL pinned fingerprint in build-push.sh verifies the real manifest of 2.1.296" V "$DEPLOY/test/fixtures/claude-code.asc" "$DEPLOY/test/fixtures/manifest-2.1.296.json" "$DEPLOY/test/fixtures/manifest-2.1.296.json.sig" "$REALPIN" 2.1.296
rejects "the real manifest does not verify against an attacker's key pin" V "$DEPLOY/test/fixtures/claude-code.asc" "$DEPLOY/test/fixtures/manifest-2.1.296.json" "$DEPLOY/test/fixtures/manifest-2.1.296.json.sig" "$FA" 2.1.296
cp "$DEPLOY/test/fixtures/manifest-2.1.296.json" "$S/real-tampered.json"; sed -i.bak 's/"checksum": *"[0-9a-f]/"checksum":"0/' "$S/real-tampered.json" 2>/dev/null; rm -f "$S/real-tampered.json.bak"
rejects "the real manifest with a changed checksum is rejected" V "$DEPLOY/test/fixtures/claude-code.asc" "$S/real-tampered.json" "$DEPLOY/test/fixtures/manifest-2.1.296.json.sig" "$REALPIN" 2.1.296

# replay: a genuine, validly signed manifest of ANOTHER release must not be accepted for the requested one
rejects "a validly signed manifest of an older release is refused (replay)"            V "$S/P.asc" "$M" "$S/by-P.sig" "$FP" 9.9.8
rejects "the real signed 2.1.296 manifest is refused when 2.1.297 is requested"        V "$DEPLOY/test/fixtures/claude-code.asc" "$DEPLOY/test/fixtures/manifest-2.1.296.json" "$DEPLOY/test/fixtures/manifest-2.1.296.json.sig" "$REALPIN" 2.1.297
rejects "no expected version given is refused (fail closed)"                           V "$S/P.asc" "$M" "$S/by-P.sig" "$FP" ""
printf '{"platforms":{"linux-x64":{"checksum":"%s"}}}\n' "$SUM" >"$S/nover.json"; g --local-user "0x$FP" --yes --detach-sign --output "$S/nover.sig" "$S/nover.json" 2>/dev/null
rejects "a signed manifest without a version field is refused"                          V "$S/P.asc" "$S/nover.json" "$S/nover.sig" "$FP"
accepts "build-push.sh passes the requested IMAGE_TAG to the verifier"                 grep -q 'FINGERPRINT" "$IMAGE_TAG"' "$DEPLOY/build-push.sh"

# nothing left behind: no verification scratch directory, no agent for it
leftover="$(ls -d "$T"/vr.* 2>/dev/null | head -1 || true)"
[[ -z "$leftover" ]] && ok "verification scratch directories are removed on every exit path" || bad "left behind: $leftover"
if pgrep -f "gpg-agent.*(/vr\.)" >/dev/null 2>&1; then bad "a gpg-agent for a verification home is still running"; else ok "no gpg-agent for a verification home is left running"; fi

section "release checksum extraction"
accepts "checksum is read for linux-x64" bash -c ". '$DEPLOY/lib/verify-release.sh'; [[ \"\$(release_checksum '$M' linux-x64)\" == '$SUM' ]]"
rejects "unknown platform is refused" bash -c ". '$DEPLOY/lib/verify-release.sh'; release_checksum '$M' darwin-arm64"
printf '{"platforms":{"linux-x64":{"checksum":"zz"}}}' >"$S/badsum.json"
rejects "a non-SHA-256 checksum is refused" bash -c ". '$DEPLOY/lib/verify-release.sh'; release_checksum '$S/badsum.json' linux-x64"

# ============================================================================================================================
section "build-push.sh and the Dockerfiles (static)"
BP="$DEPLOY/build-push.sh"
accepts "build-push.sh parses (bash -n)" bash -n "$BP"
accepts "build-push.sh verifies through the library" grep -q 'verify_release_manifest' "$BP"
rejects "build-push.sh has no raw 'gpg --verify' / 'gpg --import' / uid-based fingerprint grep" grep -Eq 'gpg (--verify|--import|--fingerprint)|Good signature' "$BP"
rejects "build-push.sh has no bare curl (every download goes through vr_curl: https only, TLS 1.2+)" grep -E '(^|[^_a-z])curl ' "$BP"
accepts "vr_curl restricts protocol and TLS version" grep -q "curl --proto '=https' --tlsv1.2 -fsSL" "$DEPLOY/lib/verify-release.sh"
rejects "build-push.sh does not use 'npm install'" grep -q 'npm install' "$BP"
accepts "build-push.sh uses 'npm ci'" grep -q 'npm ci' "$BP"
rejects "build-push.sh no longer pushes a mutable :latest app tag" grep -q 'budget-app:latest' "$BP"
for d in Dockerfile.app Dockerfile.gateway; do
  accepts "$d: every FROM is pinned by sha256 digest" bash -c "grep -E '^FROM ' '$DEPLOY/$d' | grep -Eq '@sha256:[0-9a-f]{64}\$'"
done
accepts "app image runs Node 22" grep -Eq '^FROM node:22-' "$DEPLOY/Dockerfile.app"

# ============================================================================================================================
section "budget-app image tag rule (shared by build-push.sh and terraform's app_image_tag)"
for tg in 20261013093000 20261013 3f2a9c1 3f2a9c1d5e7b8a9c0d1e2f3a4b5c6d7e8f9a0b1c 1.4.0-build.7 1.4.0-rc1 2.0.0-20261013; do
  accepts "tag accepted: $tg" bash -c ". '$DEPLOY/lib/app-tag.sh'; app_tag_ok '$tg'"
done
for tg in latest LATEST Latest main Main master dev develop stable HEAD prod production staging canary nightly abc 12345 1234567x v1 1.2.3 1.0.0-main.3 deadbeef-dev 20261013-latest 'has space' 'a/b' '1.2.3-x' ''; do
  rejects "tag refused: '$tg'" bash -c ". '$DEPLOY/lib/app-tag.sh'; app_tag_ok \"\$1\"" _ "$tg"
done
accepts "build-push.sh validates APP_TAG with the rule" grep -q 'app_tag_ok "$APP_TAG"' "$DEPLOY/build-push.sh"
accepts "the default APP_TAG (UTC timestamp) satisfies the rule" bash -c ". '$DEPLOY/lib/app-tag.sh'; app_tag_ok \"\$(date -u +%Y%m%d%H%M%S)\""

# ============================================================================================================================
section "CI: pinned actions, versions, secret scan"
CI="$DEPLOY/../.github/workflows/ci.yml"
rejects "no GitHub Action is referenced by a mutable tag (every uses: is a 40-hex commit SHA)" bash -c "grep -E '^\\s*-?\\s*uses:' '$CI' | grep -Ev '@[0-9a-f]{40}( |\$)'"
accepts "setup-terraform sets an explicit terraform_version" grep -Eq 'terraform_version: *[0-9]+\.[0-9]+\.[0-9]+' "$CI"
accepts "tests run on Node 22 (the image's major)" grep -Eq 'node: 22' "$CI"
accepts "CI runs the deploy tests and the secret scan" bash -c "grep -q 'deploy/test/run.sh' '$CI' && grep -q 'secret-scan.sh' '$CI'"
accepts "dependabot watches the docker ecosystem for /deploy" bash -c "grep -A2 'package-ecosystem: docker' '$DEPLOY/../.github/dependabot.yml' | grep -q 'directory: /deploy'"
SC="$DEPLOY/../.github/scripts/secret-scan.sh"
mkdir -p "$S/scan-ok" "$S/scan-bad"
printf 'hello\nAKIA-example-placeholder\n' >"$S/scan-ok/readme.txt"
accepts "secret scan: a clean tree passes" env SECRET_SCAN_NO_GIT=1 bash "$SC" "$S/scan-ok"
# secrets are assembled at run time so this file itself never contains one
printf '%s%s\n' 'GOCSPX-' 'abcdefghijklmnopqrstuvwx' >"$S/scan-bad/oauth.txt"
rejects "secret scan: a Google OAuth client secret is caught" env SECRET_SCAN_NO_GIT=1 bash "$SC" "$S/scan-bad"
rm -f "$S/scan-bad/oauth.txt"; printf '%s%s\n' '-----BEGIN RSA ' 'PRIVATE KEY-----' >"$S/scan-bad/k.txt"
rejects "secret scan: a private key block is caught" env SECRET_SCAN_NO_GIT=1 bash "$SC" "$S/scan-bad"
rm -f "$S/scan-bad/k.txt"; printf '%s%s\n' 'AKIA' 'ABCDEFGHIJKLMNOP' >"$S/scan-bad/a.txt"
rejects "secret scan: an AWS access key id is caught" env SECRET_SCAN_NO_GIT=1 bash "$SC" "$S/scan-bad"
rm -f "$S/scan-bad/a.txt"; printf '{}' >"$S/scan-bad/terraform.tfstate"
rejects "secret scan: a tracked Terraform state file is caught" env SECRET_SCAN_NO_GIT=1 bash "$SC" "$S/scan-bad"
rm -f "$S/scan-bad/terraform.tfstate"; mkdir -p "$S/scan-bad/terraform"; printf 'x' >"$S/scan-bad/terraform/secrets.auto.tfvars"
rejects "secret scan: a tracked secrets.auto.tfvars is caught" env SECRET_SCAN_NO_GIT=1 bash "$SC" "$S/scan-bad"

# ============================================================================================================================
section "proxy (node --test, loopback only)"
if (cd "$DEPLOY/test" && node --test proxy.test.mjs >"$S/proxy.out" 2>&1); then
  ok "deploy/test/proxy.test.mjs: $(grep -E '^ℹ pass ' "$S/proxy.out" | sed 's/^ℹ //') tests, $(grep -E '^ℹ fail ' "$S/proxy.out" | sed 's/^ℹ //')"
else bad "deploy/test/proxy.test.mjs"; tail -40 "$S/proxy.out"; fi

section "proxy in a real browser (headless Chrome; skipped when none is installed)"
if (cd "$DEPLOY/test" && node --test browser.test.mjs >"$S/browser.out" 2>&1); then
  if grep -qE '^ℹ skipped [1-9]' "$S/browser.out"; then ok "browser tests skipped: no Chrome found (set CHROME=/path/to/chrome)"; else ok "deploy/test/browser.test.mjs: $(grep -E '^ℹ pass ' "$S/browser.out" | sed 's/^ℹ //') tests, $(grep -E '^ℹ fail ' "$S/browser.out" | sed 's/^ℹ //')"; fi
else bad "deploy/test/browser.test.mjs"; tail -40 "$S/browser.out"; fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL == 0 ]]
