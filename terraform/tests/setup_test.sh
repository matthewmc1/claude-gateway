#!/usr/bin/env bash
# Tests for terraform/setup.sh. It runs a COPY of the script in a temp directory with a stub `gcloud` first on PATH
# (so no real gcloud command ever runs), scripted stdin, and --out-dir pointing at temp directories: the real
# terraform.tfvars is never written. Terraform itself only runs offline, with a fake token, in scratch copies.
#
#   terraform/tests/setup_test.sh            (also run by terraform/tests/run.sh)
#   SETUP_TEST_FULL=0 ...                    skip the cases that run `terraform init` (no network needed)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TF_SRC="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$TF_SRC/.." && pwd)"
command -v rsync >/dev/null || { echo "missing tool: rsync" >&2; exit 2; }
FULL="${SETUP_TEST_FULL:-1}"

SCR="${SETUP_TEST_SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/tf-setup-test.XXXXXX")}"
mkdir -p "$SCR"
[[ -n "${SETUP_TEST_SCRATCH:-}" ]] || trap 'rm -rf "$SCR"' EXIT
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-${TMPDIR:-/tmp}/tf-gateway-plugin-cache}"; mkdir -p "$TF_PLUGIN_CACHE_DIR"
unset GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CREDENTIALS TF_VAR_oidc_client_secret OIDC_CLIENT_SECRET PROJECT_ID ADMIN_EMAILS
unset ALLOWED_DOMAINS PROFILE PUBLIC_URL WORKSPACE_DOMAIN OIDC_CLIENT_ID REGION SETUP_OUT_DIR SETUP_SKIP_VALIDATE

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# a scratch copy of terraform/ (never the live files) with setup.sh inside it
W="$SCR/work"; mkdir -p "$W/tf" "$W/config" "$W/stubs"
rsync -a --exclude 'terraform.tfstate*' --exclude terraform.tfvars --exclude zz_imports.tf --exclude adopt.sh --exclude .terraform \
  --exclude '.terraform.lock.hcl' --exclude 'secrets.auto.tfvars' --exclude backend.tf --exclude 'terraform.tfvars.bak*' --exclude tests "$TF_SRC/" "$W/tf/"
cp "$REPO/config/models.json" "$W/config/models.json"
SETUP="$W/tf/setup.sh"
# stub gcloud: the only thing setup.sh asks it is the active project
cat > "$W/stubs/gcloud" <<STUB
#!/usr/bin/env bash
[[ "\$*" == "config get-value project" ]] && { echo "stub-project-123"; exit 0; }
if [[ "\$1 \$2" == "storage buckets" ]]; then
  echo "\$*" >>"$W/gcloud.calls"
  [[ -n "\${STUB_GCLOUD_FAIL:-}" ]] && { echo "stub gcloud: ERROR: bucket exists" >&2; exit 1; }
  exit 0
fi
echo "stub gcloud: unexpected call: \$*" >&2; exit 99
STUB
chmod +x "$W/stubs/gcloud"
export PATH="$W/stubs:$PATH"
[[ "$(command -v gcloud)" == "$W/stubs/gcloud" ]] && ok "gcloud is stubbed" || bad "gcloud is not stubbed"

SECRET='p@ss"w\ord${x}%{y}-ZZ9'
CLIENT='123456789012-abcdef123456.apps.googleusercontent.com'
fresh() { OUT="$SCR/out-$1"; rm -rf "$OUT"; mkdir -p "$OUT"; }
unhcl() { python3 -I -c 'import sys,json,re;t=open(sys.argv[1]).read();m=re.search(r"^oidc_client_secret = (\".*\")$",t,re.M);print(json.loads(m.group(1).replace("$${","${").replace("%%{","%{")),end="")' "$1"; }

# ============================================================================================================================
echo; echo "== interactive wizard (scripted stdin)"
fresh wiz
# answers: project (Enter = gcloud's), region, admins, domains (Enter = first admin's), profile (no default: 'trial'), url, workspace, client id, secret, state bucket (Enter = <project>-tfstate), confirm
printf '%s\n' '' '' 'Alice@Example.com, bob@example.com' '' 'trial' '' '' "$CLIENT" "$SECRET" '' '' >"$SCR/wiz.in"
SETUP_SKIP_VALIDATE=1 "$SETUP" --out-dir "$OUT" <"$SCR/wiz.in" >"$SCR/wiz.out" 2>"$SCR/wiz.err"; rc=$?
cat "$SCR/wiz.out" "$SCR/wiz.err" >"$SCR/wiz.all"
check "wizard exits 0" "[[ $rc == 0 ]]"
check "gcloud's active project is offered and accepted" "grep -q 'project_id = \"stub-project-123\"' '$OUT/terraform.tfvars'"
check "region defaults to europe-west2, profile is the one typed" "grep -q 'region     = \"europe-west2\"' '$OUT/terraform.tfvars' && grep -q 'profile    = \"trial\"' '$OUT/terraform.tfvars'"
check "admin emails are lower-cased and listed" "grep -q 'email = \"alice@example.com\"' '$OUT/terraform.tfvars' && grep -q 'email = \"bob@example.com\"' '$OUT/terraform.tfvars'"
check "allowed domain defaults to the first admin's domain" "grep -q 'allowed_email_domains = \[\"example.com\"\]' '$OUT/terraform.tfvars'"
check "public_url defaults to http://localhost:8891" "grep -q 'public_url = \"http://localhost:8891\"' '$OUT/terraform.tfvars'"
check "client id is written to terraform.tfvars" "grep -q 'client_id = \"$CLIENT\"' '$OUT/terraform.tfvars'"
check "secrets.auto.tfvars exists with mode 600" "[[ -f '$OUT/secrets.auto.tfvars' && \$(mode '$OUT/secrets.auto.tfvars') == 600 ]]"
check "terraform.tfvars is not secret-bearing (mode 644)" "[[ \$(mode '$OUT/terraform.tfvars') == 644 ]]"
check "the secret round-trips through HCL escaping" "[[ \"\$(unhcl '$OUT/secrets.auto.tfvars')\" == '$SECRET' ]]"
check "the secret is not in terraform.tfvars" "! grep -qF -- 'ZZ9' '$OUT/terraform.tfvars'"
check "the secret never appears in stdout or stderr" "! grep -qF -- 'ZZ9' '$SCR/wiz.all' && ! grep -qF -- 'ord\${x}' '$SCR/wiz.all'"
check "the summary shows the secret as hidden" "grep -q 'oauth client secret   (hidden)' '$SCR/wiz.out'"
check "next commands are printed" "grep -q 'terraform init' '$SCR/wiz.out' && grep -q 'build-push.sh' '$SCR/wiz.out' && grep -q 'oidc_setup_steps' '$SCR/wiz.out'"
check "only the three expected files were written" "[[ \$(ls -A '$OUT' | sort | tr '\n' ' ') == 'backend.tf secrets.auto.tfvars terraform.tfvars ' ]]"
check "the default state bucket is <project>-tfstate and backend.tf is a gcs backend" "grep -q 'backend \"gcs\"' '$OUT/backend.tf' && grep -q 'bucket = \"stub-project-123-tfstate\"' '$OUT/backend.tf' && grep -q 'prefix = \"claude-gateway\"' '$OUT/backend.tf'"
check "the wizard did not create a bucket by itself (no gcloud storage call)" "[[ ! -e '$W/gcloud.calls' ]]"
check "terraform.tfvars never carries the profile silently: it is written explicitly" "grep -q '^profile    = \"trial\"' '$OUT/terraform.tfvars'"

echo; echo "== refusing to overwrite, backups"
printf '%s\n' '' '' 'carol@example.com' '' 'trial' '' '' '' 'none' '' 'n' >"$SCR/ow.in"   # blank client id; confirm Y by default; then answer "n" to replace
before="$(cksum <"$OUT/terraform.tfvars")"
SETUP_SKIP_VALIDATE=1 "$SETUP" --out-dir "$OUT" <"$SCR/ow.in" >"$SCR/ow.out" 2>"$SCR/ow.err"; rc=$?
# answers consumed: project region admins domains profile url workspace clientid statebucket(none) | confirm(Enter=Y) | replace? -> 'n'
check "declining the overwrite prompt exits non-zero and leaves the file untouched" "[[ $rc != 0 && \"\$(cksum <'$OUT/terraform.tfvars')\" == '$before' ]]"
printf '%s\n' '' '' 'carol@example.com' '' 'trial' '' '' '' 'none' '' 'y' >"$SCR/ow2.in"
SETUP_SKIP_VALIDATE=1 "$SETUP" --out-dir "$OUT" <"$SCR/ow2.in" >"$SCR/ow2.out" 2>"$SCR/ow2.err"; rc=$?
check "accepting the overwrite prompt replaces it" "[[ $rc == 0 ]] && grep -q 'carol@example.com' '$OUT/terraform.tfvars' && ! grep -q 'alice@example.com' '$OUT/terraform.tfvars'"
check "a backup of the old terraform.tfvars is kept" "ls '$OUT'/terraform.tfvars.bak-* >/dev/null 2>&1 && grep -q 'alice@example.com' '$OUT'/terraform.tfvars.bak-*"
check "placeholder path: no secrets file written, and the next steps explain the OAuth client" "grep -q 'placeholder' '$SCR/ow2.out' && grep -q 'oauth/callback' '$SCR/ow2.out'"

# ============================================================================================================================
echo; echo "== non-interactive mode"
fresh ni
SETUP_SKIP_VALIDATE=1 "$SETUP" --non-interactive --out-dir "$OUT" >"$SCR/ni.out" 2>"$SCR/ni.err" </dev/null; rc=$?
check "missing required values fail with a message" "[[ $rc != 0 ]] && grep -q 'error:' '$SCR/ni.err' && [[ -z \$(ls -A '$OUT') ]]"
cat "$SCR/ni.out" "$SCR/ni.err" >/dev/null
OIDC_CLIENT_SECRET="$SECRET" SETUP_SKIP_VALIDATE=1 PROJECT_ID=ci-project-42 REGION=us-central1 ADMIN_EMAILS='ops@corp.example.org' PROFILE=production \
  PUBLIC_URL=https://claude.internal.example.com/ WORKSPACE_DOMAIN=corp.example.org OIDC_CLIENT_ID="$CLIENT" \
  "$SETUP" --non-interactive --out-dir "$OUT" >"$SCR/ni2.out" 2>"$SCR/ni2.err" </dev/null; rc=$?
cat "$SCR/ni2.out" "$SCR/ni2.err" >"$SCR/ni2.all"
check "non-interactive run from environment variables succeeds" "[[ $rc == 0 ]]"
check "values land in terraform.tfvars (project, region, production, https url without trailing slash)" "grep -q 'project_id = \"ci-project-42\"' '$OUT/terraform.tfvars' && grep -q 'region     = \"us-central1\"' '$OUT/terraform.tfvars' && grep -q 'profile    = \"production\"' '$OUT/terraform.tfvars' && grep -q 'public_url = \"https://claude.internal.example.com\"' '$OUT/terraform.tfvars'"
check "workspace domain is written and becomes the default allowed domain" "grep -q 'google_workspace_domain = \"corp.example.org\"' '$OUT/terraform.tfvars' && grep -q 'allowed_email_domains = \[\"corp.example.org\"\]' '$OUT/terraform.tfvars'"
check "secret came from the environment, file mode is 600, value round-trips" "[[ \$(mode '$OUT/secrets.auto.tfvars') == 600 && \"\$(unhcl '$OUT/secrets.auto.tfvars')\" == '$SECRET' ]]"
check "secret never in output or terraform.tfvars" "! grep -qF -- 'ZZ9' '$SCR/ni2.all' '$OUT/terraform.tfvars'"
SETUP_SKIP_VALIDATE=1 PROFILE=trial PROJECT_ID=ci-project-42 ADMIN_EMAILS='ops@corp.example.org' "$SETUP" --non-interactive --out-dir "$OUT" >"$SCR/ni3.out" 2>"$SCR/ni3.err" </dev/null; rc=$?
check "non-interactive refuses to overwrite without --force" "[[ $rc != 0 ]] && grep -q -- '--force' '$SCR/ni3.err' && grep -q 'ci-project-42' '$OUT/terraform.tfvars' && grep -q 'region     = \"us-central1\"' '$OUT/terraform.tfvars'"
SETUP_SKIP_VALIDATE=1 PROFILE=trial PROJECT_ID=ci-project-43 ADMIN_EMAILS='ops@corp.example.org' "$SETUP" --non-interactive --force --out-dir "$OUT" >"$SCR/ni4.out" 2>"$SCR/ni4.err" </dev/null; rc=$?
check "--force replaces the file and keeps a backup" "[[ $rc == 0 ]] && grep -q 'ci-project-43' '$OUT/terraform.tfvars' && grep -q 'ci-project-42' '$OUT'/terraform.tfvars.bak-*"
check "flags work as well as environment variables" "SETUP_SKIP_VALIDATE=1 '$SETUP' --non-interactive --force --out-dir '$OUT' --project flag-project-9 --admins 'a@x.org,b@x.org' --domains x.org --profile trial --region europe-west1 >/dev/null 2>&1 && grep -q 'flag-project-9' '$OUT/terraform.tfvars' && grep -q 'b@x.org' '$OUT/terraform.tfvars'"

# ============================================================================================================================
echo; echo "== remote state: backend.tf and --create-state-bucket (stubbed gcloud, nothing real runs)"
calls() { cat "$W/gcloud.calls" 2>/dev/null; }
CREATE_CMD="gcloud storage buckets create gs://acme-tfstate-7 --project=ci-project-1 --location=europe-west2 --uniform-bucket-level-access --public-access-prevention"
UPDATE_CMD="gcloud storage buckets update gs://acme-tfstate-7 --project=ci-project-1 --versioning"
NIARGS=(--non-interactive --force --project ci-project-1 --admins a@x.org --profile trial)

fresh bk1; rm -f "$W/gcloud.calls"
SETUP_SKIP_VALIDATE=1 "$SETUP" "${NIARGS[@]}" --state-bucket acme-tfstate-7 --out-dir "$OUT" >"$SCR/bk1.out" 2>&1 </dev/null; rc=$?
check "--state-bucket writes backend.tf (gcs, bucket, prefix) and runs nothing" "[[ $rc == 0 ]] && grep -q 'bucket = \"acme-tfstate-7\"' '$OUT/backend.tf' && grep -q 'prefix = \"claude-gateway\"' '$OUT/backend.tf' && [[ -z \"\$(calls)\" ]]"
check "backend.tf is not secret-bearing and the next steps mention terraform init -migrate-state" "[[ \$(mode '$OUT/backend.tf') == 644 ]] && grep -q 'migrate-state' '$SCR/bk1.out'"

fresh bk2; rm -f "$W/gcloud.calls"
SETUP_SKIP_VALIDATE=1 "$SETUP" "${NIARGS[@]}" --state-bucket acme-tfstate-7 --create-state-bucket --out-dir "$OUT" >"$SCR/bk2.out" 2>&1 </dev/null; rc=$?
check "--create-state-bucket without confirmation prints the exact commands and runs NOTHING" "[[ $rc == 0 ]] && [[ -z \"\$(calls)\" ]] && grep -qF -- '$CREATE_CMD' '$SCR/bk2.out' && grep -qF -- '$UPDATE_CMD' '$SCR/bk2.out' && grep -q 'not run' '$SCR/bk2.out'"
check "--force does not count as confirmation" "[[ -z \"\$(calls)\" ]]"

fresh bk3; rm -f "$W/gcloud.calls"
SETUP_SKIP_VALIDATE=1 "$SETUP" "${NIARGS[@]}" --state-bucket acme-tfstate-7 --create-state-bucket --confirm-create-state-bucket --out-dir "$OUT" >"$SCR/bk3.out" 2>&1 </dev/null; rc=$?
EXPECT_CALLS="$(printf '%s\n%s' "${CREATE_CMD#gcloud }" "${UPDATE_CMD#gcloud }")"
check "--confirm-create-state-bucket runs exactly the two printed commands, in order" "[[ $rc == 0 && \"\$(calls)\" == \"\$EXPECT_CALLS\" ]]"
check "the bucket is created versioned, uniform-access, public-access-prevented, in the chosen project and region" "calls | head -1 | grep -q -- '--uniform-bucket-level-access --public-access-prevention' && calls | head -1 | grep -q -- '--location=europe-west2' && calls | tail -1 | grep -q -- '--versioning'"
check "backend.tf was written too" "grep -q 'acme-tfstate-7' '$OUT/backend.tf'"

fresh bk4; rm -f "$W/gcloud.calls"
printf '%s\n' '' 'carol@example.com' '' 'trial' '' '' '' '' 'no' >"$SCR/bk4.in"     # (project given by flag) region admins domains profile url ws client | confirm | "no"
SETUP_SKIP_VALIDATE=1 "$SETUP" --create-state-bucket --project ci-project-1 --out-dir "$OUT" <"$SCR/bk4.in" >"$SCR/bk4.out" 2>&1; rc=$?
check "interactive: anything but 'yes' skips the bucket commands" "[[ $rc == 0 && -z \"\$(calls)\" ]] && grep -q 'skipped' '$SCR/bk4.out' && grep -q 'ci-project-1-tfstate' '$OUT/backend.tf'"
fresh bk5; rm -f "$W/gcloud.calls"
printf '%s\n' '' 'carol@example.com' '' 'trial' '' '' '' '' 'y' >"$SCR/bk5.in"
SETUP_SKIP_VALIDATE=1 "$SETUP" --create-state-bucket --project ci-project-1 --out-dir "$OUT" <"$SCR/bk5.in" >"$SCR/bk5.out" 2>&1
check "interactive: 'y' is not enough, only the word yes" "[[ -z \"\$(calls)\" ]]"
fresh bk6; rm -f "$W/gcloud.calls"
printf '%s\n' '' 'carol@example.com' '' 'trial' '' '' '' '' 'yes' >"$SCR/bk6.in"
SETUP_SKIP_VALIDATE=1 "$SETUP" --create-state-bucket --project ci-project-1 --out-dir "$OUT" <"$SCR/bk6.in" >"$SCR/bk6.out" 2>&1; rc=$?
check "interactive: typing yes runs both commands" "[[ $rc == 0 && \$(calls | wc -l | tr -d ' ') == 2 ]] && grep -q 'created gs://ci-project-1-tfstate' '$SCR/bk6.out'"

fresh bk7; rm -f "$W/gcloud.calls"
STUB_GCLOUD_FAIL=1 SETUP_SKIP_VALIDATE=1 "$SETUP" "${NIARGS[@]}" --state-bucket acme-tfstate-7 --create-state-bucket --confirm-create-state-bucket --out-dir "$OUT" >"$SCR/bk7.out" 2>&1 </dev/null; rc=$?
check "a failing gcloud stops with a clear message (the files were written, the second command did not run)" "[[ $rc != 0 ]] && grep -q 'failed' '$SCR/bk7.out' && [[ -f '$OUT/terraform.tfvars' && \$(calls | wc -l | tr -d ' ') == 1 ]]"

fresh bk8
SETUP_SKIP_VALIDATE=1 "$SETUP" "${NIARGS[@]}" --state-bucket none --out-dir "$OUT" >"$SCR/bk8.out" 2>&1 </dev/null; rc=$?
check "--state-bucket none: no backend.tf, and a loud warning that state stays local" "[[ $rc == 0 && ! -e '$OUT/backend.tf' ]] && grep -q 'WARNING: no state bucket' '$SCR/bk8.out'"
fresh bk9
SETUP_SKIP_VALIDATE=1 "$SETUP" "${NIARGS[@]}" --out-dir "$OUT" >"$SCR/bk9.out" 2>&1 </dev/null; rc=$?
check "non-interactive without a bucket: no backend.tf, warning printed (opt-in, never silent)" "[[ $rc == 0 && ! -e '$OUT/backend.tf' ]] && grep -q 'WARNING: no state bucket' '$SCR/bk9.out'"
check "the real terraform/ dir got no backend.tf from the tests" "[[ ! -e '$TF_SRC/backend.tf' ]]"

# ============================================================================================================================
echo; echo "== invalid input is rejected before anything is written"
fresh bad
run_bad() {   # run_bad <description> <expected stderr text> <env assignments...> -- (runs setup non-interactively)
  local d="$1" msg="$2"; shift 2
  env PROFILE=trial "$@" SETUP_SKIP_VALIDATE=1 "$SETUP" --non-interactive --out-dir "$OUT" >"$SCR/bad.out" 2>"$SCR/bad.err" </dev/null; local rc=$?
  if [[ $rc != 0 ]] && grep -qF -- "$msg" "$SCR/bad.err" && [[ -z "$(ls -A "$OUT")" ]]; then ok "$d"; else bad "$d (rc=$rc: $(head -c 300 "$SCR/bad.err"))"; fi
}
run_bad "bad admin email" "not a valid email" PROJECT_ID=good-project-1 ADMIN_EMAILS='nope'
run_bad "bad project id" "not a Google Cloud project id" PROJECT_ID='Bad Project' ADMIN_EMAILS='a@x.org'
run_bad "bad client id names the console" "console.cloud.google.com/apis/credentials?project=good-project-1" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' OIDC_CLIENT_ID='abc'
run_bad "bad domain" "is not a domain" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' ALLOWED_DOMAINS='@x.org'
run_bad "bad profile" "profile must be" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' PROFILE=big
run_bad "bad public url" "public url must look like" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' PUBLIC_URL='localhost:8891'
for u in 'https://gw.example.com$(touch X)' 'https://ev il.com' 'https://a.com;x' 'https://a.com`id`' 'https://a.com/p' 'http://example.com' 'https://a_b.com' 'https://u@a.com' 'https://a.com:99999' "https://a.com'x"; do
  run_bad "hostile public url rejected: $u" "public url must look like" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' PUBLIC_URL="$u"
done
run_bad "a missing profile is refused (no silent trial)" "profile is required" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' PROFILE=
run_bad "a bad state bucket name is refused" "not a usable GCS bucket name" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org' STATE_BUCKET='Bad_Bucket!'
run_bad "duplicate admins" "listed twice" PROJECT_ID=good-project-1 ADMIN_EMAILS='a@x.org,A@x.org'

# ============================================================================================================================
if [[ "$FULL" == 1 ]] && command -v terraform >/dev/null; then
  echo; echo "== offline terraform check (init + validate + plan against an empty state; fake token)"
  fresh chk
  OIDC_CLIENT_SECRET="$SECRET" PROFILE=trial PROJECT_ID=check-project-1 ADMIN_EMAILS='a@example.com,b@example.com' OIDC_CLIENT_ID="$CLIENT" \
    "$SETUP" --non-interactive --out-dir "$OUT" >"$SCR/chk.out" 2>"$SCR/chk.err" </dev/null; rc=$?
  cat "$SCR/chk.out" "$SCR/chk.err" >"$SCR/chk.all"
  check "wizard output passes the real Terraform validation and plan" "[[ $rc == 0 ]] && grep -q 'check passed' '$SCR/chk.out'"
  check "secret not printed by the check either" "! grep -qF -- 'ZZ9' '$SCR/chk.all'"
  "$SETUP" --check "$OUT/terraform.tfvars" >"$SCR/chk2.out" 2>&1; rc=$?
  check "--check accepts the generated file" "[[ $rc == 0 ]] && grep -q 'check passed' '$SCR/chk2.out'"
  cp "$OUT/terraform.tfvars" "$OUT/broken.tfvars"
  sed -i.bak 's/a@example.com/not-an-email/' "$OUT/broken.tfvars"; rm -f "$OUT/broken.tfvars.bak"
  "$SETUP" --check "$OUT/broken.tfvars" >"$SCR/chk3.out" 2>&1; rc=$?
  check "--check rejects a bad email with Terraform's message" "[[ $rc != 0 ]] && grep -q 'valid email address' '$SCR/chk3.out'"
  printf 'project_id = "check-project-1"\nprofile = "trial"\nadmin_users = [{ email = "a@example.com" }]\nallowed_email_domains = ["example.com"]\noidc = { client_id = "nonsense" }\n' >"$OUT/badclient.tfvars"
  "$SETUP" --check "$OUT/badclient.tfvars" >"$SCR/chk4.out" 2>&1; rc=$?
  check "--check rejects a malformed Google client id and says where to get one" "[[ $rc != 0 ]] && tr -s '│ \n' ' ' <'$SCR/chk4.out' | grep -q 'apps/credentials\|console.cloud.google.com'"
  printf 'project_id = "check-project-1"\nprofile = "trial"\nadmin_users = [{ email = "a@example.com" }]\nallowed_email_domains = ["example.com"]\n' >"$OUT/placeholder.tfvars"
  "$SETUP" --check "$OUT/placeholder.tfvars" >"$SCR/chk5.out" 2>&1; rc=$?
  check "--check accepts the placeholder-OIDC path (client not created yet)" "[[ $rc == 0 ]]"
  check "--check wrote nothing" "[[ -z \$(ls '$OUT'/*.bak-* 2>/dev/null) ]]"
else
  echo; echo "(skipped the cases that need terraform init)"
fi

echo; echo "== real files untouched"
check "the real terraform/ dir has no secrets.auto.tfvars written by the tests" "[[ ! -e '$TF_SRC/secrets.auto.tfvars' ]]"
check "no terraform.tfvars.bak files in the real terraform/ dir" "[[ -z \$(ls '$TF_SRC'/terraform.tfvars.bak* 2>/dev/null) ]]"

printf '\nsetup.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL == 0 ]]
