#!/usr/bin/env bash
# A simple, dependency-free secret scan for CI and for local use (no third-party action to trust or pin).
#
#   .github/scripts/secret-scan.sh [directory]      (default: the repository root)
#
# Scans tracked files (git ls-files, or every file outside node_modules/.git/.terraform when not in a git work tree) for
# well-known credential shapes, and fails when it finds one or when a file that must never be committed is tracked
# (Terraform state, terraform.tfvars, secrets.auto.tfvars, .env, private key files). It is a safety net, not a replacement
# for keeping secrets out of the repository: gitleaks or GitHub secret scanning find more. Output never prints the match.
set -uo pipefail
ROOT="${1:-.}"
cd "$ROOT" || exit 2

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [[ -z "${SECRET_SCAN_NO_GIT:-}" ]]; then
  list() { git ls-files -z; }
else
  list() { find . \( -name node_modules -o -name .git -o -name .terraform \) -prune -o -type f -print0; }
fi

# name<TAB>regex (ERE). Real secrets only: placeholders with lower-case or punctuation do not match the strict character classes.
PATTERNS=$'private key block\t-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----
GCP service-account key file\t"private_key_id"[[:space:]]*:[[:space:]]*"[0-9a-f]{20,}"
Google API key\tAIza[0-9A-Za-z_-]{35}
Google OAuth client secret\tGOCSPX-[0-9A-Za-z_-]{20,}
Google OAuth refresh token\t1//0[0-9A-Za-z_-]{40,}
AWS access key id\t(AKIA|ASIA)[0-9A-Z]{16}
GitHub token\t(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}
GitHub fine-grained token\tgithub_pat_[0-9A-Za-z_]{40,}
Slack token\txox[abprs]-[0-9A-Za-z-]{10,}
Anthropic API key\tsk-ant-[0-9A-Za-z_-]{20,}
bearer JWT\teyJ[0-9A-Za-z_-]{15,}\.eyJ[0-9A-Za-z_-]{15,}\.[0-9A-Za-z_-]{10,}'

# What gets READ: never state or variable files or .env (they are reported as forbidden when tracked, and never opened here).
scan_list() {
  list | while IFS= read -r -d '' f; do
    case "$f" in *.tfstate|*.tfstate.*|*terraform.tfvars|*terraform.tfvars.*|*secrets.auto.tfvars|*/.env|.env|*.pem|*.p12|*.pfx) continue;; esac
    printf '%s\0' "$f"
  done
}

fail=0
# files that must not be tracked at all
while IFS= read -r -d '' f; do
  case "$f" in
    *.tfstate|*.tfstate.*|*/terraform.tfvars|terraform.tfvars|*secrets.auto.tfvars|*/.env|.env|*.pem|*.p12|*.pfx|*id_rsa|*id_ed25519)
      echo "FORBIDDEN FILE tracked: $f"; fail=1;;
  esac
done < <(list)

while IFS=$'\t' read -r name re; do
  [[ -n "$re" ]] || continue
  hits="$(scan_list | xargs -0 grep -I -l -E -e "$re" -- 2>/dev/null | grep -Ev '^(\./)?\.github/scripts/secret-scan\.sh$' || true)"
  if [[ -n "$hits" ]]; then
    while IFS= read -r f; do echo "POSSIBLE SECRET ($name) in $f"; done <<<"$hits"
    fail=1
  fi
done <<<"$PATTERNS"

if [[ $fail == 0 ]]; then echo "secret scan: nothing found"; fi
exit $fail
