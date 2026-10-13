# Verification of a Claude Code release manifest. SOURCED by deploy/build-push.sh (and by deploy/test/run.sh); needs
# bash, gpg and jq, and does no network I/O, so it can be tested with throwaway keys.
#
#   verify_release_manifest <keyfile.asc> <manifest> <manifest.sig> <pinned-fingerprint> <expected-version>
#       returns 0 ONLY when the detached signature was made by the key (or a signing subkey of the key) whose PRIMARY
#       fingerprint equals the pinned one. The pinned fingerprint is the trust anchor, never a user id or "some key in
#       the file": an attacker who controls the downloaded key file (or the manifest) can add keys with any user id, but
#       cannot make a key with the pinned fingerprint.
#   release_checksum <manifest> <platform>   prints the 64-hex SHA-256 for the platform, or fails
#   vr_curl <curl args...>                   curl restricted to https and TLS 1.2+, fails on HTTP errors
#
# How the binding works (every step fails closed):
#   1. the pinned fingerprint must be 40 hex digits;
#   2. `gpg --show-keys --with-colons` lists the PRIMARY fingerprints in the key file; the pinned one must be among them;
#   3. all keys are imported into a throwaway GNUPGHOME and ONLY the pinned key is exported into a second, clean one;
#   4. `gpg --status-fd=1 --verify` must print GOODSIG and a VALIDSIG whose primary-key fingerprint (last field) equals the
#      pinned one, and must print no BADSIG / ERRSIG / EXPKEYSIG / EXPSIG / REVKEYSIG / VALIDSIG for another key;
#   5. the signed manifest's "version" must equal the requested release (a validly signed manifest of an OLDER release, replayed by
#      whoever serves the download, is refused);
#   6. gpg-agent / dirmngr started in the throwaway homes are killed and the homes deleted on every exit path.

vr_curl() { curl --proto '=https' --tlsv1.2 -fsSL "$@"; }

vr_norm_fpr() { printf '%s' "$1" | tr -d '[:space:]' | tr 'a-f' 'A-F'; }

# primary fingerprints of every key in a key file, one per line
vr_primary_fprs() {   # <keyfile>
  gpg --batch --no-tty --show-keys --with-colons "$1" 2>/dev/null | awk -F: '
    $1 == "pub" { want = 1; next }
    $1 == "sub" { want = 0; next }
    $1 == "fpr" && want { print $10; want = 0 }'
}

verify_release_manifest() {   # <keyfile> <manifest> <sig> <fingerprint> <version>
  local keyfile="${1:-}" manifest="${2:-}" sig="${3:-}" fpr
  # a subshell: its EXIT trap cannot disturb the caller's traps, and GNUPGHOME stays local
  (
    set -euo pipefail
    err() { printf 'verify-release: %s\n' "$*" >&2; exit 1; }
    command -v gpg >/dev/null || err "gpg is not installed"
    [[ -s "$keyfile" ]]  || err "key file is missing or empty: $keyfile"
    [[ -s "$manifest" ]] || err "manifest is missing or empty: $manifest"
    [[ -s "$sig" ]]      || err "signature is missing or empty: $sig"
    fpr="$(vr_norm_fpr "${4:-}")"
    [[ "$fpr" =~ ^[0-9A-F]{40}$ ]] || err "the pinned fingerprint is not 40 hex digits"

    W="$(mktemp -d "${TMPDIR:-/tmp}/vr.XXXXXX")"; chmod 700 "$W"
    mkdir -m 700 "$W/all" "$W/pin"
    cleanup() {
      local h
      for h in "$W/all" "$W/pin"; do
        GNUPGHOME="$h" gpgconf --kill all >/dev/null 2>&1 || GNUPGHOME="$h" gpg-connect-agent killagent /bye >/dev/null 2>&1 || true
      done
      rm -rf "$W"
    }
    trap cleanup EXIT

    # 2. the pinned key must be present in the file, as a PRIMARY key
    local found; found="$(GNUPGHOME="$W/all" vr_primary_fprs "$keyfile" | grep -cx "$fpr" || true)"
    [[ "$found" == 1 ]] || err "the key file does not contain the pinned signing key ($fpr); refusing"

    # 3. import everything into a scratch home, export ONLY the pinned key, import that into a clean home
    GNUPGHOME="$W/all" gpg --batch --no-tty --quiet --import "$keyfile" >/dev/null 2>&1 || err "could not import the key file"
    GNUPGHOME="$W/all" gpg --batch --no-tty --export "0x$fpr" >"$W/pinned.gpg" 2>/dev/null || err "could not export the pinned key"
    [[ -s "$W/pinned.gpg" ]] || err "the pinned key could not be isolated"
    GNUPGHOME="$W/pin" gpg --batch --no-tty --quiet --import "$W/pinned.gpg" >/dev/null 2>&1 || err "could not import the pinned key"
    [[ "$(GNUPGHOME="$W/pin" gpg --batch --no-tty --list-keys --with-colons 2>/dev/null | awk -F: '$1=="pub"{n++} END{print n+0}')" == 1 ]] || err "the verification keyring does not hold exactly one key"

    # 4. verify and read gpg's machine-readable status
    local st
    st="$(GNUPGHOME="$W/pin" gpg --batch --no-tty --no-auto-key-retrieve --no-auto-key-locate --status-fd=1 --verify "$sig" "$manifest" 2>/dev/null)" \
      || err "the manifest signature is not valid"
    if grep -Eq '^\[GNUPG:\] (BADSIG|ERRSIG|EXPKEYSIG|EXPSIG|REVKEYSIG|NO_PUBKEY) ' <<<"$st"; then err "the signature is bad, expired, revoked or from an unknown key"; fi
    grep -q '^\[GNUPG:\] GOODSIG ' <<<"$st" || err "no good signature on the manifest"
    local valid other
    valid="$(awk '$1=="[GNUPG:]" && $2=="VALIDSIG" && $NF==f {n++} END{print n+0}' f="$fpr" <<<"$st")"
    other="$(awk '$1=="[GNUPG:]" && $2=="VALIDSIG" && $NF!=f {n++} END{print n+0}' f="$fpr" <<<"$st")"
    [[ "$valid" -ge 1 && "$other" == 0 ]] || err "the manifest was not signed by the pinned key ($fpr)"

    # 5. the (now authentic) manifest must be for the release that was asked for: no replay of an older signed manifest
    local want="${5:-}" got
    [[ -n "$want" ]] || err "the expected release version is required"
    got="$(jq -er '.version | strings' "$manifest" 2>/dev/null)" || err "the manifest has no version"
    [[ "$got" == "$want" ]] || err "the manifest is for version $got, not the requested $want (a replayed older manifest?)"
    exit 0
  )
}

release_checksum() {   # <manifest> <platform>
  local sum
  sum="$(jq -er --arg p "$2" '.platforms[$p].checksum' "$1" 2>/dev/null)" || { echo "verify-release: manifest has no checksum for $2" >&2; return 1; }
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || { echo "verify-release: manifest checksum for $2 is not a SHA-256" >&2; return 1; }
  printf '%s\n' "$sum"
}
