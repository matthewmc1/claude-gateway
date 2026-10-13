#!/usr/bin/env bash
# Guided setup: asks a handful of questions and writes terraform.tfvars (and, for the OAuth client secret,
# secrets.auto.tfvars, mode 600, git-ignored). Then it checks the result the way `terraform plan` would, offline.
#
#   ./setup.sh                      interactive wizard
#   ./setup.sh --check [FILE]       check an existing terraform.tfvars (default: ./terraform.tfvars); writes nothing
#   ./setup.sh --non-interactive    no prompts; values come from flags or environment variables (for CI)
#
# Flags / environment (flag wins):
#   --project / PROJECT_ID               Google Cloud project id            (default: your active gcloud project)
#   --region / REGION                    Cloud Run + Cloud SQL region       (default: europe-west2)
#   --admins / ADMIN_EMAILS              comma-separated admin emails       (required)
#   --domains / ALLOWED_DOMAINS          comma-separated sign-in domains    (default: domain of the first admin)
#   --profile / PROFILE                  trial | production                 (REQUIRED, no default: see below)
#   --public-url / PUBLIC_URL            what Claude Code connects to       (default: http://localhost:8891)
#   --workspace-domain / WORKSPACE_DOMAIN  limit Google sign-in to this Workspace domain (optional)
#   --client-id / OIDC_CLIENT_ID         Google OAuth client id             (optional: blank = placeholder)
#   OIDC_CLIENT_SECRET                   the client secret (environment only, never a flag; or answer the hidden prompt)
#   --state-bucket / STATE_BUCKET        GCS bucket for Terraform state: writes backend.tf   (interactive default: <project>-tfstate;
#                                        'none' keeps a local state file, NOT recommended: the state holds generated passwords)
#   --create-state-bucket                also create that bucket (versioned, uniform access, no public access). It prints the exact
#                                        gcloud commands first and runs them only after you type "yes"
#   --confirm-create-state-bucket        the non-interactive form of that confirmation (never implied by --force)
#   --out-dir / SETUP_OUT_DIR            where to write the files           (default: this directory)
#   --force                              overwrite existing files without asking (old ones are backed up)
#   --skip-validate / SETUP_SKIP_VALIDATE=1   skip the offline terraform check
#
# The profile is a deliberate choice. trial = db-f1-micro, zonal, NO point-in-time recovery, NO database deletion protection, a
# state bucket that terraform destroy can empty, 1 warm gateway instance (max 2). production = regional HA database with PITR and
# deletion protection, 2 warm instances (max 6), protected state bucket, tighter alerts.
# The secret is never printed, never put on a command line and never written to terraform.tfvars.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=interactive; CHECK_FILE=""; FORCE=0; CREATE_BUCKET=0; CONFIRM_BUCKET=0
SKIP_VALIDATE="${SETUP_SKIP_VALIDATE:-0}"
OUT_DIR="${SETUP_OUT_DIR:-$HERE}"
V_PROJECT="${PROJECT_ID:-}"; V_REGION="${REGION:-}"; V_ADMINS="${ADMIN_EMAILS:-}"; V_DOMAINS="${ALLOWED_DOMAINS:-}"
V_PROFILE="${PROFILE:-}"; V_URL="${PUBLIC_URL:-}"; V_WS="${WORKSPACE_DOMAIN:-}"; V_CLIENT="${OIDC_CLIENT_ID:-}"
V_SECRET="${OIDC_CLIENT_SECRET:-}"; unset OIDC_CLIENT_SECRET
V_BUCKET="${STATE_BUCKET:-}"

say()  { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0;;
    --non-interactive) MODE=non;;
    --check) MODE=check; if [[ "${2:-}" != "" && "${2:-}" != --* ]]; then CHECK_FILE="$2"; shift; fi;;
    --force) FORCE=1;;
    --skip-validate) SKIP_VALIDATE=1;;
    --project) V_PROJECT="${2:?}"; shift;;
    --region) V_REGION="${2:?}"; shift;;
    --admins) V_ADMINS="${2:?}"; shift;;
    --domains) V_DOMAINS="${2:?}"; shift;;
    --profile) V_PROFILE="${2:?}"; shift;;
    --public-url) V_URL="${2:?}"; shift;;
    --workspace-domain) V_WS="${2:?}"; shift;;
    --client-id) V_CLIENT="${2:?}"; shift;;
    --state-bucket) V_BUCKET="${2:?}"; shift;;
    --create-state-bucket) CREATE_BUCKET=1;;
    --confirm-create-state-bucket) CONFIRM_BUCKET=1;;
    --out-dir) OUT_DIR="${2:?}"; shift;;
    *) die "unknown option $1 (try --help)";;
  esac
  shift
done

RE_PROJECT='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
RE_REGION='^[a-z]+-[a-z]+[0-9]+$'
RE_EMAIL='^[^@[:space:],"\\]+@[^@[:space:],"\\]+\.[^@[:space:],"\\]+$'
RE_DOMAIN='^[a-z0-9.-]+\.[a-z]{2,}$'
# Same rule as the public_url variable in variables.tf (the installer stamps this value into scripts): http only for
# localhost/127.0.0.1/[::1], else https; plain DNS labels; optional port; nothing else.
LABEL='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
RE_URL="^(http://(localhost|127\\.0\\.0\\.1|\\[::1\\])|https://(${LABEL}\\.)*${LABEL})(:[0-9]{1,5})?\$"
RE_BUCKET='^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$'
RE_CLIENT='^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'

# ---- offline check: the real validations, run in a scratch copy, with no credentials and no API calls --------------------
run_check() {   # run_check <tfvars> [secrets-tfvars]
  command -v terraform >/dev/null || { note "terraform is not installed: skipping the offline check"; return 0; }
  local tmp rc=0; tmp="$(mktemp -d)"
  mkdir -p "$tmp/tf" "$tmp/config"
  local f
  for f in "$HERE"/*.tf; do [[ "$(basename "$f")" == zz_imports.tf || "$(basename "$f")" == backend.tf ]] || cp "$f" "$tmp/tf/"; done
  cp -R "$HERE/modules" "$tmp/tf/modules"
  cp "$HERE/../config/models.json" "$tmp/config/models.json"
  cp "$1" "$tmp/tf/terraform.tfvars"
  [[ -n "${2:-}" && -f "${2:-}" ]] && cp "$2" "$tmp/tf/secrets.auto.tfvars" && chmod 600 "$tmp/tf/secrets.auto.tfvars"
  (
    cd "$tmp/tf"
    # A fake token: nothing here can reach your Google Cloud project. Refresh is off, so no API is called.
    unset GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CREDENTIALS GOOGLE_CLOUD_KEYFILE_JSON
    export GOOGLE_OAUTH_ACCESS_TOKEN=offline-check TF_IN_AUTOMATION=1 TF_INPUT=0 NO_COLOR=1
    # the image tag only exists after deploy/build-push.sh; the check uses a stand-in (a real value in terraform.tfvars wins)
    export TF_VAR_app_image_tag=00000000
    terraform init -backend=false -input=false -no-color >"$tmp/init.log" 2>&1 || { echo "INIT_FAILED" >"$tmp/status"; exit 0; }
    if ! terraform validate -no-color >"$tmp/validate.log" 2>&1; then echo "VALIDATE_FAILED" >"$tmp/status"; exit 0; fi
    if terraform plan -refresh=false -lock=false -input=false -no-color >"$tmp/plan.log" 2>&1; then echo OK >"$tmp/status"; else echo "PLAN_FAILED" >"$tmp/status"; fi
  )
  case "$(cat "$tmp/status" 2>/dev/null || echo UNKNOWN)" in
    OK) say "check passed: the configuration is valid and a plan against an empty project works (nothing was contacted)";;
    INIT_FAILED) note "warning: could not run 'terraform init' (offline?), so the values were not checked by Terraform:"; tail -5 "$tmp/init.log" >&2;;
    VALIDATE_FAILED) note "terraform validate failed:"; cat "$tmp/validate.log" >&2; rc=1;;
    PLAN_FAILED) note "your settings were rejected:"; grep -v '^$' "$tmp/plan.log" | sed -n '/Error/,$p' >&2; rc=1;;
    *) note "check did not complete"; rc=1;;
  esac
  rm -rf "$tmp"
  return $rc
}

if [[ "$MODE" == check ]]; then
  CHECK_FILE="${CHECK_FILE:-$OUT_DIR/terraform.tfvars}"
  [[ -f "$CHECK_FILE" ]] || die "no such file: $CHECK_FILE"
  SEC="$(dirname "$CHECK_FILE")/secrets.auto.tfvars"
  run_check "$CHECK_FILE" "$SEC"
  exit $?
fi

command -v python3 >/dev/null || die "python3 is required (used to write the files safely)"

# ---- gathering answers ---------------------------------------------------------------------------------------------------
INTERACTIVE=1; [[ "$MODE" == non ]] && INTERACTIVE=0

ask() {   # ask <var> <prompt> [default]   (reads one line from stdin; Enter or EOF takes the default)
  local __v="$1" __p="$2" __d="${3:-}" __a=""
  if [[ -n "$__d" ]]; then printf '%s [%s]: ' "$__p" "$__d" >&2; else printf '%s: ' "$__p" >&2; fi
  IFS= read -r __a || { __a=""; printf '\n' >&2; }
  printf -v "$__v" '%s' "${__a:-$__d}"
}

valid() {   # valid <regex> <value>
  [[ "$2" =~ $1 ]]
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
split_csv() { printf '%s' "$1" | tr ', ' '\n\n' | sed '/^$/d'; }

# project
if [[ -z "$V_PROJECT" ]] && command -v gcloud >/dev/null 2>&1; then
  GCP_DEFAULT="$(gcloud config get-value project 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$GCP_DEFAULT" == "(unset)" ]] && GCP_DEFAULT=""
else GCP_DEFAULT=""; fi
if [[ -z "$V_PROJECT" ]]; then
  if [[ $INTERACTIVE == 1 ]]; then
    note "Google Cloud project id (not the display name). The gateway and budget app are created in it."
    ask V_PROJECT "Project id" "$GCP_DEFAULT"
  else V_PROJECT="$GCP_DEFAULT"; fi
fi
valid "$RE_PROJECT" "$V_PROJECT" || die "project id '$V_PROJECT' is not a Google Cloud project id (6-30 lowercase letters, digits, hyphens)"

# region
[[ -n "$V_REGION" || $INTERACTIVE == 0 ]] || ask V_REGION "Region for Cloud Run and Cloud SQL" "europe-west2"
V_REGION="${V_REGION:-europe-west2}"
valid "$RE_REGION" "$V_REGION" || die "region '$V_REGION' does not look like a Google Cloud region (e.g. europe-west2)"

# admins
if [[ -z "$V_ADMINS" ]]; then
  [[ $INTERACTIVE == 1 ]] || die "ADMIN_EMAILS (or --admins) is required"
  note "Admins can sign in to the budget app and change budgets. Comma-separated emails."
  ask V_ADMINS "Admin emails" ""
fi
ADMIN_LIST="$(split_csv "$(lower "$V_ADMINS")")"
[[ -n "$ADMIN_LIST" ]] || die "give at least one admin email"
while IFS= read -r e; do valid "$RE_EMAIL" "$e" || die "'$e' is not a valid email address"; done <<<"$ADMIN_LIST"
[[ "$(sort <<<"$ADMIN_LIST" | uniq -d | wc -l | tr -d ' ')" == 0 ]] || die "the same admin email is listed twice"
FIRST_DOMAIN="${ADMIN_LIST%%$'\n'*}"; FIRST_DOMAIN="${FIRST_DOMAIN#*@}"

# domains
if [[ -z "$V_DOMAINS" ]]; then
  if [[ $INTERACTIVE == 1 ]]; then
    note "Only people with an email in these domains can sign in to the gateway."
    ask V_DOMAINS "Allowed email domains (comma-separated)" "${V_WS:-$FIRST_DOMAIN}"
  else V_DOMAINS="${V_WS:-$FIRST_DOMAIN}"; fi
fi
DOMAIN_LIST="$(split_csv "$(lower "$V_DOMAINS")")"
[[ -n "$DOMAIN_LIST" ]] || die "give at least one allowed email domain"
while IFS= read -r d; do valid "$RE_DOMAIN" "$d" || die "'$d' is not a domain such as example.com"; done <<<"$DOMAIN_LIST"

# profile: no default, on purpose (a forgotten "trial" means no PITR, no deletion protection, a deletable state bucket)
if [[ -z "$V_PROFILE" && $INTERACTIVE == 1 ]]; then
  note "Profile: choose deliberately, there is no default."
  note "  trial       db-f1-micro, zonal, NO point-in-time recovery, NO database deletion protection, state bucket that"
  note "              'terraform destroy' can empty and delete, 1 warm gateway instance (max 2), relaxed alerts. For a first look only."
  note "  production  regional HA database with point-in-time recovery and deletion protection, 2 warm instances (max 6),"
  note "              protected state bucket, tighter alerts."
  ask V_PROFILE "Profile (type trial or production)" ""
fi
[[ -n "$V_PROFILE" ]] || die "profile is required: choose trial or production (--profile / PROFILE). trial = no point-in-time recovery, no deletion protection, deletable state bucket; production = HA database with PITR and deletion protection"
V_PROFILE="$(lower "$V_PROFILE")"
[[ "$V_PROFILE" == trial || "$V_PROFILE" == production ]] || die "profile must be trial or production"

# public url
[[ -n "$V_URL" || $INTERACTIVE == 0 ]] || { note "The address Claude Code connects to. http://localhost:8891 works with deploy/proxy.sh; a team uses an internal https hostname."; ask V_URL "Public URL" "http://localhost:8891"; }
V_URL="${V_URL:-http://localhost:8891}"; V_URL="${V_URL%/}"
valid "$RE_URL" "$V_URL" || die "public url must look like http://localhost:8891 or https://claude.internal.example.com"
if [[ "$V_URL" =~ :([0-9]+)$ ]] && (( 10#${BASH_REMATCH[1]} < 1 || 10#${BASH_REMATCH[1]} > 65535 )); then die "public url must look like http://localhost:8891 or https://claude.internal.example.com (port 1-65535)"; fi

# google workspace domain (optional)
if [[ -z "$V_WS" && $INTERACTIVE == 1 ]]; then
  note "Optional: limit Google's account chooser to one Workspace domain (leave blank for none, e.g. for personal Gmail accounts)."
  ask V_WS "Google Workspace domain" ""
fi
V_WS="$(lower "$V_WS")"
[[ -z "$V_WS" ]] || valid "$RE_DOMAIN" "$V_WS" || die "workspace domain '$V_WS' is not a domain such as example.com"

# oauth client
if [[ -z "$V_CLIENT" && $INTERACTIVE == 1 ]]; then
  note "Google OAuth client id: Google cannot create it by API. Leave blank to deploy with a placeholder, then follow the"
  note "steps in 'terraform output oidc_setup_steps' (redirect URI: ${V_URL}/oauth/callback) and run this again."
  ask V_CLIENT "OAuth client id (123456789012-abc.apps.googleusercontent.com)" ""
fi
if [[ -n "$V_CLIENT" ]]; then
  valid "$RE_CLIENT" "$V_CLIENT" || die "'$V_CLIENT' is not a Google OAuth client id (it looks like 123456789012-abc123.apps.googleusercontent.com; create one at https://console.cloud.google.com/apis/credentials?project=$V_PROJECT)"
  if [[ -z "$V_SECRET" && $INTERACTIVE == 1 ]]; then
    printf 'OAuth client secret (hidden, blank to set it later): ' >&2
    IFS= read -rs V_SECRET || V_SECRET=""
    printf '\n' >&2
  fi
else
  V_SECRET=""
fi

# terraform state bucket (remote state is the recommended default: the state holds generated passwords and keys)
if [[ -z "$V_BUCKET" && $INTERACTIVE == 1 && $CREATE_BUCKET == 0 ]]; then
  note "Terraform state holds generated passwords and keys: keep it in a private, versioned GCS bucket, not a local file."
  note "(Add --create-state-bucket to a run of this script to have it create the bucket; it asks before running anything.)"
  ask V_BUCKET "State bucket name (type none to keep a local state file, not recommended)" "${V_PROJECT}-tfstate"
fi
[[ "$(lower "$V_BUCKET")" == none ]] && V_BUCKET=""
if [[ $CREATE_BUCKET == 1 && -z "$V_BUCKET" ]]; then V_BUCKET="${V_PROJECT}-tfstate"; fi
if [[ -n "$V_BUCKET" ]]; then
  valid "$RE_BUCKET" "$V_BUCKET" && [[ "$V_BUCKET" != goog* && "$V_BUCKET" != *google* ]] || die "'$V_BUCKET' is not a usable GCS bucket name (3-222 lowercase letters, digits, - _ .; no 'goog' prefix)"
fi
BUCKET_CMDS=()
if [[ $CREATE_BUCKET == 1 ]]; then
  BUCKET_CMDS=("gcloud storage buckets create gs://$V_BUCKET --project=$V_PROJECT --location=$V_REGION --uniform-bucket-level-access --public-access-prevention"
               "gcloud storage buckets update gs://$V_BUCKET --project=$V_PROJECT --versioning")
fi

# ---- summary + confirmation ----------------------------------------------------------------------------------------------
TFVARS="$OUT_DIR/terraform.tfvars"; SECRETS="$OUT_DIR/secrets.auto.tfvars"
say ""
say "About to write:"
say "  $TFVARS"
if [[ -n "$V_SECRET" ]]; then say "  $SECRETS   (mode 600, git-ignored)"; fi
if [[ -n "$V_BUCKET" ]]; then say "  $OUT_DIR/backend.tf   (remote state in gs://$V_BUCKET)"; fi
say ""
say "  project_id            $V_PROJECT"
say "  region                $V_REGION"
if [[ "$V_PROFILE" == trial ]]; then say "  profile               trial  (NO PITR, NO deletion protection, deletable state bucket, 1-2 gateway instances)"; else say "  profile               production  (HA database, PITR, deletion protection, protected state bucket)"; fi
say "  admins                $(printf '%s' "$ADMIN_LIST" | tr '\n' ' ')"
say "  allowed domains       $(printf '%s' "$DOMAIN_LIST" | tr '\n' ' ')"
say "  public_url            $V_URL"
if [[ -n "$V_BUCKET" ]]; then say "  state bucket          gs://$V_BUCKET"; else say "  state bucket          (none: LOCAL state file; it will hold passwords and keys)"; fi
if [[ -n "$V_WS" ]]; then say "  workspace domain      $V_WS"; fi
say "  oauth client id       ${V_CLIENT:-(placeholder: sign-in will not work until you set it)}"
if [[ -n "$V_SECRET" ]]; then say "  oauth client secret   (hidden)"; else say "  oauth client secret   (not set)"; fi
if [[ ${#BUCKET_CMDS[@]} -gt 0 ]]; then
  say "  After writing the files these commands create the state bucket (not run until you confirm):"
  for c in "${BUCKET_CMDS[@]}"; do say "    $c"; done
fi
say ""

if [[ $INTERACTIVE == 1 ]]; then
  ans=""; ask ans "Write these files?" "Y"
  [[ "$(lower "$ans")" == y* ]] || die "nothing written"
fi

mkdir -p "$OUT_DIR"
backup() {   # backup <file> : keep the old file next to it, same permissions
  local f="$1" b
  [[ -e "$f" ]] || return 0
  if [[ $FORCE != 1 ]]; then
    [[ $INTERACTIVE == 1 ]] || die "$f exists: pass --force to replace it (the old one is kept as a .bak file)"
    local a=""; ask a "$f exists. Replace it (a backup is kept)?" "n"
    [[ "$(lower "$a")" == y* ]] || die "left $f untouched; nothing written"
  fi
  b="$f.bak-$(date +%Y%m%d%H%M%S)"
  ( umask 077; cp -p "$f" "$b" )
  note "backed up $f to $b"
}
HAVE_SECRET=0; [[ -n "$V_SECRET" ]] && HAVE_SECRET=1
backup "$TFVARS"
if [[ $HAVE_SECRET == 1 ]]; then backup "$SECRETS"; fi

export S_PROJECT="$V_PROJECT" S_REGION="$V_REGION" S_PROFILE="$V_PROFILE" S_ADMINS="$ADMIN_LIST" S_DOMAINS="$DOMAIN_LIST"
export S_URL="$V_URL" S_WS="$V_WS" S_CLIENT="$V_CLIENT" S_TFVARS="$TFVARS" S_SECRETS="$SECRETS" S_SECRET="$V_SECRET"
python3 -I - <<'PY'
import json, os, datetime
def q(s):   # an HCL string literal: JSON escaping, plus Terraform's own ${ and %{ sequences
    return json.dumps(s).replace('${', '$${').replace('%{', '%%{')
e = os.environ
admins = [a for a in e['S_ADMINS'].split('\n') if a]
domains = [d for d in e['S_DOMAINS'].split('\n') if d]
out = ['# Written by setup.sh on %s. Edit freely; terraform.tfvars.example lists every option.' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
       '', 'project_id = %s' % q(e['S_PROJECT']), 'region     = %s' % q(e['S_REGION']),
       'profile    = %s   # trial | production' % q(e['S_PROFILE']), '',
       '# People who can sign in to the budget app and change budgets (each gets a generated password and their own gateway key).',
       'admin_users = [']
out += ['  { email = %s },' % q(a) for a in admins]
out += [']', '', '# Only these email domains can sign in to the gateway.',
        'allowed_email_domains = [%s]' % ', '.join(q(d) for d in domains), '',
        '# What Claude Code connects to; the OAuth redirect URI is <public_url>/oauth/callback.',
        'public_url = %s' % q(e['S_URL']), '', '# Google sign-in. client_id left out = PLACEHOLDER (see `terraform output oidc_setup_steps`).',
        'oidc = {']
if e['S_CLIENT']: out.append('  client_id = %s' % q(e['S_CLIENT']))
else: out.append('  # client_id = "123456789012-abc123.apps.googleusercontent.com"')
if e['S_WS']: out.append('  google_workspace_domain = %s' % q(e['S_WS']))
out += ['}', '', '# The client secret lives in secrets.auto.tfvars (git-ignored) or TF_VAR_oidc_client_secret, never in this file.', '']
fd = os.open(e['S_TFVARS'], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
with os.fdopen(fd, 'w') as f: f.write('\n'.join(out))
if e['S_SECRET']:
    fd = os.open(e['S_SECRETS'], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('# Written by setup.sh. Secret: never commit. (git-ignored)\noidc_client_secret = %s\n' % q(e['S_SECRET']))
    os.chmod(e['S_SECRETS'], 0o600)
PY
unset S_SECRET V_SECRET
say "wrote $TFVARS"
BACKEND="$OUT_DIR/backend.tf"
if [[ -n "$V_BUCKET" ]]; then
  backup "$BACKEND"
  ( umask 022; cat >"$BACKEND" <<BTF
# Written by setup.sh: Terraform state lives in a private GCS bucket (it holds generated passwords and keys).
# Bucket: versioned, uniform access, public access prevention. Grant roles/storage.objectUser on it only to the people who run Terraform.
# First use:  terraform init            (an existing local terraform.tfstate: terraform init -migrate-state)
terraform {
  backend "gcs" {
    bucket = "$V_BUCKET"
    prefix = "claude-gateway"
  }
}
BTF
  )
  say "wrote $BACKEND"
fi
if [[ $HAVE_SECRET == 1 ]]; then say "wrote $SECRETS (mode 600)"; fi

# ---- optional: create the state bucket (explicit confirmation only) ----------------------------------------------------------
if [[ ${#BUCKET_CMDS[@]} -gt 0 ]]; then
  say ""; say "State bucket: these exact commands will run:"
  for c in "${BUCKET_CMDS[@]}"; do say "  $c"; done
  RUN_B=0
  if [[ $INTERACTIVE == 1 ]]; then
    a=""; ask a "Type yes to run them now (anything else skips; you can run them yourself)" ""
    [[ "$a" == yes ]] && RUN_B=1
  elif [[ $CONFIRM_BUCKET == 1 ]]; then RUN_B=1
  else note "not run: pass --confirm-create-state-bucket to run them non-interactively"; fi
  if [[ $RUN_B == 1 ]]; then
    command -v gcloud >/dev/null || die "gcloud is not installed: run the commands above yourself, then terraform init"
    for c in "${BUCKET_CMDS[@]}"; do
      read -r -a argv <<<"$c"
      "${argv[@]}" || die "'$c' failed: fix the problem (does the bucket exist already? are you logged in?) and run the remaining commands yourself, then terraform init"
    done
    say "created gs://$V_BUCKET (versioned, uniform access, public access prevention enforced)"
  else
    note "skipped: create the bucket yourself before terraform init (commands above)"
  fi
fi

# ---- check the result ----------------------------------------------------------------------------------------------------
if [[ "$SKIP_VALIDATE" == 1 ]]; then note "skipped the offline check"; else
  say ""; say "Checking the settings (offline, nothing is created)..."
  run_check "$TFVARS" "$([[ $HAVE_SECRET == 1 ]] && echo "$SECRETS")" || { note "fix terraform.tfvars (or run ./setup.sh again) and re-check with ./setup.sh --check"; exit 1; }
fi

REL="$(cd "$OUT_DIR" && pwd)"
cat <<NEXT

Next:
  cd $REL
  terraform init$([[ -n "$V_BUCKET" ]] && printf '     # remote state in gs://%s (an existing local terraform.tfstate: terraform init -migrate-state)' "$V_BUCKET")
  terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
  PROJECT_ID=$V_PROJECT REGION=$V_REGION ../deploy/build-push.sh     # prints the budget-app image tag
  terraform apply -var app_image_tag=<that tag>     # or put app_image_tag in terraform.tfvars; Cloud SQL takes 10-15 minutes
  terraform output oidc_setup_steps     # one manual step in the Google console: create the OAuth client
  terraform output -json admin_credentials
  terraform output -raw proxy_command | sh

NEXT
if [[ -z "$V_BUCKET" ]]; then
  say "WARNING: no state bucket: Terraform will keep its state (generated passwords and keys) in a local file."
  say "  Recommended: ./setup.sh --state-bucket ${V_PROJECT}-tfstate --create-state-bucket   (or terraform/backend.tf.example)"
fi
if [[ -z "$V_CLIENT" || $HAVE_SECRET == 0 ]]; then
  say "Sign-in is on a placeholder until you create the OAuth client:"
  say "  redirect URI to paste into the Google console: ${V_URL}/oauth/callback"
  say "  console: https://console.cloud.google.com/apis/credentials?project=$V_PROJECT"
  say "Then run ./setup.sh again (answer with the client id and secret) and terraform apply."
fi
