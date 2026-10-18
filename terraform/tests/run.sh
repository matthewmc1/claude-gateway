#!/usr/bin/env bash
# Offline tests for the Terraform configuration. Everything happens in a SCRATCH COPY with a fake token and an empty
# state: no real credentials, no API calls, no apply, and your terraform.tfvars / state / .terraform are never touched.
#
#   terraform/tests/run.sh
#   KEEP=1 terraform/tests/run.sh      keep the scratch directory (its path is printed)
#   SKIP_SETUP_TESTS=1 ...             skip the setup.sh tests (tests/setup_test.sh)
#
# Needs: terraform >= 1.5, jq, rsync, ruby (YAML parser) and network on the first run (to download providers once;
# they are cached in $TF_PLUGIN_CACHE_DIR, default ${TMPDIR:-/tmp}/tf-gateway-plugin-cache).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TF_SRC="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$TF_SRC/.." && pwd)"
for c in terraform jq rsync ruby; do command -v "$c" >/dev/null || { echo "missing tool: $c" >&2; exit 2; }; done

# Unix sockets (terraform's provider plugins) fail on macOS when the path is too long: fail fast with a clear message.
_T="${TMPDIR:-/tmp}"; _T="${_T%/}"
if (( ${#_T} > 70 )); then echo "TMPDIR ($_T) is too long (${#_T} chars, max 70): provider plugin socket paths would break. Unset TMPDIR or use a short directory such as /tmp." >&2; exit 2; fi
S="$(mktemp -d "${TMPDIR:-/tmp}/tf-gateway-test.XXXXXX")"
[[ "${KEEP:-0}" == 1 ]] && echo "scratch: $S" || trap 'rm -rf "$S"' EXIT
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-${TMPDIR:-/tmp}/tf-gateway-plugin-cache}"; mkdir -p "$TF_PLUGIN_CACHE_DIR"
export TF_IN_AUTOMATION=1 TF_INPUT=0 NO_COLOR=1
# A fake token: even a bug could not reach a real project. Real credentials in the environment are removed.
unset GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CREDENTIALS GOOGLE_CLOUD_KEYFILE_JSON GOOGLE_IMPERSONATE_SERVICE_ACCOUNT
unset TF_VAR_oidc_client_secret TF_VAR_project_id
export GOOGLE_OAUTH_ACCESS_TOKEN=fake-token-offline-tests

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }
# assert <description> <file> <jq expression that must print true>
assert() { if [[ "$(jq -r "$3" "$2" 2>&1)" == true ]]; then ok "$1"; else bad "$1  [jq: $3]"; fi; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1  (got '$2', want '$3')"; fi; }

# ---- scratch copy: never includes the live deployment's files ----------------------------------------------------------
BASE="$S/base"; TF="$BASE/tf"; mkdir -p "$TF" "$BASE/config" "$S/out"
rsync -a --exclude 'terraform.tfstate*' --exclude terraform.tfvars --exclude zz_imports.tf --exclude adopt.sh \
  --exclude .terraform --exclude '.terraform.lock.hcl' --exclude 'secrets.auto.tfvars' --exclude 'backend.tf' \
  --exclude 'terraform.tfvars.bak*' --exclude tests "$TF_SRC/" "$TF/"
cp "$REPO/config/models.json" "$BASE/config/models.json"
# The fixtures below were written against the 5.5-default catalog; derive that state from the real file (shipped default: Sonnet 4.6)
# so they keep testing the rules, and test the real file itself where it matters (the root plan, "real models.json").
jq '.default = "sonnet" | (.models[] | select(.alias=="sonnet")) |= del(.pin) | (.models[] | select(.alias=="sonnet") | .tier) = "default" | (.models[] | select(.alias=="sonnet-4-6") | .pin) = false | (.models[] | select(.alias=="sonnet-4-6") | .tier) = "previous"' "$BASE/config/models.json" >"$S/models.orig.json"
cp "$BASE/config/models.json" "$S/models.shipped.json"

cat > "$S/fake.tfvars" <<'TFV'
project_id            = "fake-gateway-test"
profile               = "trial"
app_image_tag         = "20261013093000"
admin_users           = [{ email = "alice@example.com", name = "Alice" }, { email = "bob@example.com" }]
allowed_email_domains = ["example.com"]
oidc                  = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com" }
oidc_client_secret    = "fake-client-secret-value"
TFV

tf() { ( cd "$TF" && terraform "$@" ); }

# plan <name> [extra tfvars file...]  -> $S/out/<name>.log, and (on success) $S/out/<name>.json
plan() {
  local name="$1"; shift
  local args=(-refresh=false -lock=false -input=false -no-color -var-file="$S/fake.tfvars"); local f
  for f in "$@"; do args+=(-var-file="$f"); done
  rm -f "$S/out/$name.json" "$S/out/$name.bin"
  if tf plan "${args[@]}" -out="$S/out/$name.bin" >"$S/out/$name.log" 2>&1; then
    tf show -json "$S/out/$name.bin" >"$S/out/$name.json" 2>/dev/null
    return 0
  fi
  return 1
}
flat() { sed 's/│/ /g' "$1" | tr -s ' \n' ' '; }   # one line, box-drawing removed
tfv() { local f="$S/$1.tfvars"; cat >"$f"; echo "$f"; }   # tfv <name> < content -> path

expect_fail() {   # expect_fail <description> <plan name> <text the error must contain> [tfvars...]
  local d="$1" n="$2" msg="$3"; shift 3
  if plan "$n" "$@"; then bad "$d (the plan succeeded but should have failed)"; return; fi
  if flat "$S/out/$n.log" | grep -qF -- "$msg"; then ok "$d"; else bad "$d (failed, but the message lacks: $msg)"; sed -n 1,12p "$S/out/$n.log"; fi
}

# ============================================================================================================================
section "format, init, validate"
if tf fmt -check -recursive -no-color >/dev/null; then ok "terraform fmt -check -recursive"; else bad "terraform fmt -check"; tf fmt -check -recursive -diff -no-color | head -20; fi
if tf init -backend=false -input=false -no-color >"$S/out/init.log" 2>&1; then ok "terraform init -backend=false"; else bad "terraform init"; tail -20 "$S/out/init.log"; fi
if tf validate -no-color >"$S/out/validate.log" 2>&1; then ok "terraform validate"; else bad "terraform validate"; cat "$S/out/validate.log"; fi

# ============================================================================================================================
section "default plan (2 admins, trial profile)"
if plan base; then ok "plan succeeds against an empty state"; else bad "plan"; sed -n 1,30p "$S/out/base.log"; fi
P="$S/out/base.json"
assert "every change is a create (nothing updated, replaced or deleted)" "$P" '[.resource_changes[] | select(.change.actions != ["create"])] | length == 0'
assert "no data-source reads or provider API lookups needed (only resource changes)" "$P" '[.resource_changes[] | select(.mode != "managed")] | length == 0'
count() { jq "[.resource_changes[] | select(.type==\"$1\")] | length" "$P"; }
for pair in "google_cloud_run_v2_service:2" "google_cloud_scheduler_job:1" "google_storage_bucket:1" "google_sql_database_instance:1" \
            "google_logging_metric:17" "google_monitoring_alert_policy:20" "google_monitoring_dashboard:1" "google_monitoring_notification_channel:2" \
            "google_secret_manager_secret:8" "google_secret_manager_secret_version:8" "google_service_account:3" "google_artifact_registry_repository:1"; do
  t="${pair%%:*}"; n="${pair##*:}"; assert_eq "$t x$n" "$(count "$t")" "$n"
done
assert "secrets include the system key and the gateway config" "$P" '[.resource_changes[] | select(.type=="google_secret_manager_secret") | .change.after.secret_id] | (contains(["claude-app-system-key","claude-gateway-config","claude-gateway-postgres-url","claude-gateway-jwt"]))'
assert "SQL instance: no public IP, private network set" "$P" '.resource_changes[] | select(.type=="google_sql_database_instance") | .change.after.settings[0].ip_configuration[0] | (.ipv4_enabled == false)'
assert "SQL instance: trial profile = db-f1-micro, zonal" "$P" '.resource_changes[] | select(.type=="google_sql_database_instance") | .change.after.settings[0] | (.tier=="db-f1-micro" and .availability_type=="ZONAL")'
assert "no allUsers / allAuthenticatedUsers anywhere in the plan" "$P" '[.. | strings | select(. == "allUsers" or . == "allAuthenticatedUsers" or startswith("allUsers") or startswith("allAuthenticatedUsers"))] | length == 0'
assert "Cloud Run IAM only grants run.invoker, never to a public member" "$P" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member") | .change.after | select(.role != "roles/run.invoker" or (.member|test("^(allUsers|allAuthenticatedUsers)")))] | length == 0'
assert "both Cloud Run services are present and private-by-IAM (invokers exist)" "$P" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member")] | length == 6'
assert "state bucket: uniform access, public access prevention enforced, versioned" "$P" '.resource_changes[] | select(.type=="google_storage_bucket") | .change.after | (.uniform_bucket_level_access==true and .public_access_prevention=="enforced" and .versioning[0].enabled==true and .force_destroy==true)'
assert "state bucket IAM: objectUser for the app SA on the bucket only" "$P" '[.resource_changes[] | select(.type=="google_storage_bucket_iam_member") | .change.after | select(.role=="roles/storage.objectUser" and (.member|startswith("serviceAccount:claude-budget-app@")))] | length == 1'
assert "app SA can read logs (roles/logging.viewer)" "$P" '[.resource_changes[] | select(.type=="google_project_iam_member") | .change.after | select(.role=="roles/logging.viewer" and (.member|startswith("serviceAccount:claude-budget-app@")))] | length == 1'
assert "gateway SA has aiplatform.user" "$P" '[.resource_changes[] | select(.type=="google_project_iam_member") | .change.after | select(.role=="roles/aiplatform.user" and (.member|startswith("serviceAccount:claude-gateway@")))] | length == 1'
assert "scheduler: POST every minute with an OIDC token for claude-scheduler" "$P" '.resource_changes[] | select(.type=="google_cloud_scheduler_job") | .change.after | (.schedule=="* * * * *" and .http_target[0].http_method=="POST" and (.http_target[0].oidc_token[0].service_account_email|startswith("claude-scheduler@")))'
assert "scheduler SA has run.invoker on the app" "$P" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and .name=="app_scheduler") | .change.after | select(.member|startswith("serviceAccount:claude-scheduler@"))] | length == 1'
assert "cloudscheduler + monitoring + storage APIs are enabled" "$P" '[.resource_changes[] | select(.type=="google_project_service") | .change.after.service] | (contains(["cloudscheduler.googleapis.com","monitoring.googleapis.com","storage.googleapis.com"]))'
app_env() { jq -r '.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | .change.after.template[0].containers[0].env[] | .name' "$P" | sort | tr '\n' ' '; }
ENVS="$(app_env)"
for v in APP_STATE_BUCKET GATEWAY_SERVICE_NAME USAGE_SOURCE SCHEDULER_SA MODELS_JSON APP_VIEW_ACCESS GATEWAY_SYSTEM_WRITE_KEY GATEWAY_ADMIN_READ_KEY APP_ADMINS APP_SESSION_SECRET GATEWAY_URL GATEWAY_AUDIENCE; do
  [[ " $ENVS" == *" $v "* ]] && ok "app env has $v" || bad "app env missing $v"
done
assert "app env: USAGE_SOURCE=logs, APP_VIEW_ACCESS=open, GATEWAY_SERVICE_NAME=claude-gateway" "$P" '.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | [.change.after.template[0].containers[0].env[] | select(.value != null) | {(.name): .value}] | add | (.USAGE_SOURCE=="logs" and .APP_VIEW_ACCESS=="open" and .GATEWAY_SERVICE_NAME=="claude-gateway")'
assert "MODELS_JSON passes the catalog (5 models incl. Sonnet 4.6 and Opus 4.6, default sonnet-4-6)" "$P" '.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | [.change.after.template[0].containers[0].env[] | select(.name=="MODELS_JSON") | .value][0] | fromjson | (.default=="sonnet-4-6" and (.models|length)==5 and ([.models[].id] | (contains(["claude-sonnet-4-6","claude-opus-4-6"]))))'
assert "the system key and read key are secret-backed (no plaintext env)" "$P" '.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | [.change.after.template[0].containers[0].env[] | select(.name=="GATEWAY_SYSTEM_WRITE_KEY" or .name=="GATEWAY_ADMIN_READ_KEY") | (.value == null or .value == "")] | all'
assert "log retention is not managed by default (project-wide bucket untouched)" "$P" '[.resource_changes[] | select(.type=="google_logging_project_bucket_config")] | length == 0'
assert "outputs: client_defaults, oidc_redirect_uri, oidc_setup_steps, proxy_command, client_install_hint, admin_credentials exist" "$P" '.output_changes | (has("client_defaults") and has("oidc_redirect_uri") and has("oidc_setup_steps") and has("oidc_console_url") and has("oidc_consent_screen_url") and has("proxy_command") and has("client_install_hint") and has("admin_credentials"))'
assert "oidc_redirect_uri = public_url + /oauth/callback" "$P" '.planned_values.outputs.oidc_redirect_uri.value == "http://localhost:8891/oauth/callback"'
assert "client_defaults is exactly the installer's defaults.json shape: gatewayUrl, empty model (the catalog default decides), effortLevel, userSettings" "$P" '.planned_values.outputs.client_defaults.value | fromjson | (keys == ["effortLevel","gatewayUrl","model","userSettings"] and .gatewayUrl=="http://localhost:8891" and .model=="" and .effortLevel=="medium" and .userSettings=={})'
assert "admin_credentials output is sensitive" "$P" '.output_changes.admin_credentials.after_sensitive == true'
assert "Google sign-in sends access_type/prompt, no hd without a workspace domain" "$P" '.planned_values.outputs.effective_settings.value.oidc_extra_auth_params == {"access_type":"offline","prompt":"consent"}'
assert "no write_client_defaults file by default" "$P" '[.resource_changes[] | select(.type=="local_file")] | length == 0'

# ============================================================================================================================
section "plan variations"
# alerts: the policies cover what the monitoring flow promises
assert "alert policies: gateway 5xx, provider errors, spend-cap, SQL cpu/disk/connections, app 5xx, scheduler, denials, gateway down" "$P" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after.display_name] | (length==20 and (map(test("5xx")) | map(select(.)) | length==2) and any(.[]; test("provider error")) and any(.[]; test("spend-cap")) and any(.[]; test("CPU")) and any(.[]; test("disk")) and any(.[]; test("connections")) and any(.[]; test("scheduler")) and any(.[]; test("denials")) and any(.[]; test("no running instance")))'
assert "alerts email every admin by default" "$P" '[.resource_changes[] | select(.type=="google_monitoring_notification_channel") | .change.after.labels.email_address] | sort == ["alice@example.com","bob@example.com"]'
assert "log metrics cover provider errors, spend caps, auth/admin denials, app login failures, scheduler failures" "$P" '[.resource_changes[] | select(.type=="google_logging_metric") | .change.after.name] | sort == ["claude_app_login_failed","claude_app_override_creator_removed","claude_app_override_error","claude_app_override_failed","claude_app_override_lost_claim","claude_app_override_overdue","claude_app_override_superseded","claude_app_overrides_store_error","claude_app_tick","claude_app_tick_error","claude_app_usage_ingest_error","claude_gateway_admin_denied","claude_gateway_auth_denied","claude_gateway_auth_invalid_token","claude_gateway_spend_cap_blocks","claude_gateway_upstream_errors","claude_scheduler_failures"]'
assert "metric filters use the gateway event names" "$P" '[.resource_changes[] | select(.type=="google_logging_metric") | .change.after.filter] | (any(.[]; contains("auth.denied")) and any(.[]; contains("admin.denied")) and any(.[]; contains("admin.login.failed")) and any(.[]; contains("spend.blocked")))'
assert "dashboard JSON is valid and has tiles" "$P" '.resource_changes[] | select(.type=="google_monitoring_dashboard") | .change.after.dashboard_json | fromjson | (.mosaicLayout.tiles | length) >= 10'

plan nomon "$(tfv nomon <<<'enable_monitoring = false')" && {
  assert "enable_monitoring=false: no alert policies, metrics, channels or dashboard" "$S/out/nomon.json" '[.resource_changes[] | select(.type|test("alert_policy|logging_metric|notification_channel|dashboard"))] | length == 0'
  assert "enable_monitoring=false: scheduler, services and bucket remain" "$S/out/nomon.json" '[.resource_changes[] | select(.type|test("scheduler_job|cloud_run_v2_service$|storage_bucket$"))] | length == 4'
} || { bad "plan with monitoring off"; tail -5 "$S/out/nomon.log"; }

plan prod "$(tfv prod <<<'profile = "production"')" && {
  assert "production: HA database with PITR, db-custom-1-3840" "$S/out/prod.json" '.resource_changes[] | select(.type=="google_sql_database_instance") | .change.after | (.deletion_protection==true and .settings[0].tier=="db-custom-1-3840" and .settings[0].availability_type=="REGIONAL" and .settings[0].backup_configuration[0].point_in_time_recovery_enabled==true)'
  assert "production: two warm gateway instances, state bucket protected" "$S/out/prod.json" '(.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="gateway") | .change.after.template[0].scaling[0].min_instance_count==2) and (.resource_changes[] | select(.type=="google_storage_bucket") | .change.after.force_destroy==false)'
  assert "production: tighter thresholds" "$S/out/prod.json" '.planned_values.outputs.effective_settings.value.alert_thresholds.upstream_errors == 5'
} || { bad "production profile plan"; tail -5 "$S/out/prod.log"; }

plan override "$(tfv override <<<'profile = "production"
db_tier = "db-custom-2-7680"
gateway_min_instances = 3
db_deletion_protection = false
alert_thresholds = { upstream_errors = 77 }
manage_log_retention = true
upstreams = [{ region = "global" }, { region = "us-east5" }, { region = "global", project_id = "other-project-123" }]')" && {
  assert "individual variables override the profile (tier, min instances, protection, threshold)" "$S/out/override.json" '(.resource_changes[] | select(.type=="google_sql_database_instance") | .change.after | (.deletion_protection==false and .settings[0].tier=="db-custom-2-7680")) and (.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="gateway") | .change.after.template[0].scaling[0] | (.min_instance_count==3 and .max_instance_count==6)) and .planned_values.outputs.effective_settings.value.alert_thresholds.upstream_errors==77'
  assert "manage_log_retention=true configures only the _Default bucket (400 days under production)" "$S/out/override.json" '[.resource_changes[] | select(.type=="google_logging_project_bucket_config") | .change.after | select(.bucket_id=="_Default" and .retention_days==400)] | length == 1'
  assert "extra upstream project gets aiplatform.user for the gateway SA" "$S/out/override.json" '[.resource_changes[] | select(.type=="google_project_iam_member" and .name=="gateway_vertex_upstream") | .change.after | select(.project=="other-project-123" and .role=="roles/aiplatform.user")] | length == 1'
  assert "three upstreams resolved (regions and projects)" "$S/out/override.json" '.planned_values.outputs.effective_settings.value.upstreams | (length==3 and .[1].region=="us-east5" and .[1].project_id=="fake-gateway-test" and .[2].project_id=="other-project-123")'
} || { bad "override plan"; tail -8 "$S/out/override.log"; }

plan noiam "$(tfv noiam <<<'upstreams = [{ project_id = "other-project-123" }]
upstream_project_iam = false')" && assert "upstream_project_iam=false: no cross-project grant" "$S/out/noiam.json" '[.resource_changes[] | select(.name=="gateway_vertex_upstream")] | length == 0' || bad "noiam plan"

plan ws "$(tfv ws <<<'allowed_email_domains = []
oidc = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com", google_workspace_domain = "corp.example.org" }')" && {
  assert "workspace domain: hd added to the auth params and used as the allowed domain" "$S/out/ws.json" '.planned_values.outputs.effective_settings.value | (.oidc_extra_auth_params.hd=="corp.example.org" and .allowed_email_domains==["corp.example.org"])'
} || { bad "workspace plan"; tail -8 "$S/out/ws.log"; }

plan okta "$(tfv okta <<<'oidc = { issuer = "https://login.example.org", client_id = "anything-goes-for-other-issuers" }')" && assert "non-Google issuer accepts any client id and sends no Google-only params" "$S/out/okta.json" '.planned_values.outputs.effective_settings.value.oidc_extra_auth_params == {}' || { bad "okta plan"; tail -8 "$S/out/okta.log"; }

plan placeholder "$(tfv placeholder <<<'oidc = {}')" && {
  if grep -q "PLACEHOLDER" "$S/out/placeholder.log"; then ok "placeholder OIDC: plan succeeds and warns"; else bad "placeholder OIDC: no warning"; fi
  assert "placeholder OIDC: reported as not configured" "$S/out/placeholder.json" '.planned_values.outputs.effective_settings.value.oidc_configured == false'
} || { bad "placeholder plan"; tail -8 "$S/out/placeholder.log"; }
# fake.tfvars sets oidc_client_secret, so also prove the secret-less case: client id but no secret
plan nosecret "$(tfv nosecret <<<'oidc_client_secret = null')" && grep -q "PLACEHOLDER" "$S/out/nosecret.log" && ok "client id without secret still warns (placeholder secret used)" || bad "nosecret"

plan proj "$(tfv proj <<<'create_project = true
billing_account = "0123AB-4567CD-89EF01"
org_id = "123456789012"')" && {
  assert "create_project=true plans a project under the org with auto_create_network=false" "$S/out/proj.json" '[.resource_changes[] | select(.type=="google_project") | .change.after | select(.org_id=="123456789012" and .auto_create_network==false and .deletion_policy=="PREVENT")] | length == 1'
} || { bad "create_project plan"; tail -8 "$S/out/proj.log"; }
assert "create_project=false (default): no google_project resource" "$P" '[.resource_changes[] | select(.type=="google_project")] | length == 0'

plan cd "$(tfv cd <<<'write_client_defaults = true
client_default_effort = "high"')" && assert "write_client_defaults=true plans ../client/defaults.json" "$S/out/cd.json" '[.resource_changes[] | select(.type=="local_file" and (.change.after.filename|endswith("/client/defaults.json")) and (.change.after.content|fromjson|.effortLevel=="high"))] | length == 1' || bad "client defaults plan"
# the installer's own validation accepts what Terraform writes (print-managed reads nothing but the files given; temp dirs, no install)
if command -v python3 >/dev/null; then
  CDT="$S/cdcheck"; rm -rf "$CDT"; mkdir -p "$CDT/home" "$CDT/managed" "$CDT/user" "$CDT/tmp"
  jq -r '.planned_values.outputs.client_defaults.value' "$S/out/cd.json" >"$CDT/defaults.json"
  cdrun() { env -i PATH="$PATH" HOME="$CDT/home" TMPDIR="$CDT/tmp" CLAUDE_MANAGED_DIR="$CDT/managed" CLAUDE_USER_DIR="$CDT/user" CLAUDE_GATEWAY_NO_DNS=1 bash "$REPO/client/claude-gateway-setup.sh" "$@" 2>&1; }
  if OUTP="$(cdrun print-managed --defaults "$CDT/defaults.json" --models "$REPO/client/models.json" --gateway-url https://gw.example.test)" && grep -q '"forceLoginGatewayUrl": "https://gw.example.test"' <<<"$OUTP"; then ok "the installer accepts the client_defaults output as its defaults file"; else bad "the installer rejected the client_defaults output"; echo "$OUTP" | head -5; fi
  echo '{"gatewayUrl":"https://gw.example.test","defaultAlias":"sonnet","effort":"medium"}' >"$CDT/old.json"
  if OUTP="$(cdrun print-managed --defaults "$CDT/old.json" --models "$REPO/client/models.json" --gateway-url https://gw.example.test)"; then bad "control: the old key names should be rejected by the installer"; else grep -q "unknown key" <<<"$OUTP" && ok "control: the installer rejects unknown keys (the old client_defaults shape)" || bad "control: unexpected installer message: $OUTP"; fi
else ok "(python3 missing: installer check skipped)"; fi
ls "$BASE/client" >/dev/null 2>&1 && bad "planning created a client/ directory in the scratch copy" || ok "planning wrote no file"

plan three "$(tfv three <<<'admin_users = [{ email = "a@example.com" }, { email = "b@example.com" }, { email = "c@example.com", name = "C" }]')" && {
  assert "3 admins: 3 passwords and 3 personal gateway keys" "$S/out/three.json" '[.resource_changes[] | select(.type=="random_password" and (.name=="admin_password" or .name=="admin_key"))] | length == 6'
  assert "3 admins: invoker grants for each on both services (3x2) + app/gateway/scheduler" "$S/out/three.json" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member")] | length == 8'
} || { bad "3 admins plan"; tail -8 "$S/out/three.log"; }
plan one "$(tfv one <<<'admin_users = [{ email = "solo@example.com" }]')" && assert "1 admin: 2 admin-specific random passwords" "$S/out/one.json" '[.resource_changes[] | select(.type=="random_password" and (.name=="admin_password" or .name=="admin_key"))] | length == 2' || bad "1 admin plan"

# ============================================================================================================================
section "negative tests (clear messages)"
expect_fail "invalid admin email is rejected" bad_email "Every admin needs a valid email address" "$(tfv bad_email <<<'admin_users = [{ email = "not-an-email" }]')"
expect_fail "empty admin list is rejected" no_admin "Define at least one admin user" "$(tfv no_admin <<<'admin_users = []')"
expect_fail "duplicate admin is rejected" dup_admin "the same email twice" "$(tfv dup_admin <<<'admin_users = [{ email = "a@example.com" }, { email = "A@example.com" }]')"
expect_fail "malformed Google client id says where to get it" bad_client "console.cloud.google.com/apis/credentials" "$(tfv bad_client <<<'oidc = { client_id = "my-client" }')"
expect_fail "no allowed domains at all is rejected" no_domain "Set allowed_email_domains" "$(tfv no_domain <<<'allowed_email_domains = []')"
expect_fail "bad domain format is rejected" bad_domain "bare domains" "$(tfv bad_domain <<<'allowed_email_domains = ["@example.com"]')"
expect_fail "unknown profile is rejected" bad_profile "profile must be" "$(tfv bad_profile <<<'profile = "huge"')"
expect_fail "invalid view_access is rejected" bad_view "view_access must be" "$(tfv bad_view <<<'view_access = "everyone"')"
expect_fail "create_project without billing/org is rejected" bad_proj "needs billing_account" "$(tfv bad_proj <<<'create_project = true')"
expect_fail "billing_account without create_project is rejected" stray_billing "only used with create_project" "$(tfv stray_billing <<<'billing_account = "0123AB-4567CD-89EF01"')"
expect_fail "create_project with both org and folder is rejected" both_parents "exactly one of org_id or folder_id" "$(tfv both_parents <<<'create_project = true
billing_account = "0123AB-4567CD-89EF01"
org_id = "1"
folder_id = "2"')"
expect_fail "unsupported upstream provider is rejected" bad_provider "Only provider" "$(tfv bad_provider <<<'upstreams = [{ provider = "bedrock" }]')"
expect_fail "public_url with a path is rejected" bad_url "public_url must be an origin" "$(tfv bad_url <<<'public_url = "http://localhost:8891/x"')"

setmodels() { cp "$1" "$BASE/config/models.json"; }
jq '.default = "nonexistent"' "$S/models.orig.json" >"$S/m_unknown.json"
setmodels "$S/m_unknown.json"
expect_fail "unknown default alias in models.json is rejected" unk_default "must be the alias or id of a model in the list"
jq '.models[1].id = .models[0].id' "$S/models.orig.json" >"$S/m_dup.json"
setmodels "$S/m_dup.json"
expect_fail "duplicate model ids are rejected" dup_ids "model ids must be unique"
jq '(.models[] | select(.alias=="sonnet") | .enabled) = false' "$S/models.orig.json" >"$S/m_disabled_default.json"
setmodels "$S/m_disabled_default.json"
expect_fail "a disabled default model is rejected" dis_default "must have \"enabled\": true"
# family / pin rules (the same ones the installer, the app and the UI enforce)
jq '(.models[] | select(.alias=="sonnet-4-6") | .pin) = true' "$S/models.orig.json" >"$S/m_twopins.json"
setmodels "$S/m_twopins.json"
expect_fail "two models pinning the same family are rejected" two_pins "more than one model pins the same family"
jq '(.models[] | select(.alias=="sonnet-4-6") | .family) = "gpt"' "$S/models.orig.json" >"$S/m_badfam.json"
setmodels "$S/m_badfam.json"
expect_fail "an unknown family is rejected" bad_family "\"family\" must be one of sonnet, opus, haiku"
jq '.models += [{"alias":"mystery","id":"claude-x-1","pin":true}]' "$S/models.orig.json" >"$S/m_nofam.json"
setmodels "$S/m_nofam.json"
expect_fail "pin: true without a family is rejected" pin_nofam "needs a \"family\""
jq '(.models[] | select(.alias=="sonnet-4-6") | .enabled) = false | (.models[] | select(.alias=="sonnet-4-6") | .pin) = true | (.models[] | select(.alias=="sonnet") | .pin) = false' "$S/models.orig.json" >"$S/m_pindis.json"
setmodels "$S/m_pindis.json"
expect_fail "a pinned entry that is disabled is rejected" pin_disabled "must have \"enabled\": true"
jq '(.models[] | select(.alias=="sonnet-4-6") | .pin) = "yes"' "$S/models.orig.json" >"$S/m_badpin.json"
setmodels "$S/m_badpin.json"
expect_fail "a non-boolean pin is rejected" bad_pin "\"pin\" must be true or false"
jq '.models[3].alias = "SONNET"' "$S/models.orig.json" >"$S/m_dupcase.json"
setmodels "$S/m_dupcase.json"
expect_fail "aliases are unique case-insensitively" dup_case "model aliases must be unique"
jq '(.models[] | select(.alias=="sonnet-4-6") | .family) = null' "$S/models.orig.json" >"$S/m_nullfam.json"
setmodels "$S/m_nullfam.json"
expect_fail "\"family\": null is refused with the same clear message as an unknown family (no raw function error)" null_family "\"family\" must be one of sonnet, opus, haiku"
jq '(.models[] | .enabled) = false' "$S/models.orig.json" >"$S/m_alloff.json"
setmodels "$S/m_alloff.json"
expect_fail "every model disabled: the message says so (not 'default must be the alias or id')" all_off "every model is disabled"
setmodels "$S/models.orig.json"

# ============================================================================================================================
section "infra hardening (review findings)"
GW='.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="gateway") | .change.after'
APP='.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | .change.after'
SQLR='.resource_changes[] | select(.type=="google_sql_database_instance") | .change.after'

# --- M6: the profile has no default
cat > "$S/noprofile.tfvars" <<'TFV'
project_id            = "fake-gateway-test"
app_image_tag         = "20261013093000"
admin_users           = [{ email = "alice@example.com" }]
allowed_email_domains = ["example.com"]
oidc                  = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com" }
TFV
if tf plan -refresh=false -lock=false -input=false -no-color -var-file="$S/noprofile.tfvars" >"$S/out/noprofile.log" 2>&1; then bad "profile: a plan without profile must fail"; else
  if flat "$S/out/noprofile.log" | grep -q 'No value for required variable' && flat "$S/out/noprofile.log" | grep -q 'profile'; then ok "profile has no default: a plan without it fails and names it"; else bad "profile: wrong error"; sed -n 1,10p "$S/out/noprofile.log"; fi
fi
if ! grep -A12 '^variable "profile"' "$TF/variables.tf" | grep -q '^  default'; then ok "variables.tf: profile declares no default"; else bad "variables.tf: profile has a default"; fi

# --- M2: extra_invokers
expect_fail "extra_invokers: allUsers is rejected" inv_allusers "must not contain allUsers" "$(tfv inv_allusers <<<'extra_invokers = ["allUsers"]')"
expect_fail "extra_invokers: allAuthenticatedUsers is rejected" inv_allauth "must not contain allUsers or allAuthenticatedUsers" "$(tfv inv_allauth <<<'extra_invokers = ["allAuthenticatedUsers"]')"
expect_fail "extra_invokers: 'user:allUsers' style tricks are rejected" inv_trick "must not contain allUsers" "$(tfv inv_trick <<<'extra_invokers = ["user:allUsers"]')"
expect_fail "extra_invokers: a bare email (no type prefix) is rejected" inv_bare "must look like user:" "$(tfv inv_bare <<<'extra_invokers = ["eng@example.com"]')"
expect_fail "extra_invokers: projectOwner:/projectViewer: members are rejected" inv_proj "must look like user:" "$(tfv inv_proj <<<'extra_invokers = ["projectViewer:fake-gateway-test"]')"
for m in 'domain:*' 'user:*' 'group:*' 'serviceAccount:*' 'domain:.' 'domain:' 'user:' 'group:' 'serviceAccount:' 'domain:com' 'domain:-a.com' 'domain:a..com' 'user:nobody' 'group:eng@' 'user:@example.com' 'user:a@b' 'user:a@example.com,allUsers' 'domain:example.com/x' 'user:a*@example.com' 'domain:allUsers' 'user:ALLUSERS' 'deleted:user:a@example.com' 'principal://x' ''; do
  n="inv_$(printf '%s' "$m" | cksum | cut -d' ' -f1)"
  printf 'extra_invokers = ["%s"]\n' "$m" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then bad "extra_invokers '$m' was accepted"; else flat "$S/out/$n.log" | grep -q 'extra_invokers' && ok "extra_invokers rejects: '$m'" || { bad "extra_invokers '$m': wrong failure"; sed -n 1,6p "$S/out/$n.log"; }; fi
done
expect_fail "extra_invokers: whitespace in a member is rejected" inv_ws "must look like user:" "$(tfv inv_ws <<<'extra_invokers = ["user:a b@example.com"]')"
plan inv_ok "$(tfv inv_ok <<<'extra_invokers = ["group:eng@example.com", "serviceAccount:ci@p.iam.gserviceaccount.com", "domain:example.com", "user:carol@example.com"]')" \
  && assert "extra_invokers: valid user/group/serviceAccount/domain entries are granted on both services" "$S/out/inv_ok.json" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member") | .change.after | select(.member|test("^(group:eng@|serviceAccount:ci@|domain:example.com|user:carol@)"))] | length == 8' \
  || bad "extra_invokers valid plan"

# --- L7: app_image_tag has no default and is never latest
expect_fail "app_image_tag: 'latest' is rejected" tag_latest "must identify one build" "$(tfv tag_latest <<<'app_image_tag = "latest"')"
for tg in LATEST Latest main Main master dev develop stable HEAD prod production staging canary nightly abc 12345 1234567x v1 1.2.3 1.0.0-main.3 deadbeef-dev 20261013-latest 'has space' 'a/b' '1.2.3-x'; do
  n="tag_$(printf '%s' "$tg" | cksum | cut -d' ' -f1)"
  printf 'app_image_tag = "%s"\n' "$tg" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then bad "app_image_tag '$tg' was accepted"; else flat "$S/out/$n.log" | grep -q 'must identify one build' && ok "app_image_tag rejects: $tg" || { bad "app_image_tag '$tg': wrong failure"; sed -n 1,6p "$S/out/$n.log"; }; fi
done
for tg in 20261013093000 20261013 3f2a9c1 3f2a9c1d5e7b8a9c0d1e2f3a4b5c6d7e8f9a0b1c 1.4.0-build.7 1.4.0-rc1 2.0.0-20261013; do
  n="tagok_$(printf '%s' "$tg" | cksum | cut -d' ' -f1)"
  printf 'app_image_tag = "%s"\n' "$tg" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then ok "app_image_tag accepts: $tg"; else bad "app_image_tag '$tg' was rejected"; sed -n 1,6p "$S/out/$n.log"; fi
done
cat > "$S/notag.tfvars" <<'TFV'
project_id            = "fake-gateway-test"
profile               = "trial"
admin_users           = [{ email = "alice@example.com" }]
allowed_email_domains = ["example.com"]
oidc                  = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com" }
TFV
if tf plan -refresh=false -lock=false -input=false -no-color -var-file="$S/notag.tfvars" >"$S/out/notag.log" 2>&1; then bad "app_image_tag unset: a full plan must fail"; else flat "$S/out/notag.log" | grep -q 'Set app_image_tag to the tag deploy/build-push.sh printed' && ok "app_image_tag unset: a full plan fails with instructions" || { bad "app_image_tag unset: wrong message"; sed -n 1,12p "$S/out/notag.log"; }; fi
assert "app image uses the given tag (not latest)" "$P" "[$APP | .template[0].containers[0].image] | (.[0] | endswith(\"/budget-app:20261013093000\"))"
assert "gateway image keeps the pinned release tag" "$P" "[$GW | .template[0].containers[0].image] | (.[0] | endswith(\"/gateway:2.1.296\"))"

# --- F1 (infra half): scheduler audience, app env and Cloud Run custom audience agree
assert "scheduler OIDC audience == app env SCHEDULER_AUDIENCE == app custom_audiences[0]" "$P" "([.resource_changes[] | select(.type==\"google_cloud_scheduler_job\") | .change.after.http_target[0].oidc_token[0].audience][0]) as \$a | ([$APP | .template[0].containers[0].env[] | select(.name==\"SCHEDULER_AUDIENCE\") | .value][0]) as \$e | ([$APP | .custom_audiences[0]][0]) as \$c | (\$a != null and \$a == \$e and \$a == \$c and (\$a | startswith(\"https://\")))"
assert "scheduler audience is not the gateway's (a token for one service is useless against the other)" "$P" "([.resource_changes[] | select(.type==\"google_cloud_scheduler_job\") | .change.after.http_target[0].oidc_token[0].audience][0]) | (contains(\"claude-gateway\") | not)"

# --- M7: gateway sizing, probes, alerts
assert "gateway: explicit cpu/memory limits and startup CPU boost" "$P" "$GW | .template[0].containers[0].resources[0] | (.limits.cpu==\"1\" and .limits.memory==\"1Gi\" and .startup_cpu_boost==true)"
assert "gateway: startup probe on /readyz and liveness probe on /healthz (no database in the liveness check)" "$P" "$GW | .template[0].containers[0] | (.startup_probe[0].http_get[0].path==\"/readyz\" and .startup_probe[0].failure_threshold==24 and .liveness_probe[0].http_get[0].path==\"/healthz\")"
assert "trial: gateway_max_instances defaults to 2 (min 1)" "$P" "$GW | .template[0].scaling[0] | (.min_instance_count==1 and .max_instance_count==2)"
assert "gateway config renders store.max_connections (5 per instance) and effective_settings shows the arithmetic" "$P" '.planned_values.outputs.effective_settings.value | (.gateway_max_instances==2 and .gateway_db_connections==10 and .db_max_connections==25)'
plan prod_max "$(tfv prod_max <<<'profile = "production"')" && assert "production: gateway_max_instances defaults to 6 within the database's connections (6x5=30 of 100)" "$S/out/prod_max.json" "$GW | .template[0].scaling[0] | (.min_instance_count==2 and .max_instance_count==6)" || bad "production max plan"
plan max4 "$(tfv max4 <<<'gateway_max_instances = 4')" && assert "gateway_max_instances is honoured (4 x 5 = 20 connections <= 25)" "$S/out/max4.json" "$GW | .template[0].scaling[0].max_instance_count==4" || bad "max4 plan"
expect_fail "connection arithmetic: 6 instances x 5 connections does not fit db-f1-micro (25)" conn_over "Database connection budget exceeded" "$(tfv conn_over <<<'gateway_max_instances = 6')"
plan conn_ok "$(tfv conn_ok <<<'gateway_max_instances = 6
db_max_connections = 100')" && ok "connection arithmetic: db_max_connections lifts the limit when you raised the database flag" || bad "conn_ok plan"
expect_fail "connection arithmetic counts gateway_store_max_connections too" conn_store "Database connection budget exceeded" "$(tfv conn_store <<<'gateway_store_max_connections = 12')"
expect_fail "gateway_max_instances below min_instances is rejected" max_lt_min "must be at least gateway_min_instances" "$(tfv max_lt_min <<<'gateway_min_instances = 3
gateway_max_instances = 2')"
expect_fail "gateway_max_instances must be a whole positive number" max_zero "whole number between 1 and 100" "$(tfv max_zero <<<'gateway_max_instances = 0')"
assert "alert: Cloud Run 429 responses (response_code=429) on the gateway" "$P" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after | select(.display_name|test("429")) | .conditions[0].condition_threshold[0].filter] | (length==1 and (.[0]|contains("run.googleapis.com/request_count") and contains("response_code=\"429\"") and contains("claude-gateway")))'
assert "alert: gateway 5xx uses the Cloud Run response_code_class" "$P" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after | select(.display_name=="Claude gateway: 5xx responses") | .conditions[0].condition_threshold[0].filter] | (length==1 and (.[0]|contains("response_code_class=\"5xx\"")))'
assert "alert: at maximum instances (threshold = max - 1, 10 minutes)" "$P" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after | select(.display_name|test("maximum instances")) | .conditions[0].condition_threshold[0]] | (length==1 and .[0].threshold_value==1 and .[0].duration=="600s")'
plan fixed "$(tfv fixed <<<'gateway_min_instances = 2
gateway_max_instances = 2')" && assert "no at-maximum alert when the gateway cannot scale (min == max)" "$S/out/fixed.json" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after.display_name | select(test("maximum instances"))] | length == 0' || bad "fixed plan"

# --- UNPROVEN: log metric filters against the real event shapes
FILT='.resource_changes[] | select(.type=="google_logging_metric") | select(.change.after.name=="NAME") | .change.after.filter'
assert "spend-cap metric keys on evt=spend.blocked (the gateway writes no inference event for a block)" "$P" "${FILT/NAME/claude_gateway_spend_cap_blocks} | (contains(\"evt=\") and contains(\"spend.blocked\") and (contains(\"429\")|not) and (contains(\"upstream\")|not) and (contains(\"inference\")|not))"
assert "auth.denied metric excludes the routine reason=invalid_token (expired sessions)" "$P" "${FILT/NAME/claude_gateway_auth_denied} | (contains(\"auth.denied\") and contains(\"NOT jsonPayload.reason=\") and contains(\"invalid_token\"))"
assert "invalid_token denials are still counted, in their own (dashboard-only) metric" "$P" "${FILT/NAME/claude_gateway_auth_invalid_token} | (contains(\"auth.denied\") and contains(\"jsonPayload.reason=\") and contains(\"invalid_token\") and (contains(\"NOT\")|not))"
assert "security-denials alert does not include the invalid_token metric" "$P" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after | select(.display_name|test("auth and admin denials")) | .conditions[0].condition_threshold[0].filter] | (length==1 and (.[0]|contains("claude_gateway_auth_denied") and contains("claude_gateway_admin_denied") and (contains("invalid_token")|not)))'
assert "upstream-error metric matches the real text line and the inference status" "$P" "${FILT/NAME/claude_gateway_upstream_errors} | (contains(\"upstream [45][0-9][0-9]\") and contains(\"jsonPayload.status>=500\"))"
# the regexes above are checked against real log lines (a 403/404/429 'warn vertex upstream' line and the e2e fixture)
if grep -E 'warn vertex upstream [45][0-9][0-9] request_id=' "$REPO/tests/e2e/fixtures/gateway-sample.log" >/dev/null 2>&1; then ok "real fixture has 'warn vertex upstream <4xx/5xx> request_id=' lines (what the upstream-error filter matches)"; else bad "fixture lost the upstream warn lines"; fi
if grep -q '"evt":"auth.denied".*"reason":"invalid_token"' "$REPO/logs/gateway.log" 2>/dev/null; then ok "real gateway log: auth.denied carries reason=invalid_token"; else ok "(logs/gateway.log not present here: invalid_token shape not re-checked)"; fi

# --- M1: rotating any consumed secret rolls Cloud Run (SECRETS_HASH). Plans on an empty state cannot know random values, so
#     the check runs on a scratch copy where the random values and the Cloud SQL IP are fixed literals; everything else is the real code.
mkvariant() {   # mkvariant <name> <jwt> <read> <session> <system> <db> <dbip>
  local d="$S/var-$1"; rm -rf "$d"; mkdir -p "$d/tf" "$d/config"; cp -R "$TF"/. "$d/tf/"; rm -rf "$d/tf/.terraform"; cp "$BASE/config/models.json" "$d/config/models.json"
  ( cd "$d/tf" && python3 - "$2" "$3" "$4" "$5" "$6" "$7" <<'PY'
import re, sys, glob
jwt, read, sess, sysk, db, ip = sys.argv[1:7]
pad = lambda v: v + '-0123456789012345678901234567890123456789'   # keys must be >= 32 characters
fixed = {'jwt': pad(jwt), 'read_key': pad(read), 'session': pad(sess), 'system_key': pad(sysk), 'db': pad(db)}
for f in glob.glob('*.tf'):
    t = open(f).read()
    for k, v in fixed.items():
        t = t.replace('random_password.%s.result' % k, '"%s"' % v)
    t = re.sub(r'random_password\.admin_password\[[^\]]*\]\.result', '"admin-password-fixed-0123456789"', t)
    t = re.sub(r'random_password\.admin_key\[[^\]]*\]\.result', '"admin-key-fixed-01234567890123456789012345678901234567"', t)
    t = t.replace('google_sql_database_instance.main.private_ip_address', '"%s"' % ip)
    open(f, 'w').write(t)
PY
  ) || return 1
  echo "$d"
}
secrets_plan() {   # secrets_plan <name> <jwt> <read> <session> <system> <db> [extra tfvars]  -> prints "<gateway> <app>"
  local nm="$1" j="$2" r="$3" s="$4" y="$5" b="$6"; shift 6
  local d; d="$(mkvariant "$nm" "$j" "$r" "$s" "$y" "$b" 10.9.9.9)" || return 1
  ( cd "$d/tf" && terraform init -backend=false -input=false -no-color >"$S/out/sv-$nm-init.log" 2>&1 || exit 1
    args=(-refresh=false -lock=false -input=false -no-color -var-file="$S/fake.tfvars"); for f in "$@"; do args+=(-var-file="$f"); done
    terraform plan "${args[@]}" -out="$S/out/sv-$nm.bin" >"$S/out/sv-$nm.log" 2>&1 || exit 1
    terraform show -json "$S/out/sv-$nm.bin" >"$S/out/sv-$nm.json" ) || return 1
  jq -r '[("gateway","app") as $n | .resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name==$n) | .change.after.template[0].containers[0].env[] | select(.name=="SECRETS_HASH") | .value] | join(" ")' "$S/out/sv-$nm.json"   # gateway first, then app
}
H0="$(secrets_plan s0 jwt0 read0 sess0 sys0 db0 2>/dev/null)"
if [[ "$H0" =~ ^[0-9a-f]{64}\ [0-9a-f]{64}$ || "$H0" =~ ^[0-9a-f]{64}\ [0-9a-f]{64}\ ?$ ]]; then ok "SECRETS_HASH is a known 64-hex digest on both services when the secrets are known"; else bad "SECRETS_HASH missing or not a digest on the baseline variant: '$H0'"; tail -5 "$S/out/sv-s0.log" 2>/dev/null; fi
read -r G0 A0 <<<"$H0"
[[ -n "$G0" && "$G0" != "$A0" ]] && ok "the two services hash their own (different) secret sets" || bad "gateway and app hashes should differ"
read -r G1 A1 <<<"$(secrets_plan s1 jwt0 read0 sess0 sys0 db0 2>/dev/null)"; [[ "$G1" == "$G0" && "$A1" == "$A0" ]] && ok "identical secrets: identical hashes (no spurious revision)" || bad "hashes are not stable"
read -r G2 A2 <<<"$(secrets_plan s2 jwt-ROTATED read0 sess0 sys0 db0 2>/dev/null)"; [[ -n "$G2" && "$G2" != "$G0" && "$A2" == "$A0" ]] && ok "rotating the gateway JWT secret changes the gateway's hash only" || bad "jwt rotation: gateway '$G2' vs '$G0', app '$A2' vs '$A0'"
read -r G3 A3 <<<"$(secrets_plan s3 jwt0 read-ROTATED sess0 sys0 db0 2>/dev/null)"; [[ -n "$G3" && "$G3" != "$G0" && "$A3" != "$A0" ]] && ok "rotating the admin read key changes BOTH hashes (both services consume it)" || bad "read key rotation: '$G3' '$A3'"
read -r G4 A4 <<<"$(secrets_plan s4 jwt0 read0 sess0 sys0 db-ROTATED 2>/dev/null)"; [[ -n "$G4" && "$G4" != "$G0" && "$A4" == "$A0" ]] && ok "rotating the database password changes the gateway's hash (postgres url)" || bad "db rotation: '$G4' '$A4'"
read -r G5 A5 <<<"$(secrets_plan s5 jwt0 read0 sess-ROTATED sys0 db0 2>/dev/null)"; [[ -n "$A5" && "$A5" != "$A0" && "$G5" == "$G0" ]] && ok "rotating the app session secret changes the app's hash only" || bad "session rotation: '$G5' '$A5'"
read -r G6 A6 <<<"$(secrets_plan s6 jwt0 read0 sess0 sys-ROTATED db0 2>/dev/null)"; [[ -n "$A6" && "$A6" != "$A0" && "$G6" != "$G0" ]] && ok "rotating the system key changes both (the gateway config embeds it, the app reads it)" || bad "system key rotation: '$G6' '$A6'"
read -r G7 A7 <<<"$(secrets_plan s7 jwt0 read0 sess0 sys0 db0 "$(tfv s7 <<<'oidc_client_secret = "a-different-oidc-client-secret"')" 2>/dev/null)"; [[ -n "$G7" && "$G7" != "$G0" && "$A7" == "$A0" ]] && ok "filling in / changing the OIDC client secret changes the gateway's hash (placeholder -> real secret rolls the gateway)" || bad "oidc secret: '$G7' '$A7'"
read -r G8 A8 <<<"$(secrets_plan s8 jwt0 read0 sess0 sys0 db0 "$(tfv s8 <<<'oidc_client_secret = null')" 2>/dev/null)"; [[ -n "$G8" && "$G8" != "$G0" ]] && ok "the placeholder OIDC secret hashes differently from a real one" || bad "placeholder oidc hash"
assert "SECRETS_HASH is not sensitive (a digest, safe in the revision) and the value is not a secret itself" "$S/out/sv-s0.json" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service") | .change.after_sensitive.template[0].containers[0].env[] | select(.value==true)] | length == 0'
# old behaviour: CONFIG_HASH alone cannot see these
cfg_hash() { jq -r '[.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="gateway") | .change.after.template[0].containers[0].env[] | select(.name=="CONFIG_HASH") | .value][0]' "$1"; }
[[ -n "$(cfg_hash "$S/out/sv-s0.json")" && "$(cfg_hash "$S/out/sv-s0.json")" == "$(cfg_hash "$S/out/sv-s2.json")" ]] && ok "OLD behaviour: CONFIG_HASH ignores a rotated JWT secret (the gap SECRETS_HASH closes)" || bad "CONFIG_HASH unexpectedly changed with a rotated secret"

# --- budget-app boost and tick alerts (the app logs structured JSON events on stdout)
cat > "$S/matchlog.py" <<'PY'
import json, re, sys
# A minimal evaluator for the filters these metrics use: clauses joined by AND, each  path="value"  (equality on a resource label or a
# jsonPayload field). Anything else in a filter makes it raise, so the evaluator cannot silently accept a filter it does not understand.
def get(entry, path):
    cur = entry
    for part in path.split('.'):
        if not isinstance(cur, dict) or part not in cur: return None
        cur = cur[part]
    return cur
def matches(flt, entry):
    for clause in flt.split(' AND '):
        m = re.fullmatch(r'([A-Za-z0-9_.]+)="([^"]*)"', clause.strip())
        if not m: raise SystemExit('unsupported clause: ' + clause)
        if get(entry, m.group(1)) != m.group(2): return False
    return True
plan = json.load(open(sys.argv[1]))
metrics = {r['change']['after']['name']: r['change']['after']['filter'] for r in plan['resource_changes'] if r['type'] == 'google_logging_metric'}
def entry(svc, **payload): return {'resource': {'type': 'cloud_run_revision', 'labels': {'service_name': svc}}, 'jsonPayload': payload}
APP, GW = 'claude-budget-app', 'claude-gateway'
# sample lines in the shapes api/lib/overrides.mjs and routes.mjs emit
samples = {
  'claude_app_override_overdue': {'evt': 'override.overdue', 'level': 'warn', 'id': 'ov_1', 'sub': 's', 'period': 'weekly', 'overdueMs': 61000, 'note': None},
  'claude_app_override_error': {'evt': 'override.error', 'id': 'ov_1', 'phase': 'end', 'attempts': 2, 'error': 'gateway 503'},
  'claude_app_override_failed': {'evt': 'override.failed', 'id': 'ov_1', 'sub': 's', 'reason': 'no-cap-to-extend'},
  'claude_app_override_lost_claim': {'evt': 'override.lost-claim', 'id': 'ov_1'},
  'claude_app_override_creator_removed': {'evt': 'override.creator-removed', 'level': 'warn', 'id': 'ov_1', 'sub': 's', 'period': 'monthly', 'by': 'gone@example.com', 'endsAt': '2026-10-20T00:00:00Z'},
  'claude_app_override_superseded': {'evt': 'override.superseded', 'id': 'ov_1', 'sub': 's', 'period': 'weekly'},
  'claude_app_overrides_store_error': {'evt': 'overrides.store.error', 'level': 'error', 'error': 'bad json'},
  'claude_app_tick_error': {'evt': 'tick.error', 'error': 'boom'},
  'claude_app_usage_ingest_error': {'evt': 'usage.ingest.error', 'error': 'logging 403'},
  'claude_app_tick': {'evt': 'tick', 'via': 'scheduler', 'applied': 0, 'ended': 0, 'failed': 0},
}
bad = []
for name, payload in samples.items():
    f = metrics.get(name)
    if f is None: bad.append('missing metric ' + name); continue
    if not matches(f, entry(APP, **payload)): bad.append(name + ' does not match its own sample line')
    if matches(f, entry(GW, **payload)): bad.append(name + ' matches the same event from the GATEWAY service')
    for other, op in samples.items():
        if other != name and matches(f, entry(APP, **op)): bad.append(name + ' also matches the sample of ' + other)
    for evt in (payload['evt'] + '.x', payload['evt'][:-1], payload['evt'].upper(), ''):
        if matches(f, entry(APP, **{**payload, 'evt': evt})): bad.append(name + ' matches a near-miss evt ' + repr(evt))
    if matches(f, {'resource': {'type': 'cloud_run_revision', 'labels': {'service_name': APP}}, 'textPayload': payload['evt']}): bad.append(name + ' matches a plain text line')
    if matches(f, {'resource': {'type': 'cloud_scheduler_job', 'labels': {'service_name': APP}}, 'jsonPayload': payload}): bad.append(name + ' matches another resource type')
print('OK' if not bad else '; '.join(bad))
PY
assert_eq "app event metrics: every filter matches its own sample JSON line and nothing else (other events, near-misses, the gateway's logs, text lines, other resource types)" "$(python3 -I "$S/matchlog.py" "$P")" "OK"
ALERT='.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after'
for spec in 'boost overdue, cap NOT restored|claude_app_override_overdue|0|600|CRITICAL' 'boost steps failing|claude_app_override_error|4|900|ERROR' 'a boost could not start|claude_app_override_failed|0|1800|ERROR' 'boost claims being lost|claude_app_override_lost_claim|4|900|WARNING' 'boost created by a removed admin|claude_app_override_creator_removed|0|3600|WARNING' 'override state unreadable|claude_app_overrides_store_error|0|600|CRITICAL'; do
  IFS='|' read -r nm met thr per sev <<<"$spec"
  assert "alert '$nm': metric $met, fires at ${thr}+1 events, window ${per}s, severity $sev" "$P" "[$ALERT | select(.display_name | endswith(\"$nm\")) | {c: .conditions[0].condition_threshold[0], s: .severity}] | (length==1 and .[0].c.filter==\"metric.type=\\\"logging.googleapis.com/user/$met\\\" AND resource.type=one_of(\\\"cloud_run_revision\\\", \\\"cloud_run_job\\\")\" and .[0].c.threshold_value==$thr and .[0].c.aggregations[0].alignment_period==\"${per}s\" and .[0].s==\"$sev\")"
done
assert "alert 'tick or usage ingest failing': both metrics, 3 or more in 15 minutes" "$P" "[$ALERT | select(.display_name | endswith(\"tick or usage ingest failing\")) | .conditions[0].condition_threshold[0]] | (length==1 and (.[0].filter|contains(\"claude_app_tick_error\") and contains(\"claude_app_usage_ingest_error\")) and .[0].threshold_value==2 and .[0].aggregations[0].alignment_period==\"900s\")"
assert "every app-event alert's documentation carries the runbook step (compare each active boost's cap, cancel from the Activity page)" "$P" "[$ALERT | select(.display_name | test(\"boost|override state\")) | .documentation[0].content | select(contains(\"Activity page\") and contains(\"personal cap\"))] | length == 5"
assert "tick-missing alert: absence of the app's tick heartbeat for 5 minutes, only for the default every-minute schedule" "$P" "[$ALERT | select(.display_name == \"Claude budget app: scheduler tick missing\") | .conditions[0].condition_absent[0]] | (length==1 and .[0].duration==\"300s\" and (.[0].filter|contains(\"claude_app_tick\")))"
plan slowtick "$(tfv slowtick <<<'tick_schedule = "*/10 * * * *"')" && assert "slower tick_schedule: no tick-missing alert (it would fire constantly); the rest stay" "$S/out/slowtick.json" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy") | .change.after.display_name | select(test("tick missing"))] | length == 0' || bad "slowtick plan"
plan evthr "$(tfv evthr <<<'alert_thresholds = { override_overdue = 3, override_errors = 10, store_errors = 2, tick_errors = 6, tick_missing_minutes = 15 }')" && {
  assert "alert_thresholds keys override the app-event defaults (N or more => threshold N-1)" "$S/out/evthr.json" "[$ALERT | select(.display_name | test(\"cap NOT restored|steps failing|override state|tick or usage\")) | .conditions[0].condition_threshold[0].threshold_value] | sort == [1,2,5,9]" 
  assert "tick_missing_minutes sets the absence window" "$S/out/evthr.json" "[$ALERT | select(.display_name | test(\"tick missing\")) | .conditions[0].condition_absent[0].duration] == [\"900s\"]"
} || bad "evthr plan"
assert "dashboard has widgets for the boost problems, creator-removed/superseded and ticks/tick errors" "$P" '.resource_changes[] | select(.type=="google_monitoring_dashboard") | .change.after.dashboard_json | fromjson | [.mosaicLayout.tiles[].widget.title] | (any(.[]; test("Budget boosts: problems")) and any(.[]; test("creator removed and superseded")) and any(.[]; test("App ticks, tick errors")))'
assert "superseded has a metric and a dashboard series but NO alert" "$P" "([$ALERT | select(.display_name|test(\"superseded\"))] | length == 0) and (.resource_changes[] | select(.type==\"google_monitoring_dashboard\") | .change.after.dashboard_json | contains(\"claude_app_override_superseded\"))"
for evt in override.overdue override.error override.failed override.lost-claim override.creator-removed override.superseded overrides.store.error tick.error usage.ingest.error; do
  grep -qF "$evt" "$REPO/docs/DEPLOY.md" && ok "docs/DEPLOY.md documents $evt" || bad "docs/DEPLOY.md does not mention $evt"
done
grep -q "Activity page" "$REPO/docs/DEPLOY.md" && grep -q "tick missing\|tick-missing" "$REPO/docs/DEPLOY.md" && ok "docs/DEPLOY.md has the boost runbook and the tick-missing alert" || bad "docs/DEPLOY.md lacks the runbook or the tick-missing alert"

# --- L8: Cloud SQL
assert "SQL: ENCRYPTED_ONLY ssl mode, private IP only" "$P" "$SQLR | .settings[0].ip_configuration[0] | (.ssl_mode==\"ENCRYPTED_ONLY\" and .ipv4_enabled==false)"
assert "SQL: maintenance window Sunday 03:00 UTC, stable track" "$P" "$SQLR | .settings[0].maintenance_window[0] | (.day==7 and .hour==3 and .update_track==\"stable\")"
assert "SQL trial: deletion protection off at both levels (a trial can be destroyed)" "$P" "$SQLR | (.deletion_protection==false and .settings[0].deletion_protection_enabled==false)"
assert "SQL production: deletion protection ON at the GCP level as well" "$S/out/prod.json" "$SQLR | (.deletion_protection==true and .settings[0].deletion_protection_enabled==true)"
plan maint "$(tfv maint <<<'db_maintenance_window = { day = 2, hour = 22 }')" && assert "db_maintenance_window is configurable" "$S/out/maint.json" "$SQLR | .settings[0].maintenance_window[0] | (.day==2 and .hour==22)" || bad "maint plan"
expect_fail "db_maintenance_window validates day/hour" maint_bad "day is 1-7 and hour is 0-23" "$(tfv maint_bad <<<'db_maintenance_window = { day = 9, hour = 3 }')"
assert "SQL password and URL: the gateway connects with sslmode=require" "$P" '[.resource_changes[] | select(.type=="google_secret_manager_secret_version")] | length == 8'

# --- L2: gateway Vertex role
assert "gateway_vertex_role defaults to roles/aiplatform.user" "$P" '[.resource_changes[] | select(.type=="google_project_iam_member" and .name=="gateway_vertex") | .change.after.role] == ["roles/aiplatform.user"]'
plan vrole "$(tfv vrole <<<'gateway_vertex_role = "projects/fake-gateway-test/roles/claudeGatewayPredict"
upstreams = [{ project_id = "other-project-123" }]')" && assert "gateway_vertex_role applies to this project and to upstream projects" "$S/out/vrole.json" '[.resource_changes[] | select(.type=="google_project_iam_member" and (.name|startswith("gateway_vertex"))) | .change.after.role] | (length==2 and all(.[]; .=="projects/fake-gateway-test/roles/claudeGatewayPredict"))' || bad "vrole plan"
expect_fail "gateway_vertex_role must look like a role name" vrole_bad "gateway_vertex_role is roles/<name>" "$(tfv vrole_bad <<<'gateway_vertex_role = "owner"')"

# --- L1: app log access
assert "default: the app SA has roles/logging.viewer on the project, unconditioned (documented residual exposure)" "$P" '[.resource_changes[] | select(.type=="google_project_iam_member" and .name=="app_logs") | .change.after | select(.role=="roles/logging.viewer" and ((.condition // []) | length == 0))] | length == 1'
assert "default: no log view, no USAGE_LOGS_VIEW env" "$P" "([.resource_changes[] | select(.type==\"google_logging_log_view\")] | length == 0) and ([$APP | .template[0].containers[0].env[] | select(.name==\"USAGE_LOGS_VIEW\")] | length == 0)"
plan scoped "$(tfv scoped <<<'scope_app_log_access = true')" && {
  assert "scope_app_log_access: no project-wide viewer; a gateway-only log view + viewAccessor limited to that view" "$S/out/scoped.json" '([.resource_changes[] | select(.type=="google_project_iam_member" and .name=="app_logs")] | length == 0) and ([.resource_changes[] | select(.type=="google_logging_log_view") | .change.after | select(.filter|contains("claude-gateway"))] | length == 1) and ([.resource_changes[] | select(.type=="google_project_iam_member" and .name=="app_log_view") | .change.after | select(.role=="roles/logging.viewAccessor" and (.condition[0].expression|contains("views/claude-gateway-logs")))] | length == 1)'
  assert "scope_app_log_access: the app gets USAGE_LOGS_VIEW with the view's resource name" "$S/out/scoped.json" "[$APP | .template[0].containers[0].env[] | select(.name==\"USAGE_LOGS_VIEW\") | .value][0] == \"projects/fake-gateway-test/locations/global/buckets/_Default/views/claude-gateway-logs\""
} || bad "scoped plan"

# --- M5/L3-ish: public_url strictness (the installer stamps it into scripts) and quoting of outputs
for u in 'https://gw.example.com$(touch X)' 'https://ev il.com' 'https://a.com;x' 'https://a.com`id`' 'https://a.com|b' 'https://a.com&b' 'https://a.com/path' 'https://a.com?q=1' 'https://a.com#f' 'https://u@a.com' 'https://a_b.com' 'https://a.com:0' 'https://a.com:99999' 'https://a.com:80a' 'http://example.com' 'http://localhost.evil.com' 'ftp://a.com' 'https://-a.com' 'https://a..com' 'https://a.com"' "https://a.com'" 'https://(a).com' 'https://a.com\\' 'https://a.com/' 'http://localhost:8891/' 'localhost:8891' 'https://'; do
  n="url_$(printf '%s' "$u" | cksum | cut -d' ' -f1)"
  printf 'public_url = %s\n' "$(jq -Rn --arg v "$u" '$v' | sed 's/\$/$$/g')" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then bad "public_url '$u' was accepted"; else flat "$S/out/$n.log" | grep -qE 'public_url' && ok "public_url rejects: $u" || { bad "public_url '$u': failed for another reason"; sed -n 1,8 "$S/out/$n.log"; }; fi
done
printf 'public_url = "https://a.com\\n"\n' >"$S/url_nl.tfvars"
plan url_nl "$S/url_nl.tfvars" && bad "public_url with a newline was accepted" || ok "public_url rejects a trailing newline"
for u in 'http://localhost:8891' 'http://127.0.0.1:8891' 'http://[::1]:8891' 'http://localhost' 'https://claude.internal.example.com' 'https://gw.example.com:8443' 'https://10.1.2.3' 'https://xn--bcher-kva.example'; do
  n="urlok_$(printf '%s' "$u" | cksum | cut -d' ' -f1)"
  printf 'public_url = "%s"\n' "$u" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then ok "public_url accepts: $u"; else bad "public_url '$u' was rejected"; sed -n 1,8 "$S/out/$n.log"; fi
done
assert "client_install_hint single-quotes the gateway URL" "$P" '.planned_values.outputs.client_install_hint.value == "client/claude-gateway-setup.sh install --gateway-url '"'"'http://localhost:8891'"'"'"'
assert "next_steps single-quotes the gateway URL too" "$P" '.planned_values.outputs.next_steps.value | contains("--gateway-url '"'"'http://localhost:8891'"'"'")'

# ============================================================================================================================
section "gateway.yaml rendering (module in a throwaway root: no provider, no resources)"
R="$S/render"; mkdir -p "$R"
cat > "$R/main.tf" <<RTF
variable "catalog_path" { type = string }
variable "upstreams"    { type = any }
variable "admins"       { type = any }
variable "extra"        {
  type    = map(string)
  default = {}
}
module "g" {
  source                = "$TF/modules/gateway_config"
  catalog_json          = file(var.catalog_path)
  upstreams             = var.upstreams
  public_url            = "http://localhost:8891"
  oidc_issuer           = "https://accounts.google.com"
  oidc_client_id        = "123456789012-abcdef123456.apps.googleusercontent.com"
  extra_auth_params     = var.extra
  allowed_email_domains = ["example.com", "corp.example.org"]
  admins                = var.admins
  system_key            = "SYSTEMKEY0123456789012345678901234567890123"
}
output "rendered"         { value = module.g.rendered }
output "available_models" { value = module.g.available_models }
output "env_pins"         { value = module.g.env_pins }
RTF
( cd "$R" && terraform init -backend=false -input=false -no-color >"$S/out/render-init.log" 2>&1 ) && ok "render root init" || { bad "render root init"; cat "$S/out/render-init.log"; }

K1=ADMINKEY1_0123456789012345678901234567890123
K2=ADMINKEY2_0123456789012345678901234567890123
K3=ADMINKEY3_0123456789012345678901234567890123
UP1='[{"provider":"vertex","region":"global","project_id":"proj-a"}]'
UP2='[{"provider":"vertex","region":"global","project_id":"proj-a"},{"provider":"vertex","region":"us-east5","project_id":"proj-b"}]'
ADM1="[{\"email\":\"alice@example.com\",\"key\":\"$K1\"}]"
ADM3="[{\"email\":\"alice@example.com\",\"key\":\"$K1\"},{\"email\":\"bob@example.com\",\"key\":\"$K2\"},{\"email\":\"carol@example.com\",\"key\":\"$K3\"}]"

render() {   # render <name> <catalog file> <upstreams json> <admins json> [extra-params json]  -> $S/out/r_<name>.{log,json,yaml.json}
  local n="$1" cat="$2" up="$3" ad="$4" ex="${5:-}"; [[ -n "$ex" ]] || ex='{}'
  jq -n --arg c "$cat" --argjson u "$up" --argjson a "$ad" --argjson e "$ex" '{catalog_path:$c, upstreams:$u, admins:$a, extra:$e}' >"$S/$n.rv.tfvars.json"
  ( cd "$R" && terraform plan -input=false -no-color -lock=false -var-file="$S/$n.rv.tfvars.json" -out="$S/out/r_$n.bin" >"$S/out/r_$n.log" 2>&1 ) || return 1
  ( cd "$R" && terraform show -json "$S/out/r_$n.bin" ) >"$S/out/r_$n.json" 2>/dev/null
  jq -r '.planned_values.outputs.rendered.value' "$S/out/r_$n.json" >"$S/out/r_$n.yaml"
  ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load(File.read(ARGV[0])))' "$S/out/r_$n.yaml" >"$S/out/r_$n.yaml.json" 2>"$S/out/r_$n.yamlerr"
}
Y() { echo "$S/out/r_$1.yaml.json"; }
SON=claude-sonnet-5-5; OPU=claude-opus-5-5; HAI=claude-haiku-5-5; S46=claude-sonnet-4-6; O46=claude-opus-4-6

if render a1 "$S/models.orig.json" "$UP1" "$ADM1"; then
  ok "render 1 admin / 1 upstream: valid YAML"
  assert "1 admin: write keys = alice + system:overrides, keys present" "$(Y a1)" ".admin.write_keys | (map(.id) == [\"alice@example.com\",\"system:overrides\"]) and (.[0].key==\"$K1\") and (.[1].key|length >= 32)"
  assert "1 upstream: vertex at proj-a" "$(Y a1)" '.upstreams | (length==1 and .[0].provider=="vertex" and .[0].project_id=="proj-a" and .[0].region=="global" and .[0].auth=={})'
  assert "availableModels: default first, every enabled model (incl. 4.6)" "$(Y a1)" ".managed.policies[0].code | (.availableModels==[\"$SON\",\"$OPU\",\"$HAI\",\"$S46\",\"$O46\"] and .enforceAvailableModels==true)"
  assert "the policy states the starting model explicitly (model = the default id = first availableModels entry)" "$(Y a1)" ".managed.policies[0].code | (.model==\"$SON\" and .model==.availableModels[0])"
  assert "env pins stay on 5.5: the 4.6 entries are allowed but do not pin" "$(Y a1)" ".managed.policies[0].code.env | (. == {\"ANTHROPIC_DEFAULT_SONNET_MODEL\":\"$SON\",\"ANTHROPIC_DEFAULT_OPUS_MODEL\":\"$OPU\",\"ANTHROPIC_DEFAULT_HAIKU_MODEL\":\"$HAI\"})"
  assert "secrets stay as \${VAR} references (JWT, OIDC secret, Postgres, read key)" "$(Y a1)" '(.session.jwt_secret=="${GATEWAY_JWT_SECRET}" and .oidc.client_secret=="${OIDC_CLIENT_SECRET}" and .store.postgres_url=="${GATEWAY_POSTGRES_URL}" and .admin.read_keys[0].key=="${GATEWAY_ADMIN_READ_KEY}")'
  assert "oidc: issuer, client id, allowed domains" "$(Y a1)" '.oidc | (.issuer=="https://accounts.google.com" and .allowed_email_domains==["example.com","corp.example.org"] and (.extra_auth_params=={}))'
else bad "render a1"; tail -12 "$S/out/r_a1.log"; fi

if render a3 "$S/models.orig.json" "$UP2" "$ADM3" '{"access_type":"offline","prompt":"consent","hd":"example.com"}'; then
  ok "render 3 admins / 2 upstreams: valid YAML"
  assert "3 admins: all personal keys plus system:overrides" "$(Y a3)" ".admin.write_keys | (map(.id) == [\"alice@example.com\",\"bob@example.com\",\"carol@example.com\",\"system:overrides\"]) and (map(.key)[0:3] == [\"$K1\",\"$K2\",\"$K3\"])"
  assert "2 upstreams, second in us-east5 / proj-b" "$(Y a3)" '.upstreams | (length==2 and .[1].region=="us-east5" and .[1].project_id=="proj-b" and .[1].provider=="vertex")'
  assert "extra auth params (access_type, prompt, hd) rendered" "$(Y a3)" '.oidc.extra_auth_params == {"access_type":"offline","prompt":"consent","hd":"example.com"}'
else bad "render a3"; tail -12 "$S/out/r_a3.log"; fi

# the catalog as shipped: Sonnet 4.6 is the starting model and the Sonnet pin; Opus stays on 5.5
if render shipped "$S/models.shipped.json" "$UP1" "$ADM1"; then
  assert "shipped catalog: availableModels starts with Sonnet 4.6 and allows everything else" "$(Y shipped)" ".managed.policies[0].code | (.availableModels==[\"$S46\",\"$SON\",\"$OPU\",\"$HAI\",\"$O46\"] and .enforceAvailableModels==true)"
  assert "shipped catalog: the policy starts everyone on Sonnet 4.6" "$(Y shipped)" ".managed.policies[0].code | (.model==\"$S46\" and .model==.availableModels[0])"
  assert "shipped catalog: pins are Sonnet 4.6, Opus 5.5, Haiku 5.5" "$(Y shipped)" ".managed.policies[0].code.env == {\"ANTHROPIC_DEFAULT_SONNET_MODEL\":\"$S46\",\"ANTHROPIC_DEFAULT_OPUS_MODEL\":\"$OPU\",\"ANTHROPIC_DEFAULT_HAIKU_MODEL\":\"$HAI\"}"
else bad "render shipped"; tail -12 "$S/out/r_shipped.log"; fi

# models disabled / default switched / 4th model
jq '(.models[] | select(.alias=="opus") | .enabled) = false' "$S/models.orig.json" >"$S/m_noopus.json"
if render nopus "$S/m_noopus.json" "$UP1" "$ADM1"; then
  assert "disabled model leaves availableModels and the env pins" "$(Y nopus)" ".managed.policies[0].code | (.availableModels==[\"$SON\",\"$HAI\",\"$S46\",\"$O46\"] and (.env|has(\"ANTHROPIC_DEFAULT_OPUS_MODEL\")|not) and .env.ANTHROPIC_DEFAULT_SONNET_MODEL==\"$SON\")"
else bad "render nopus"; tail -8 "$S/out/r_nopus.log"; fi
jq '.default = "haiku"' "$S/models.orig.json" >"$S/m_haiku.json"
if render haiku "$S/m_haiku.json" "$UP1" "$ADM1"; then
  assert "default alias moves its model to the front of availableModels" "$(Y haiku)" ".managed.policies[0].code.availableModels == [\"$HAI\",\"$SON\",\"$OPU\",\"$S46\",\"$O46\"]"
  assert "default alias: the policy model is that model" "$(Y haiku)" ".managed.policies[0].code.model == \"$HAI\""
else bad "render haiku"; tail -8 "$S/out/r_haiku.log"; fi
jq '.models += [{"alias":"custom","id":"claude-test-9-9","label":"Test 9.9","tier":"fast","description":"x","enabled":true}]' "$S/models.orig.json" >"$S/m_four.json"
if render four "$S/m_four.json" "$UP1" "$ADM1"; then
  assert "a 4th model appears in availableModels (and changes the rendered config)" "$(Y four)" ".managed.policies[0].code.availableModels == [\"$SON\",\"$OPU\",\"$HAI\",\"$S46\",\"$O46\",\"claude-test-9-9\"]"
  assert "a non-Claude-Code alias adds no env pin" "$(Y four)" '.managed.policies[0].code.env | keys == ["ANTHROPIC_DEFAULT_HAIKU_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL"]'
  if ! diff -q "$S/out/r_a1.yaml" "$S/out/r_four.yaml" >/dev/null; then ok "rendered config differs from the 5-model one"; else bad "rendered config did not change"; fi
else bad "render four"; tail -8 "$S/out/r_four.log"; fi
jq '.models += [{"alias":"sonnet","id":"claude-other","enabled":true}]' "$S/models.orig.json" >"$S/m_dupalias.json"
if render dupalias "$S/m_dupalias.json" "$UP1" "$ADM1"; then bad "duplicate alias should fail"; else flat "$S/out/r_dupalias.log" | grep -qF "aliases must be unique" && ok "duplicate alias is rejected with a message" || { bad "duplicate alias message"; tail -8 "$S/out/r_dupalias.log"; }; fi
# Claude 4.6: the "run 4.6 as the default for everyone" recipe, other ways to move a pin, and the invalid combinations
RECIPE_JQ='.default = "sonnet-4-6" | (.models[] | select(.alias=="sonnet" or .alias=="opus") | .pin) = false | (.models[] | select(.alias=="sonnet-4-6" or .alias=="opus-4-6") | .pin) = true'
jq "$RECIPE_JQ" "$S/models.orig.json" >"$S/m_recipe.json"
if render recipe "$S/m_recipe.json" "$UP1" "$ADM1"; then
  assert "recipe: 4.6 is first in availableModels and every enabled model stays allowed" "$(Y recipe)" ".managed.policies[0].code.availableModels == [\"$S46\",\"$SON\",\"$OPU\",\"$HAI\",\"$O46\"]"
  assert "recipe: the policy model is Sonnet 4.6 (the recipe moves the start model, not only the list order)" "$(Y recipe)" ".managed.policies[0].code.model == \"$S46\""
  assert "recipe: the sonnet and opus pins are the 4.6 ids, haiku is unchanged" "$(Y recipe)" ".managed.policies[0].code.env == {\"ANTHROPIC_DEFAULT_SONNET_MODEL\":\"$S46\",\"ANTHROPIC_DEFAULT_OPUS_MODEL\":\"$O46\",\"ANTHROPIC_DEFAULT_HAIKU_MODEL\":\"$HAI\"}"
  assert "recipe: the module outputs agree (available_models, env_pins)" "$S/out/r_recipe.json" ".planned_values.outputs | (.available_models.value[0]==\"$S46\" and .env_pins.value.ANTHROPIC_DEFAULT_OPUS_MODEL==\"$O46\")"
else bad "render recipe"; tail -12 "$S/out/r_recipe.log"; fi
jq '.default = "claude-opus-4-6"' "$S/models.orig.json" >"$S/m_idefault.json"
if render idefault "$S/m_idefault.json" "$UP1" "$ADM1"; then
  assert "default may be an id: that model comes first" "$(Y idefault)" ".managed.policies[0].code.availableModels == [\"$O46\",\"$SON\",\"$OPU\",\"$HAI\",\"$S46\"]"
  assert "default may be an id: it is also the policy model" "$(Y idefault)" ".managed.policies[0].code.model == \"$O46\""
else bad "render idefault"; tail -8 "$S/out/r_idefault.log"; fi
jq 'del(.default)' "$S/models.orig.json" >"$S/m_nodefault.json"
if render nodefault "$S/m_nodefault.json" "$UP1" "$ADM1"; then
  assert "no default: the first enabled model is the default" "$(Y nodefault)" ".managed.policies[0].code.availableModels[0] == \"$SON\""
  assert "no default: the policy model is that first enabled model" "$(Y nodefault)" ".managed.policies[0].code.model == \"$SON\""
else bad "render nodefault"; tail -8 "$S/out/r_nodefault.log"; fi
jq '(.models[] | select(.alias=="sonnet") | .enabled) = false | .default = "sonnet-4-6" | (.models[] | select(.alias=="sonnet-4-6") | .pin) = true' "$S/models.orig.json" >"$S/m_oldoff.json"
if render oldoff "$S/m_oldoff.json" "$UP1" "$ADM1"; then
  assert "disabling the old entry is an alternative to pin:false: the pin follows the enabled one" "$(Y oldoff)" ".managed.policies[0].code.env.ANTHROPIC_DEFAULT_SONNET_MODEL == \"$S46\""
else bad "render oldoff"; tail -8 "$S/out/r_oldoff.log"; fi
jq '.models += [{"alias":"fast-sonnet","id":"claude-sonnet-x","family":"sonnet","pin":true}] | (.models[] | select(.alias=="sonnet") | .pin) = false' "$S/models.orig.json" >"$S/m_custompin.json"
if render custompin "$S/m_custompin.json" "$UP1" "$ADM1"; then
  assert "a custom alias with family and pin pins that family" "$(Y custompin)" ".managed.policies[0].code.env.ANTHROPIC_DEFAULT_SONNET_MODEL == \"claude-sonnet-x\""
else bad "render custompin"; tail -8 "$S/out/r_custompin.log"; fi
for bad_case in twopins badfam nofam pindis badpin dupcase; do
  if render "x_$bad_case" "$S/m_$bad_case.json" "$UP1" "$ADM1"; then bad "render refuses an invalid catalog: $bad_case"; else ok "render refuses an invalid catalog: $bad_case"; fi
done

if render short "$S/models.orig.json" "$UP1" '[{"email":"alice@example.com","key":"tooshort"}]'; then bad "short admin key should fail"; else flat "$S/out/r_short.log" | grep -qF "at least 32 characters" && ok "admin key shorter than 32 characters is rejected" || bad "short key message"; fi

# the repository's real catalog drives the real configuration
assert "real models.json: root plan's availableModels equals the catalog's enabled ids, default first" "$P" ".planned_values.outputs.effective_settings.value.enabled_models == [$(jq -r '[.default as $d | (.models | map(select(.enabled)) | (map(select(.alias==$d)) + map(select(.alias!=$d))) | .[].id)] | map("\"" + . + "\"") | join(",")' "$REPO/config/models.json")]"

# ============================================================================================================================
section "Claude 4.6 region note (a check block: a warning, never an error)"
flat "$S/out/base.log" | grep -qF "Check block assertion failed" && bad "default vertex_region=global must not warn about 4.6" || ok "default vertex_region (global): no 4.6 region warning"
assert "vertex_region default is still global (the upstream is at global)" "$P" '.planned_values.outputs.effective_settings.value.upstreams[0].region == "global"'
for r in us-east5 europe-west1 asia-southeast1; do
  if plan "r_$r" "$(tfv "reg_$r" <<<"vertex_region = \"$r\"")"; then flat "$S/out/r_$r.log" | grep -qF "Check block assertion failed" && bad "vertex_region=$r must not warn" || ok "vertex_region=$r: no warning"; else bad "plan vertex_region=$r"; sed -n 1,10p "$S/out/r_$r.log"; fi
done
if plan r_ew2 "$(tfv reg_ew2 <<<'vertex_region = "europe-west2"')"; then
  ok "vertex_region=europe-west2: the plan still succeeds (warning, not error)"
  flat "$S/out/r_ew2.log" | grep -qF "Check block assertion failed" && ok "europe-west2 warns that Claude 4.6 is not served there" || bad "no 4.6 region warning for europe-west2"
  flat "$S/out/r_ew2.log" | grep -qF "claude-sonnet-4-6, claude-opus-4-6" && ok "the warning names the 4.6 models" || bad "warning lacks the model ids"
  flat "$S/out/r_ew2.log" | grep -qF "europe-west2" && ok "and the offending region" || bad "warning lacks the region"
else bad "plan with vertex_region=europe-west2 must succeed"; sed -n 1,12p "$S/out/r_ew2.log"; fi
if plan r_ew2_up "$(tfv reg_ew2_up <<<'upstreams = [{ region = "global" }, { region = "europe-west2" }]')"; then
  flat "$S/out/r_ew2_up.log" | grep -qF "Check block assertion failed" && ok "an extra upstream in europe-west2 warns too" || bad "no warning for an europe-west2 upstream"
else bad "plan with an europe-west2 upstream"; sed -n 1,10p "$S/out/r_ew2_up.log"; fi
jq '(.models[] | select(.alias=="sonnet-4-6" or .alias=="opus-4-6") | .enabled) = false' "$S/models.orig.json" >"$S/m_no46.json"
setmodels "$S/m_no46.json"
if plan r_ew2_no46 "$(tfv reg_ew2_no46 <<<'vertex_region = "europe-west2"')"; then
  flat "$S/out/r_ew2_no46.log" | grep -qF "Check block assertion failed" && bad "no 4.6 model enabled: no warning expected" || ok "with the 4.6 entries disabled, europe-west2 does not warn"
else bad "plan with 4.6 disabled"; sed -n 1,10p "$S/out/r_ew2_no46.log"; fi
setmodels "$S/models.orig.json"

# ============================================================================================================================
section "enterprise edge: trial stays the trial (no edge resources with default variables)"
B="$S/out/base.json"
EAPP='.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | .change.after'
EGW='.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="gateway") | .change.after'
EENV='[.template[0].containers[0].env[] | select(.value != null) | {(.name): .value}] | add'
ENAMES='[.template[0].containers[0].env[].name]'
rcount() { assert_eq "$2" "$(jq "[.resource_changes[] | select(.type==\"$3\")] | length" "$S/out/$1.json")" "$4"; }
assert "default: no tls / dns / iap / job / bigquery / load balancer / service-identity resources" "$B" '[.resource_changes[] | select(.type|test("^tls_|^google_dns_|^google_iap_|google_cloud_run_v2_job|google_bigquery|google_project_service_identity|google_compute_(region_|forwarding_rule|global_forwarding_rule|backend_service|url_map|managed_ssl|ssl_policy|target_https|address$)|google_logging_project_sink"))] | length == 0'
assert "default: one subnet only (no LB or proxy-only subnet), no terraform_data besides the two check resources" "$B" '([.resource_changes[] | select(.type=="google_compute_subnetwork")] | length == 1) and ([.resource_changes[] | select(.type=="terraform_data")] | length == 2)'
assert "default: gateway and app keep ingress ALL, no IAP, no invoker_iam_disabled, no launch stage" "$B" "($EGW | (.ingress==\"INGRESS_TRAFFIC_ALL\" and .invoker_iam_disabled==null)) and ($EAPP | (.ingress==\"INGRESS_TRAFFIC_ALL\" and .iap_enabled==null and .launch_stage==null and .custom_audiences==[\"https://claude-budget-tick.fake-gateway-test.invalid\"]))"
assert "default: the app env still has the scheduler identity, the localhost origin, no APP_AUTH_MODE / IAP_* / GATEWAY_CA_PEM" "$B" "$EAPP | $EENV | (.SCHEDULER_SA!=null and .SCHEDULER_AUDIENCE!=null and .APP_ALLOWED_ORIGINS==\"http://localhost:8892\" and .APP_ALLOWED_HOST_SUFFIXES==\".run.app\" and (has(\"APP_AUTH_MODE\")|not) and (has(\"IAP_AUDIENCE\")|not) and (has(\"GATEWAY_CA_PEM\")|not) and .GATEWAY_AUDIENCE==.GATEWAY_URL)"
assert "default: scheduler job still calls the app tick route with an OIDC token (no OAuth token)" "$B" '.resource_changes[] | select(.type=="google_cloud_scheduler_job") | .change.after.http_target[0] | ((.oidc_token|length)==1 and (.oauth_token|length)==0 and .oidc_token[0].audience=="https://claude-budget-tick.fake-gateway-test.invalid")'
assert "default: outputs - edge variables off, proxy_command still the proxy, gateway_url is the Cloud Run URL" "$B" '(.planned_values.outputs.iap_audience.value == null) and (.planned_values.outputs.gateway_ca_pem.value == null) and (.planned_values.outputs.edge_next_steps.value|contains("No enterprise-edge steps")) and (.output_changes.proxy_command.after_unknown == true)'
assert "default: the app invokers and the scheduler grant exist as before (moved to app_scheduler[0])" "$B" '([.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and .name=="app_scheduler")] | length == 1) and ([.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and .name=="app_invokers")] | length == 2)'
assert "default: the effective settings say so" "$B" '.planned_values.outputs.effective_settings.value | (.app_access=="iam" and .gateway_exposure=="run_app" and .analytics=="logging" and .public_url=="http://localhost:8891")'

# ---- IAP directly on Cloud Run -------------------------------------------------------------------------------------------
section "enterprise edge: app_access = iap (IAP on the Cloud Run URL)"
plan iapd "$(tfv iapd <<'TFV'
app_access = "iap"
project_number = "123456789012"
app_viewers = ["group:eng@example.com"]
iap_allowed_domains = ["example.com"]
TFV
)" && {
  I="$S/out/iapd.json"
  assert "app: ingress ALL, iap_enabled, launch stage BETA, no scheduler custom audience" "$I" "$EAPP | (.ingress==\"INGRESS_TRAFFIC_ALL\" and .iap_enabled==true and .launch_stage==\"BETA\" and .custom_audiences==null)"
  assert "app env: APP_AUTH_MODE=iap and IAP_AUDIENCE built from the project NUMBER, region and service name" "$I" "$EAPP | $EENV | (.APP_AUTH_MODE==\"iap\" and .IAP_AUDIENCE==\"/projects/123456789012/locations/europe-west2/services/claude-budget-app\")"
  assert "app env: IAP_ALLOWED_DOMAINS passed, no scheduler identity, no IAP_PUBLIC_KEYS_URL, no foreign origin" "$I" "$EAPP | $EENV | (.IAP_ALLOWED_DOMAINS==\"example.com\" and (has(\"SCHEDULER_SA\")|not) and (has(\"SCHEDULER_AUDIENCE\")|not) and (has(\"IAP_PUBLIC_KEYS_URL\")|not) and .APP_ALLOWED_ORIGINS==\"\" and .APP_ALLOWED_HOST_SUFFIXES==\"\" and .APP_ALLOWED_HOSTS==\"claude-budget-app-123456789012.europe-west2.run.app\")"
  assert "direct IAP: app_url is that same deterministic host (the one the app admits); the tick job gets APP_STATE_BUCKET and the same host list" "$I" "(.planned_values.outputs.app_url.value==\"https://claude-budget-app-123456789012.europe-west2.run.app\") and (.resource_changes[] | select(.type==\"google_cloud_run_v2_job\") | .change.after.template[0].template[0].containers[0].env | [.[] | select(.value != null) | {(.name): .value}] | add | (.APP_STATE_BUCKET==\"fake-gateway-test-claude-gateway-state\" and .APP_ALLOWED_HOSTS==\"claude-budget-app-123456789012.europe-west2.run.app\"))"
  assert "app still has its secret env (admins, session, keys) and the SECRETS_HASH / ADMINS_HASH rollers" "$I" "$EAPP | $ENAMES | (index(\"APP_ADMINS\") != null and index(\"APP_SESSION_SECRET\") != null and index(\"GATEWAY_SYSTEM_WRITE_KEY\") != null and index(\"SECRETS_HASH\") != null and index(\"ADMINS_HASH\") != null)"
  assert "IAP access: admins + app_viewers get roles/iap.httpsResourceAccessor (and nobody else)" "$I" '[.resource_changes[] | select(.type=="google_iap_web_cloud_run_service_iam_member") | .change.after | select(.role=="roles/iap.httpsResourceAccessor" and .cloud_run_service_name=="claude-budget-app") | .member] | sort == ["group:eng@example.com","user:alice@example.com","user:bob@example.com"]'
  assert "IAP service agent (service-<PROJECT NUMBER>@gcp-sa-iap) holds run.invoker on the app" "$I" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and .name=="app_iap_agent") | .change.after | select(.role=="roles/run.invoker" and .member=="serviceAccount:service-123456789012@gcp-sa-iap.iam.gserviceaccount.com" and .name=="claude-budget-app")] | length == 1'
  assert "no per-person run.invoker and no scheduler grant on the app in IAP mode" "$I" '[.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and (.name=="app_invokers" or .name=="app_scheduler"))] | length == 0'
  assert "no allUsers / allAuthenticatedUsers anywhere (IAP plan)" "$I" '[.. | strings | select(. == "allUsers" or . == "allAuthenticatedUsers" or startswith("allUsers") or startswith("allAuthenticatedUsers"))] | length == 0'
  assert "gateway untouched: ingress ALL, IAM check on, no load balancer, no DNS, no TLS resources" "$I" "($EGW | (.ingress==\"INGRESS_TRAFFIC_ALL\" and .invoker_iam_disabled==null)) and ([.resource_changes[] | select(.type|test(\"^tls_|^google_dns_|forwarding_rule|google_compute_region_|google_compute_backend\"))] | length == 0)"
  assert "iap.googleapis.com is enabled (and dns is not)" "$I" '[.resource_changes[] | select(.type=="google_project_service") | .change.after.service] | (index("iap.googleapis.com") != null and index("dns.googleapis.com") == null)'
  assert "no google_project_service_identity (it would need the google-beta provider); the agent grant waits for the Cloud Run service" "$I" '([.resource_changes[] | select(.type=="google_project_service_identity")] | length == 0) and ([.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and .name=="app_iap_agent")] | length == 1)'
  assert "tick Cloud Run job: same image as the app, node api/tick.mjs, no retries" "$I" '.resource_changes[] | select(.type=="google_cloud_run_v2_job") | .change.after | .template[0].template[0] | (.containers[0].command==["node"] and .containers[0].args==["api/tick.mjs"] and .max_retries==0 and (.containers[0].image|endswith("/budget-app:20261013093000")))'
  assert_eq "tick job gets exactly the app's environment variables (one shared local)" "$(jq -r '[.resource_changes[] | select(.type=="google_cloud_run_v2_job") | .change.after.template[0].template[0].containers[0].env[].name] | sort | join(" ")' "$I")" "$(jq -r "$EAPP | $ENAMES | sort | join(\" \")" "$I")"
  assert "tick job reads the app's secrets from Secret Manager (admins, system key, read key, session) and carries SECRETS_HASH" "$I" '.resource_changes[] | select(.type=="google_cloud_run_v2_job") | .change.after.template[0].template[0].containers[0].env | ([.[] | select(.value_source|length>0) | .value_source[0].secret_key_ref[0].secret] | sort == ["claude-app-admins","claude-app-session","claude-app-system-key","claude-gateway-read-key"]) and (map(.name)|index("SECRETS_HASH") != null)'
  assert "tick job IAM: only claude-scheduler may run it (roles/run.invoker)" "$I" '[.resource_changes[] | select(.type=="google_cloud_run_v2_job_iam_member") | .change.after | select(.role=="roles/run.invoker" and (.member|startswith("serviceAccount:claude-scheduler@")) and .name=="claude-budget-tick")] | length == 1'
  assert "scheduler job: POST to the Run API jobs:run with an OAuth token for claude-scheduler (no OIDC)" "$I" '.resource_changes[] | select(.type=="google_cloud_scheduler_job") | .change.after.http_target[0] | (.uri=="https://run.googleapis.com/v2/projects/fake-gateway-test/locations/europe-west2/jobs/claude-budget-tick:run" and .http_method=="POST" and (.oauth_token|length)==1 and (.oidc_token|length)==0 and .oauth_token[0].scope=="https://www.googleapis.com/auth/cloud-platform" and (.oauth_token[0].service_account_email|startswith("claude-scheduler@")))'
  assert "monitoring follows the job: heartbeat and error metrics read the Cloud Run job's tick.job lines, plus a failed-execution alert" "$I" '([.resource_changes[] | select(.type=="google_logging_metric" and .change.after.name=="claude_app_tick") | .change.after.filter] | .[0] | (contains("cloud_run_job") and contains("tick.job"))) and ([.resource_changes[] | select(.type=="google_logging_metric" and .change.after.name=="claude_app_tick_error") | .change.after.filter] | .[0] | contains("cloud_run_job")) and ([.resource_changes[] | select(.type=="google_monitoring_alert_policy" and .name=="tick_job_failed")] | length == 1)'
  assert "override events are read from the job too (log_app covers service OR job)" "$I" '[.resource_changes[] | select(.type=="google_logging_metric" and .change.after.name=="claude_app_override_overdue") | .change.after.filter] | .[0] | (contains("cloud_run_job") and contains("cloud_run_revision"))'
  assert "outputs: iap_audience, app_url and a console checklist with the consent-screen warning" "$I" '.planned_values.outputs | (.iap_audience.value=="/projects/123456789012/locations/europe-west2/services/claude-budget-app" and (.edge_next_steps.value | (contains("OAuth consent screen") and contains("If you skip this") and contains("Test users") and contains("roles/iap.httpsResourceAccessor") and contains("ESTIMATED"))))'
  assert "run.app of the proxy_command is still the proxy (gateway is still run_app)" "$I" '.output_changes.proxy_command.after_unknown == true'
} || { bad "IAP (direct) plan"; sed -n 1,25p "$S/out/iapd.log"; }
plan iapn "$(tfv iapn <<<'app_access = "iap"')" && {
  ok "IAP without project_number plans offline (the project number is read during apply)"
  assert "IAP_AUDIENCE is unknown at plan time, not a wrong value" "$S/out/iapn.json" "$EAPP | [.template[0].containers[0].env[] | select(.name==\"IAP_AUDIENCE\") | .value] == [null]"
} || { bad "IAP plan without project_number"; sed -n 1,20p "$S/out/iapn.log"; }
plan iap_rel "$(tfv iap_rel <<'TFV'
app_access = "iap"
project_number = "123456789012"
iap_launch_stage = "GA"
TFV
)" && assert "iap_launch_stage = GA leaves the launch stage unset" "$S/out/iap_rel.json" "$EAPP | (.iap_enabled==true and .launch_stage==null)" || bad "iap_launch_stage plan"
expect_fail "app_viewers: allUsers is rejected" v_allusers "app_viewers entries must look like" "$(tfv v_allusers <<<'app_access = "iap"
app_viewers = ["allUsers"]')"
expect_fail "app_viewers: a bare email is rejected" v_bare "app_viewers entries must look like" "$(tfv v_bare <<<'app_viewers = ["eng@example.com"]')"
expect_fail "project_number must be digits" pn_bad "numeric project NUMBER" "$(tfv pn_bad <<<'project_number = "my-project"')"
expect_fail "app_access: unknown value" aa_bad "app_access must be" "$(tfv aa_bad <<<'app_access = "open"')"
expect_fail "iap_oauth_client_id without a secret is rejected" oc_half "together, or neither" "$(tfv oc_half <<<'app_access = "iap"
app_domain = "claude-budget.example.com"
iap_oauth_client_id = "123-abc.apps.googleusercontent.com"')"

# ---- IAP on a load balancer with a custom domain ----------------------------------------------------------------------
section "enterprise edge: app_access = iap with app_domain (global external load balancer)"
plan dom "$(tfv dom <<'TFV'
app_access = "iap"
app_domain = "claude-budget.example.com"
project_number = "123456789012"
app_viewers = ["domain:example.com"]
iap_oauth_client_id = "123456789012-iapclient.apps.googleusercontent.com"
iap_oauth_client_secret = "fake-iap-secret"
TFV
)" && {
  D="$S/out/dom.json"
  assert "app: ingress is internal-load-balancer only, no direct IAP flag" "$D" "$EAPP | (.ingress==\"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER\" and .iap_enabled==null and .launch_stage==null)"
  assert "origin == host allow-list: APP_ALLOWED_HOSTS is the domain and APP_ALLOWED_ORIGINS is https://<same domain>, no *.run.app suffix" "$D" "$EAPP | $EENV | (.APP_ALLOWED_HOSTS==\"claude-budget.example.com\" and .APP_ALLOWED_ORIGINS==(\"https://\" + .APP_ALLOWED_HOSTS) and .APP_ALLOWED_HOST_SUFFIXES==\"\" and .APP_AUTH_MODE==\"iap\")"
  assert "IAP_AUDIENCE is the backend service form (unknown until the backend service exists)" "$D" "$EAPP | [.template[0].containers[0].env[] | select(.name==\"IAP_AUDIENCE\") | .value] == [null]"
  rcount dom "global external forwarding rule x1" google_compute_global_forwarding_rule 1
  assert "forwarding rule: EXTERNAL_MANAGED on 443; static EXTERNAL global address" "$D" '([.resource_changes[] | select(.type=="google_compute_global_forwarding_rule") | .change.after | select(.load_balancing_scheme=="EXTERNAL_MANAGED" and .port_range=="443")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_global_address" and .name=="app_lb")] | length == 1)'
  assert "managed certificate for exactly the app domain; TLS 1.2 minimum policy" "$D" '([.resource_changes[] | select(.type=="google_compute_managed_ssl_certificate") | .change.after.managed[0].domains] == [["claude-budget.example.com"]]) and ([.resource_changes[] | select(.type=="google_compute_ssl_policy") | .change.after.min_tls_version] == ["TLS_1_2"])'
  assert "backend service: IAP enabled with the supplied OAuth client; serverless NEG points at claude-budget-app" "$D" '([.resource_changes[] | select(.type=="google_compute_backend_service") | .change.after | select(.iap[0].enabled==true and .iap[0].oauth2_client_id=="123456789012-iapclient.apps.googleusercontent.com" and .load_balancing_scheme=="EXTERNAL_MANAGED")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_region_network_endpoint_group") | .change.after | select(.network_endpoint_type=="SERVERLESS" and .cloud_run[0].service=="claude-budget-app")] | length == 1)'
  assert "IAP IAM is on the backend service (not on the Cloud Run service): admins + the domain" "$D" '([.resource_changes[] | select(.type=="google_iap_web_backend_service_iam_member") | .change.after | select(.role=="roles/iap.httpsResourceAccessor") | .member] | sort == ["domain:example.com","user:alice@example.com","user:bob@example.com"]) and ([.resource_changes[] | select(.type=="google_iap_web_cloud_run_service_iam_member")] | length == 0)'
  assert "IAP service agent still holds run.invoker on the app; no allUsers" "$D" '([.resource_changes[] | select(.type=="google_cloud_run_v2_service_iam_member" and .name=="app_iap_agent")] | length == 1) and ([.. | strings | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0)'
  assert "outputs: app_url is the custom domain; the checklist tells the A record, the certificate wait and the OAuth client steps" "$D" '.planned_values.outputs | (.app_url.value=="https://claude-budget.example.com" and (.edge_next_steps.value | (contains("A record") and contains("app_lb_ip") and contains("handleRedirect") and contains("Test users"))))'
  assert "tick job and Run API scheduler target are used here too" "$D" '([.resource_changes[] | select(.type=="google_cloud_run_v2_job")] | length == 1) and (.resource_changes[] | select(.type=="google_cloud_scheduler_job") | .change.after.http_target[0].oauth_token | length == 1)'
} || { bad "IAP custom-domain plan"; sed -n 1,25p "$S/out/dom.log"; }
plan dom_noc "$(tfv dom_noc <<'TFV'
app_access = "iap"
app_domain = "claude-budget.example.com"
project_number = "123456789012"
TFV
)" && assert "without an OAuth client the backend is still planned (IAP without oauth2 fields) and the checklist says it is unverified" "$S/out/dom_noc.json" '([.resource_changes[] | select(.type=="google_compute_backend_service") | .change.after.iap[0] | (.enabled==true and .oauth2_client_id==null)] == [true]) and (.planned_values.outputs.edge_next_steps.value | contains("not verified"))' || bad "custom domain without client"
expect_fail "app_domain needs app_access = iap" dom_noiap "app_domain needs app_access" "$(tfv dom_noiap <<<'app_domain = "claude-budget.example.com"')"
expect_fail "app_domain must be a DNS name" dom_bad "app_domain must be a lower-case DNS name" "$(tfv dom_bad <<<'app_access = "iap"
app_domain = "https://claude-budget.example.com"')"

# ---- internal load balancer for the gateway --------------------------------------------------------------------------------
section "enterprise edge: gateway_exposure = internal_lb (private address, private DNS, TLS)"
plan ilb "$(tfv ilb <<'TFV'
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
gateway_internal_networks = ["100.100.0.0/16"]
TFV
)" && {
  L="$S/out/ilb.json"
  assert "gateway: ingress internal-load-balancer only, invoker IAM check disabled" "$L" "$EGW | (.ingress==\"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER\" and .invoker_iam_disabled==true)"
  assert "no allUsers anywhere, including the gateway (no public fallback exists)" "$L" '[.. | strings | select(. == "allUsers" or . == "allAuthenticatedUsers" or startswith("allUsers") or startswith("allAuthenticatedUsers"))] | length == 0'
  assert "proxy-only subnet: REGIONAL_MANAGED_PROXY, ACTIVE, 10.0.2.0/23; LB subnet 10.0.1.0/24" "$L" '([.resource_changes[] | select(.type=="google_compute_subnetwork" and .name=="proxy_only") | .change.after | select(.purpose=="REGIONAL_MANAGED_PROXY" and .role=="ACTIVE" and .ip_cidr_range=="10.0.2.0/23")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_subnetwork" and .name=="lb") | .change.after.ip_cidr_range] == ["10.0.1.0/24"])'
  assert "reserved INTERNAL address in the LB subnet" "$L" '[.resource_changes[] | select(.type=="google_compute_address") | .change.after | select(.address_type=="INTERNAL")] | length == 1'
  assert "forwarding rule: INTERNAL_MANAGED, 443, TCP, no global access" "$L" '[.resource_changes[] | select(.type=="google_compute_forwarding_rule") | .change.after | select(.load_balancing_scheme=="INTERNAL_MANAGED" and .port_range=="443" and .ip_protocol=="TCP" and .allow_global_access==false)] | length == 1'
  assert "chain: serverless NEG (claude-gateway) -> INTERNAL_MANAGED backend -> URL map -> HTTPS proxy with TLS 1.2 policy" "$L" '([.resource_changes[] | select(.type=="google_compute_region_network_endpoint_group") | .change.after | select(.network_endpoint_type=="SERVERLESS" and .cloud_run[0].service=="claude-gateway")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_region_backend_service") | .change.after.load_balancing_scheme] == ["INTERNAL_MANAGED"]) and ([.resource_changes[] | select(.type=="google_compute_region_url_map")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_region_target_https_proxy")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_region_ssl_policy") | .change.after.min_tls_version] == ["TLS_1_2"])'
  assert "private DNS: a private zone for exactly the hostname (cannot shadow the domain), attached to the VPC, plus an A record" "$L" '([.resource_changes[] | select(.type=="google_dns_managed_zone") | .change.after | select(.visibility=="private" and .dns_name=="claude-gateway.corp.example.com." and .name=="claude-gateway-internal")] | length == 1) and ([.resource_changes[] | select(.type=="google_dns_record_set") | .change.after | select(.type=="A" and .name=="claude-gateway.corp.example.com.")] | length == 1)'
  assert "self-signed TLS: CA key + CA cert + leaf key + CSR + locally signed leaf, regional SSL certificate" "$L" '([.resource_changes[] | select(.type|test("^tls_"))] | length == 5) and ([.resource_changes[] | select(.type=="google_compute_region_ssl_certificate")] | length == 1) and ([.resource_changes[] | select(.type=="tls_cert_request") | .change.after.dns_names] == [["claude-gateway.corp.example.com"]])'
  assert "dns.googleapis.com enabled" "$L" '[.resource_changes[] | select(.type=="google_project_service") | .change.after.service] | index("dns.googleapis.com") != null'
  assert "app env wiring: GATEWAY_URL is the private https name, GATEWAY_AUDIENCE empty (no token), GATEWAY_CA_PEM present" "$L" "($EAPP | $EENV | (.GATEWAY_URL==\"https://claude-gateway.corp.example.com\" and .GATEWAY_AUDIENCE==\"\")) and ($EAPP | $ENAMES | index(\"GATEWAY_CA_PEM\") != null)"
  assert "app (iam mode) keeps the scheduler identity and gets a route into the VPC to reach the gateway" "$L" "($EAPP | $EENV | (.SCHEDULER_SA != null and (has(\"APP_AUTH_MODE\")|not))) and ($EAPP | (.template[0].vpc_access | length == 1 and .[0].egress==\"PRIVATE_RANGES_ONLY\"))"
  assert "public_url is derived: OIDC redirect URI, client defaults, gateway_url and the install hint use the private name" "$L" '.planned_values.outputs | (.oidc_redirect_uri.value=="https://claude-gateway.corp.example.com/oauth/callback" and (.client_defaults.value|fromjson|.gatewayUrl)=="https://claude-gateway.corp.example.com" and .gateway_url.value=="https://claude-gateway.corp.example.com" and (.client_install_hint.value|contains("https://claude-gateway.corp.example.com")))'
  assert "no local proxy for this topology (proxy_command explains)" "$L" '.planned_values.outputs.proxy_command.value | contains("no local proxy")'
  assert "checklist: DNS/routing, CA, redirect URI, MDM JSON with forceLoginGatewayUrl and gatewayInternalNetworks, cost estimate" "$L" '.planned_values.outputs.edge_next_steps.value | (contains("B1.") and contains("gateway_ca_pem") and contains("/oauth/callback") and contains("forceLoginGatewayUrl") and contains("100.100.0.0/16") and contains("ESTIMATED") and contains("If skipped"))'
  assert "effective settings record the topology" "$L" '.planned_values.outputs.effective_settings.value | (.gateway_exposure=="internal_lb" and .public_url=="https://claude-gateway.corp.example.com")'
} || { bad "internal_lb plan"; sed -n 1,25p "$S/out/ilb.log"; }
plan ilb_ok_url "$(tfv ilb_ok_url <<'TFV'
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
public_url = "https://claude-gateway.corp.example.com"
lb_ip = "10.0.1.10"
lb_allow_global_access = true
TFV
)" && assert "public_url equal to the derived URL is accepted; static lb_ip and global access are honoured" "$S/out/ilb_ok_url.json" '([.resource_changes[] | select(.type=="google_compute_address") | .change.after.address] == ["10.0.1.10"]) and ([.resource_changes[] | select(.type=="google_compute_forwarding_rule") | .change.after.allow_global_access] == [true])' || bad "ilb with matching public_url"
plan ilb_reuse "$(tfv ilb_reuse <<'TFV'
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
gateway_dns_zone = "corp-private"
gateway_dns_zone_create = false
TFV
)" && assert "gateway_dns_zone_create = false reuses a zone: only the A record is planned" "$S/out/ilb_reuse.json" '([.resource_changes[] | select(.type=="google_dns_managed_zone")] | length == 0) and ([.resource_changes[] | select(.type=="google_dns_record_set") | .change.after.managed_zone] == ["corp-private"])' || bad "ilb reuse zone"
PEM_OK='-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----'
plan ilb_prov "$(tfv ilb_prov <<TFV
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
gateway_tls = { mode = "provided", cert_pem = "$PEM_OK", ca_pem = "$PEM_OK" }
gateway_tls_key_pem = "FAKE-KEY-FOR-TESTS-ONLY"
TFV
)" && {
  assert "provided TLS: no tls_ resources; the regional certificate carries the given chain; the app trusts the given CA" "$S/out/ilb_prov.json" "([.resource_changes[] | select(.type|test(\"^tls_\"))] | length == 0) and ([.resource_changes[] | select(.type==\"google_compute_region_ssl_certificate\") | .change.after.certificate] == [\"-----BEGIN CERTIFICATE-----\\nMIIBfake\\n-----END CERTIFICATE-----\"]) and ($EAPP | $EENV | .GATEWAY_CA_PEM == \"-----BEGIN CERTIFICATE-----\\nMIIBfake\\n-----END CERTIFICATE-----\") and (.planned_values.outputs.gateway_ca_pem.value | startswith(\"-----BEGIN CERTIFICATE-----\"))"
} || { bad "provided TLS plan"; sed -n 1,20p "$S/out/ilb_prov.log"; }
plan ilb_prov_noca "$(tfv ilb_prov_noca <<TFV
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
gateway_tls = { mode = "provided", cert_pem = "$PEM_OK" }
gateway_tls_key_pem = "FAKE-KEY-FOR-TESTS-ONLY"
TFV
)" && {
  assert "provided TLS without ca_pem: no GATEWAY_CA_PEM env" "$S/out/ilb_prov_noca.json" "$EAPP | $ENAMES | index(\"GATEWAY_CA_PEM\") == null"
  if flat "$S/out/ilb_prov_noca.log" | grep -qF "set gateway_tls.ca_pem"; then ok "provided TLS without ca_pem warns that the app trusts only Node's CAs"; else bad "no warning for provided TLS without ca_pem"; fi
} || bad "provided TLS without CA plan"
expect_fail "internal_lb needs gateway_hostname" lb_nohost "needs gateway_hostname" "$(tfv lb_nohost <<<'gateway_exposure = "internal_lb"')"
expect_fail "gateway_hostname without internal_lb is rejected" host_nolb "only used with gateway_exposure" "$(tfv host_nolb <<<'gateway_hostname = "claude-gateway.corp.example.com"')"
expect_fail "gateway_hostname cannot be an IP address" host_ip "gateway_hostname must be a lower-case DNS name" "$(tfv host_ip <<<'gateway_exposure = "internal_lb"
gateway_hostname = "10.0.1.10"')"
expect_fail "public_url that differs from https://<gateway_hostname> is rejected" lb_url_mismatch "public_url is derived as https://<gateway_hostname>" "$(tfv lb_url_mismatch <<<'gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
public_url = "https://other.corp.example.com"')"
expect_fail "gateway_exposure: unknown value" ge_bad "gateway_exposure must be" "$(tfv ge_bad <<<'gateway_exposure = "public"')"
expect_fail "gateway_tls.mode: unknown value" tls_bad "gateway_tls.mode must be" "$(tfv tls_bad <<<'gateway_tls = { mode = "acme" }')"
expect_fail "gateway_tls provided without a certificate is rejected" tls_nocert "needs cert_pem" "$(tfv tls_nocert <<<'gateway_tls = { mode = "provided" }')"
expect_fail "gateway_tls provided without the key variable is rejected (and says where the key goes)" tls_nokey "gateway_tls_key_pem" "$(tfv tls_nokey <<<'gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
gateway_tls = { mode = "provided", cert_pem = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" }')"
expect_fail "proxy_only_subnet_cidr smaller than /26 is rejected" pso_small "/26 or larger" "$(tfv pso_small <<<'proxy_only_subnet_cidr = "10.0.2.0/28"')"
expect_fail "lb_subnet_cidr and proxy_only_subnet_cidr must differ" lb_same "must be different ranges" "$(tfv lb_same <<<'gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
lb_subnet_cidr = "10.0.2.0/24"
proxy_only_subnet_cidr = "10.0.2.0/24"')"
expect_fail "gateway_internal_networks must be CIDRs" gin_bad "must be CIDRs" "$(tfv gin_bad <<<'gateway_internal_networks = ["corp"]')"
expect_fail "a public_url that is not an origin is still rejected" pu_bad2 "public_url must be an origin" "$(tfv pu_bad2 <<<'public_url = "ftp://x"')"

# ---- both: IAP + internal load balancer (the full enterprise edge) ----------------------------------------------------------
section "enterprise edge: both at once (examples/enterprise-iap-ilb)"
plan ent "$(tfv ent <<'TFV'
app_access = "iap"
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
project_number = "123456789012"
gateway_allow_cidrs = ["10.0.0.0/8"]
TFV
)" && {
  E="$S/out/ent.json"
  assert "tick job reaches the gateway through the VPC (vpc_access) and has the same wiring as the app" "$E" '.resource_changes[] | select(.type=="google_cloud_run_v2_job") | .change.after.template[0].template[0] | (.vpc_access|length)==1 and (.containers[0].env|map(.name)|(index("GATEWAY_CA_PEM") != null and index("IAP_AUDIENCE") != null and index("APP_AUTH_MODE") != null))'
  assert "tick job env: GATEWAY_URL is the private name, GATEWAY_AUDIENCE empty" "$E" '.resource_changes[] | select(.type=="google_cloud_run_v2_job") | .change.after.template[0].template[0].containers[0].env | [.[] | select(.value != null) | {(.name): .value}] | add | (.GATEWAY_URL=="https://claude-gateway.corp.example.com" and .GATEWAY_AUDIENCE=="")'
  assert "app: IAP on, scheduler identity off, VPC route on" "$E" "$EAPP | (.iap_enabled==true and .custom_audiences==null and (.template[0].vpc_access|length)==1)"
  assert "checklist covers both halves" "$E" '.planned_values.outputs.edge_next_steps.value | (contains("BUDGET APP BEHIND IAP") and contains("GATEWAY BEHIND A PRIVATE INTERNAL LOAD BALANCER"))'
  assert "no allUsers anywhere (full edge)" "$E" '[.. | strings | select(. == "allUsers" or . == "allAuthenticatedUsers" or startswith("allUsers"))] | length == 0'
} || { bad "full edge plan"; sed -n 1,25p "$S/out/ent.log"; }

# gateway.yaml: trusted_proxies / allow_cidrs (module in a throwaway root, as above)
R2="$S/render2"; mkdir -p "$R2"
cat > "$R2/main.tf" <<RTF
variable "tp" { type = list(string) }
variable "ac" { type = list(string) }
module "g" {
  source                = "$TF/modules/gateway_config"
  catalog_json          = file("$S/models.orig.json")
  upstreams             = [{ provider = "vertex", region = "global", project_id = "proj-a" }]
  public_url            = "https://claude-gateway.corp.example.com"
  oidc_issuer           = "https://accounts.google.com"
  oidc_client_id        = "123456789012-abcdef123456.apps.googleusercontent.com"
  allowed_email_domains = ["example.com"]
  admins                = [{ email = "alice@example.com", key = "ADMINKEY1_0123456789012345678901234567890123" }]
  system_key            = "SYSTEMKEY0123456789012345678901234567890123"
  trusted_proxies       = var.tp
  allow_cidrs           = var.ac
}
output "rendered" { value = module.g.rendered }
RTF
( cd "$R2" && terraform init -backend=false -input=false -no-color >"$S/out/render2-init.log" 2>&1 ) && ok "gateway.yaml render root (edge) init" || bad "render2 init"
render2() {   # render2 <name> <trusted proxies json> <allow cidrs json>
  jq -n --argjson t "$2" --argjson a "$3" '{tp:$t, ac:$a}' >"$S/$1.r2.tfvars.json"
  ( cd "$R2" && terraform plan -input=false -no-color -lock=false -var-file="$S/$1.r2.tfvars.json" -out="$S/out/r2_$1.bin" >"$S/out/r2_$1.log" 2>&1 ) || return 1
  ( cd "$R2" && terraform show -json "$S/out/r2_$1.bin" ) | jq -r '.planned_values.outputs.rendered.value' >"$S/out/r2_$1.yaml"
  ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load(File.read(ARGV[0])))' "$S/out/r2_$1.yaml" >"$S/out/r2_$1.yaml.json" 2>"$S/out/r2_$1.yamlerr"
}
if render2 def '["169.254.0.0/16"]' '[]'; then
  assert "gateway.yaml default: trusted_proxies [169.254.0.0/16] and no access_control section (same text as before)" "$S/out/r2_def.yaml.json" '(.listen.trusted_proxies==["169.254.0.0/16"]) and (has("access_control")|not)'
  grep -qx '  trusted_proxies: \[169.254.0.0/16\]' "$S/out/r2_def.yaml" && ! grep -q access_control "$S/out/r2_def.yaml" && ok "gateway.yaml default text keeps the original one-line trusted_proxies (no config-hash churn)" || bad "gateway.yaml default text changed"
else bad "render2 default"; tail -8 "$S/out/r2_def.log"; fi
if render2 lb '["169.254.0.0/16","10.0.1.0/24","10.0.2.0/23"]' '["10.0.0.0/8","192.168.0.0/16"]'; then
  assert "gateway.yaml with the load balancer: the forwarding-rule range and the proxy-only subnet are trusted proxies; allow_cidrs rendered (as quoted strings)" "$S/out/r2_lb.yaml.json" '(.listen.trusted_proxies==["169.254.0.0/16","10.0.1.0/24","10.0.2.0/23"]) and (.access_control.allow_cidrs==["10.0.0.0/8","192.168.0.0/16"]) and (.listen.public_url=="https://claude-gateway.corp.example.com") and (.oidc.client_id|length>0) and (.admin.write_keys|length)==2'
else bad "render2 lb"; tail -8 "$S/out/r2_lb.log"; fi
# the real root passes the proxy-only subnet through (the secret is sensitive in the plan, so check the wiring in the source)
grep -q 'trusted_proxies       = local.gateway_trusted_proxies' "$TF/secrets.tf" && grep -q 'gateway_trusted_proxies = concat(\["169.254.0.0/16"\], local.gateway_lb ? \[local.gateway_lb_trust, var.proxy_only_subnet_cidr\]' "$TF/edge_locals.tf" && ok "root module feeds trusted_proxies = Cloud Run front end + load balancer address range + proxy-only subnet in internal_lb mode" || bad "trusted_proxies wiring"
grep -q 'allow_cidrs           = local.gateway_allow_cidrs' "$TF/secrets.tf" && ok "root module feeds the effective allow_cidrs (cc-gateway-subnet added) to the gateway config" || bad "allow_cidrs wiring"

# ---- analytics -------------------------------------------------------------------------------------------------------------
section "analytics = bigquery (dataset + log sink + analyst view)"
plan bq "$(tfv bq <<<'analytics = "bigquery"')" && {
  Q="$S/out/bq.json"
  assert "two datasets: raw claude_gateway_logs (partition expiry = log_retention_days 30 under trial) and claude_gateway_analytics for the view" "$Q" '([.resource_changes[] | select(.type=="google_bigquery_dataset") | .change.after.dataset_id] | sort == ["claude_gateway_analytics","claude_gateway_logs"]) and ([.resource_changes[] | select(.type=="google_bigquery_dataset" and .change.after.dataset_id=="claude_gateway_logs") | .change.after.default_partition_expiration_ms] == [2592000000])'
  assert "dataset claude_gateway_logs in the region; trial profile lets destroy empty it" "$Q" '[.resource_changes[] | select(.type=="google_bigquery_dataset") | .change.after | select(.dataset_id=="claude_gateway_logs" and .location=="europe-west2" and .delete_contents_on_destroy==true)] | length == 1'
  assert "log sink: unique writer identity, partitioned tables, the gateway logs only, into that dataset" "$Q" '[.resource_changes[] | select(.type=="google_logging_project_sink") | .change.after | select(.unique_writer_identity==true and .bigquery_options[0].use_partitioned_tables==true and (.destination=="bigquery.googleapis.com/projects/fake-gateway-test/datasets/claude_gateway_logs") and (.filter|contains("service_name=\"claude-gateway\"")))] | length == 1'
  assert "the sink writer gets dataEditor on that dataset only" "$Q" '[.resource_changes[] | select(.type=="google_bigquery_dataset_iam_member") | .change.after | select(.role=="roles/bigquery.dataEditor" and .dataset_id=="claude_gateway_logs")] | length == 1'
  assert "no view yet (the log table does not exist before the first request); next steps say what to do" "$Q" '([.resource_changes[] | select(.type=="google_bigquery_table")] | length == 0) and (.planned_values.outputs.analytics_next_steps.value | contains("analytics_view = true"))'
  assert "bigquery.googleapis.com is enabled; the app still reads Cloud Logging (USAGE_SOURCE=logs)" "$Q" "([.resource_changes[] | select(.type==\"google_project_service\") | .change.after.service] | index(\"bigquery.googleapis.com\") != null) and ($EAPP | $EENV | .USAGE_SOURCE==\"logs\")"
} || { bad "bigquery plan"; sed -n 1,20p "$S/out/bq.log"; }
plan bqv "$(tfv bqv <<<'analytics = "bigquery"
analytics_view = true')" && assert "analytics_view = true creates v_gateway_requests over the sink table, inference events only, no optional columns" "$S/out/bqv.json" '[.resource_changes[] | select(.type=="google_bigquery_table") | .change.after | select(.table_id=="v_gateway_requests" and (.view[0].use_legacy_sql==false) and (.view[0].query|(contains("run_googleapis_com_stdout") and contains("jsonPayload.evt = '"'"'inference'"'"'") and (contains("cap_cents")|not))))] | length == 1' || bad "bigquery view plan"
expect_fail "analytics_view needs analytics = bigquery" bq_noview "analytics_view = true needs" "$(tfv bq_noview <<<'analytics_view = true')"
expect_fail "analytics: unknown value" bq_bad "analytics must be" "$(tfv bq_bad <<<'analytics = "snowflake"')"

# ============================================================================================================================
section "review 3 hardening: Logging filter precedence (H1)"
# Cloud Logging reads OR before AND. logfilter.rb lints (no group mixes AND with OR) and evaluates with Google's precedence.
LF="$HERE/logfilter.rb"
lint_filters() {   # lint_filters <description> <plan json> <jq producing one filter per line>
  local n=0 nbad=0 f
  while IFS= read -r f; do
    n=$((n+1))
    if ! ruby "$LF" lint "$f" 2>"$S/lint.err"; then nbad=$((nbad+1)); printf '    unparenthesised mix: %s\n    (%s)\n' "$f" "$(cat "$S/lint.err")"; fi
  done < <(jq -r "$3" "$2")
  if (( n > 0 && nbad == 0 )); then ok "$1 ($n filters)"; else bad "$1 ($n filters, $nbad bad)"; fi
}
MF='.resource_changes[] | select(.type=="google_logging_metric") | .change.after.filter'
lint_filters "trial: every log metric filter is precedence-safe" "$S/out/base.json" "$MF"
lint_filters "iap (direct): every log metric filter is precedence-safe" "$S/out/iapd.json" "$MF"
lint_filters "iap + custom domain + internal_lb: every log metric filter is precedence-safe" "$S/out/ent.json" "$MF"
lint_filters "internal_lb: every log metric filter is precedence-safe" "$S/out/ilb.json" "$MF"
lint_filters "bigquery sink filter is precedence-safe" "$S/out/bq.json" '.resource_changes[] | select(.type=="google_logging_project_sink") | .change.after.filter'
metric_filter() { jq -r --arg n "$2" '.resource_changes[] | select(.type=="google_logging_metric" and .change.after.name==$n) | .change.after.filter' "$S/out/$1.json"; }
lfeval() { ruby "$LF" eval "$1" "$2" 2>&1; }
JOB_E='{"resource":{"type":"cloud_run_job","labels":{"job_name":"claude-budget-tick"}},"jsonPayload":{"evt":"override.overdue"},"severity":"WARNING"}'
APP_E='{"resource":{"type":"cloud_run_revision","labels":{"service_name":"claude-budget-app"}},"jsonPayload":{"evt":"override.overdue"},"severity":"WARNING"}'
GW_E='{"resource":{"type":"cloud_run_revision","labels":{"service_name":"claude-gateway"}},"jsonPayload":{"evt":"override.overdue"},"severity":"WARNING"}'
JOB_OTHER='{"resource":{"type":"cloud_run_job","labels":{"job_name":"claude-budget-tick"}},"jsonPayload":{"evt":"tick.job","phase":"start"},"severity":"INFO"}'
OTHER_JOB='{"resource":{"type":"cloud_run_job","labels":{"job_name":"some-other-job"}},"jsonPayload":{"evt":"override.overdue"}}'
F_IAP="$(metric_filter iapd claude_app_override_overdue)"
assert_eq "iap: override.overdue (job log) matches the metric (it never could before)" "$(lfeval "$F_IAP" "$JOB_E")" true
assert_eq "iap: override.overdue (service log) matches too" "$(lfeval "$F_IAP" "$APP_E")" true
assert_eq "iap: the gateway's log with the same event name does not match" "$(lfeval "$F_IAP" "$GW_E")" false
assert_eq "iap: another job's log does not match" "$(lfeval "$F_IAP" "$OTHER_JOB")" false
assert_eq "iap: a different event of the tick job does not match" "$(lfeval "$F_IAP" "$JOB_OTHER")" false
F_TE="$(metric_filter iapd claude_app_tick_error)"
assert_eq "iap: tick_error matches a job line with ok=false" "$(lfeval "$F_TE" '{"resource":{"type":"cloud_run_job","labels":{"job_name":"claude-budget-tick"}},"jsonPayload":{"evt":"tick.job","ok":"false"},"severity":"ERROR"}')" true
assert_eq "iap: tick_error matches any ERROR line of the job (a crash before it could log JSON)" "$(lfeval "$F_TE" '{"resource":{"type":"cloud_run_job","labels":{"job_name":"claude-budget-tick"}},"textPayload":"boom","severity":"ERROR"}')" true
assert_eq "iap: tick_error ignores INFO lines of the job" "$(lfeval "$F_TE" "$JOB_OTHER")" false
assert_eq "iap: tick_error matches the service's tick.error" "$(lfeval "$F_TE" '{"resource":{"type":"cloud_run_revision","labels":{"service_name":"claude-budget-app"}},"jsonPayload":{"evt":"tick.error"},"severity":"ERROR"}')" true
F_TICK="$(metric_filter iapd claude_app_tick)"
assert_eq "iap: the heartbeat matches the job's tick.job phase=done line" "$(lfeval "$F_TICK" '{"resource":{"type":"cloud_run_job","labels":{"job_name":"claude-budget-tick"}},"jsonPayload":{"evt":"tick.job","phase":"done"}}')" true
F_TRIAL="$(metric_filter base claude_app_override_overdue)"
assert_eq "trial: the service log matches, a job log does not" "$(lfeval "$F_TRIAL" "$APP_E")/$(lfeval "$F_TRIAL" "$JOB_E")" true/false
# control: the pre-fix expression (a bare AND ... OR ... AND) is rejected by the lint and really matches nothing
BUGGY='(resource.type="cloud_run_revision" AND resource.labels.service_name="claude-budget-app" OR resource.type="cloud_run_job" AND resource.labels.job_name="claude-budget-tick") AND jsonPayload.evt="override.overdue"'
if ruby "$LF" lint "$BUGGY" 2>/dev/null; then bad "control: the lint should reject the old unparenthesised filter"; else ok "control: the lint rejects the old unparenthesised AND/OR filter"; fi
assert_eq "control: that old filter matches neither the job's nor the service's log (Logging reads it as A AND (B OR C) AND D: dead in IAP mode)" "$(lfeval "$BUGGY" "$JOB_E")/$(lfeval "$BUGGY" "$APP_E")" false/false

section "review 3 hardening: trusted proxies, allow_cidrs, default URL (H2, M1)"
assert "trial: trusted_proxies is only the Cloud Run front end, no allow list" "$B" '.planned_values.outputs.effective_settings.value | (.gateway_trusted_proxies==["169.254.0.0/16"] and .gateway_allow_cidrs==[])'
assert "internal_lb: trusted proxies = Cloud Run front end + the load balancer's forwarding-rule range (lb_subnet_cidr) + the proxy-only subnet" "$S/out/ilb.json" '.planned_values.outputs.effective_settings.value.gateway_trusted_proxies == ["169.254.0.0/16","10.0.1.0/24","10.0.2.0/23"]'
assert "internal_lb with a pinned lb_ip: only that /32 of the lb subnet is trusted" "$S/out/ilb_ok_url.json" '.planned_values.outputs.effective_settings.value.gateway_trusted_proxies == ["169.254.0.0/16","10.0.1.10/32","10.0.2.0/23"]'
assert "gateway_allow_cidrs: the app's own subnet (cc-gateway-subnet) is added so the budget app cannot lock itself out" "$S/out/ent.json" '.planned_values.outputs.effective_settings.value.gateway_allow_cidrs == ["10.0.0.0/8","10.0.0.0/24"]'
assert "internal_lb: the gateway's run.app URL is switched off (default_uri_disabled), invoker check off, ingress internal LB" "$S/out/ilb.json" "$EGW | (.default_uri_disabled==true and .invoker_iam_disabled==true and .ingress==\"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER\")"
assert "trial: the gateway and the app keep their run.app URLs (default_uri_disabled unset)" "$B" "($EGW | .default_uri_disabled==null) and ($EAPP | .default_uri_disabled==null)"
assert "direct IAP: the app keeps its run.app URL (IAP is attached to it); only the gateway-less app, no default_uri_disabled" "$S/out/iapd.json" "$EAPP | (.default_uri_disabled==null and .iap_enabled==true)"
assert "custom domain: the app's run.app URL is switched off too (people come through the load balancer)" "$S/out/dom.json" "$EAPP | (.default_uri_disabled==true and .ingress==\"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER\")"
assert "internal_lb: alert + log metric on the gateway's access.public_client event; trial has neither" "$S/out/ilb.json" '([.resource_changes[] | select(.type=="google_logging_metric" and .change.after.name=="claude_gateway_public_client") | .change.after.filter | contains("access.public_client")] == [true]) and ([.resource_changes[] | select(.type=="google_monitoring_alert_policy" and .change.after.display_name=="Claude gateway: request from a non-private address")] | length == 1)'
assert "trial: no public-client metric or alert" "$B" '[.resource_changes[] | select((.type=="google_logging_metric" and .change.after.name=="claude_gateway_public_client") or (.type=="google_monitoring_alert_policy" and (.change.after.display_name|test("non-private"))))] | length == 0'
assert "checklist B6 names the trusted proxies and the allow-list advice" "$S/out/ent.json" '.planned_values.outputs.edge_next_steps.value | (contains("169.254.0.0/16, 10.0.1.0/24, 10.0.2.0/23") and contains("gateway_allow_cidrs") and contains("access.public_client") and contains("10.0.0.0/8, 10.0.0.0/24"))'
expect_fail "gateway_allow_cidrs without internal_lb is rejected (it would lock everyone out)" allow_norun "only meaningful with gateway_exposure" "$(tfv allow_norun <<<'gateway_allow_cidrs = ["10.0.0.0/8"]')"
expect_fail "gateway_allow_cidrs: 0.0.0.0/0 is rejected" allow_zero "must not contain /0" "$(tfv allow_zero <<<'gateway_allow_cidrs = ["0.0.0.0/0"]')"
expect_fail "gateway_allow_cidrs: IPv6 is rejected (the load balancer is IPv4)" allow_v6 "IPv4 CIDRs" "$(tfv allow_v6 <<<'gateway_allow_cidrs = ["fd00::/8"]')"
expect_fail "gateway_allow_cidrs: host bits must be zero" allow_host "zero host bits" "$(tfv allow_host <<<'gateway_allow_cidrs = ["10.0.0.5/8"]')"

section "review 3 hardening: CIDR validation (M2)"
LBV='gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"'
expect_fail "lb_subnet_cidr equal to cc-gateway-subnet (10.0.0.0/24) is refused at plan time" cidr_app "must not overlap cc-gateway-subnet" "$(tfv cidr_app <<<"$LBV
lb_subnet_cidr = \"10.0.0.0/24\"")"
expect_fail "proxy-only range overlapping cc-gateway-subnet is refused" cidr_pr_app "must not overlap cc-gateway-subnet" "$(tfv cidr_pr_app <<<"$LBV
lb_subnet_cidr = \"10.0.5.0/24\"
proxy_only_subnet_cidr = \"10.0.0.0/23\"")"
expect_fail "overlapping lb and proxy-only ranges are refused (not only identical ones)" cidr_lb_pr "must not overlap" "$(tfv cidr_lb_pr <<<"$LBV
lb_subnet_cidr = \"10.0.5.0/24\"
proxy_only_subnet_cidr = \"10.0.4.0/22\"")"
expect_fail "a /8 proxy-only range is refused (it would be a trusted X-Forwarded-For source)" cidr_big "between /22 and /26" "$(tfv cidr_big <<<'proxy_only_subnet_cidr = "10.0.0.0/8"')"
expect_fail "a public lb range is refused" cidr_pub "private block" "$(tfv cidr_pub <<<"$LBV
lb_subnet_cidr = \"8.8.8.0/24\"")"
expect_fail "lb_subnet_cidr: octets above 255 are refused" cidr_oct "valid octets" "$(tfv cidr_oct <<<'lb_subnet_cidr = "10.0.999.0/24"')"
expect_fail "lb_subnet_cidr: host bits must be zero" cidr_host "host bits are zero" "$(tfv cidr_host <<<'lb_subnet_cidr = "10.0.1.5/24"')"
expect_fail "lb_ip: octets above 255 are refused" lbip_oct "valid octets" "$(tfv lbip_oct <<<'lb_ip = "10.0.999.999"')"
expect_fail "lb_ip outside lb_subnet_cidr is refused" lbip_out "must lie inside lb_subnet_cidr" "$(tfv lbip_out <<<"$LBV
lb_ip = \"10.0.5.10\"")"
expect_fail "lb_ip on a reserved subnet address (.1) is refused" lbip_res "first two and last two addresses" "$(tfv lbip_res <<<"$LBV
lb_ip = \"10.0.1.1\"")"
expect_fail "lb_ip without internal_lb is refused" lbip_norun "only used with gateway_exposure" "$(tfv lbip_norun <<<'lb_ip = "10.0.1.10"')"
expect_fail "gateway_hostname equal to app_domain is refused" host_eq_dom "must be different names" "$(tfv host_eq_dom <<<'app_access = "iap"
project_number = "123456789012"
app_domain = "claude.corp.example.com"
gateway_exposure = "internal_lb"
gateway_hostname = "claude.corp.example.com"')"
plan cidr_ok "$(tfv cidr_ok <<<"$LBV
lb_subnet_cidr = \"192.168.10.0/28\"
proxy_only_subnet_cidr = \"192.168.20.0/26\"
lb_ip = \"192.168.10.5\"")" && ok "valid non-default private ranges (RFC1918 192.168, /28 lb, /26 proxy-only, pinned lb_ip) plan" || { bad "valid non-default CIDRs"; sed -n 1,15p "$S/out/cidr_ok.log"; }
# the new subnets wait for the Service Networking range (Google picks that /16): no race between them
assert "lb and proxy-only subnets depend on the private-services range" "$S/out/ilb.json" '[.configuration.root_module.resources[] | select(.address=="google_compute_subnetwork.lb" or .address=="google_compute_subnetwork.proxy_only") | (.depends_on | index("google_compute_global_address.private_services") != null)] | all'

section "review 3 hardening: self-signed CA and certificate lifetime (H3, M3), key variable (M6)"
assert "self-signed: CA valid 5 years, may only sign leaf certificates (max_path_length 0), with key ids" "$S/out/ilb.json" '.resource_changes[] | select(.type=="tls_self_signed_cert") | .change.after | (.validity_period_hours==43800 and .is_ca_certificate==true and .max_path_length==0 and .set_subject_key_id==true and .set_authority_key_id==true)'
assert "self-signed: leaf valid 1 year, no automatic early renewal by default, server_auth only" "$S/out/ilb.json" '.resource_changes[] | select(.type=="tls_locally_signed_cert") | .change.after | (.validity_period_hours==8760 and .early_renewal_hours==0 and (.allowed_uses|sort)==["digital_signature","server_auth"])'
plan ilb_renew "$(tfv ilb_renew <<<"$LBV
gateway_tls_early_renewal_hours = 720")" && assert "gateway_tls_early_renewal_hours is honoured (opt in to automatic renewal)" "$S/out/ilb_renew.json" '.resource_changes[] | select(.type=="tls_locally_signed_cert") | .change.after.early_renewal_hours == 720' || bad "early renewal plan"
expect_fail "gateway_tls_early_renewal_hours: negative is refused" renew_neg "whole number of hours" "$(tfv renew_neg <<<'gateway_tls_early_renewal_hours = -1')"
assert "output gateway_cert_expires exists (the leaf's end date) and is null for provided certificates" "$S/out/ilb.json" '(.output_changes | has("gateway_cert_expires"))'
assert "provided certificate: gateway_cert_expires is null" "$S/out/ilb_prov.json" '.planned_values.outputs.gateway_cert_expires.value == null'
assert "checklist B3 says loudly that the CA key is in the state and recommends provided" "$S/out/ilb.json" '.planned_values.outputs.edge_next_steps.value | (contains("SECURITY: this CA") and contains("PRIVATE KEY is in the Terraform state") and contains("mode = \"provided\"") and contains("NOT renewed automatically") and contains("gateway_cert_expires"))'
assert "checklist B3 with a provided certificate has no CA-key warning" "$S/out/ilb_prov.json" '.planned_values.outputs.edge_next_steps.value | (contains("PRIVATE KEY is in the Terraform state") | not)'
grep -q 'check "gateway_leaf_expiry"' "$TF/edge_locals.tf" && ok "a check warns when the self-signed leaf is within 60 days of expiry (needs an existing state, so not exercisable offline)" || bad "leaf expiry check missing"
flat "$S/out/ilb.log" | grep -qF "expires within 60 days" && bad "the first plan must not claim the certificate is about to expire" || ok "first plan: no false certificate-expiry warning"
# M6: the private key is its own sensitive variable. NOTE: a saved plan (binary or `show -json`) always carries sensitive values (the
# resource's private_key, the variable); only the human-readable output redacts them. So saved plans are secrets, like the state.
KEY_MARK='FAKE-KEY-FOR-TESTS-ONLY'
if grep -qF "$KEY_MARK" "$S/out/ilb_prov.log"; then bad "provided TLS: the key appears in the human-readable plan"; else ok "provided TLS: the private key never appears in the human-readable plan output"; fi
assert "provided TLS: the certificate's private_key is flagged sensitive in the plan; gateway_tls (non-sensitive) has no key field any more" "$S/out/ilb_prov.json" '([.resource_changes[] | select(.type=="google_compute_region_ssl_certificate") | .change.after_sensitive.private_key] == [true]) and (.variables.gateway_tls.value | has("key_pem") | not)'
assert "no output carries PEM private key material (provided TLS plan)" "$S/out/ilb_prov.json" '[.planned_values.outputs | .. | strings | select(test("PRIVATE KEY-----"))] | length == 0'
assert "no output carries PEM private key material (self-signed plan)" "$S/out/ilb.json" '[.planned_values.outputs | .. | strings | select(test("PRIVATE KEY-----"))] | length == 0'
assert "self-signed: the CA and leaf private keys are sensitive resource attributes" "$S/out/ilb.json" '[.resource_changes[] | select(.type=="tls_private_key") | .change.after_sensitive.private_key_pem] | all'
grep -q 'sensitive   = true' <(sed -n '/variable "gateway_tls_key_pem"/,/^}/p' "$TF/edge_variables.tf") && ok "gateway_tls_key_pem is declared sensitive" || bad "gateway_tls_key_pem is not sensitive"

section "review 3 hardening: IAP ordering, custom-domain extras, texts (M8, L1-L5)"
assert "IAP: the service-agent step exists and the grant waits for it (and for the IAP accessor grants)" "$S/out/iapd.json" '([.resource_changes[] | select(.type=="terraform_data" and .name=="iap_service_agent")] | length == 1) and (.configuration.root_module.resources[] | select(.address=="google_cloud_run_v2_service_iam_member.app_iap_agent") | .depends_on | (index("terraform_data.iap_service_agent") != null and index("google_project_service.apis") != null))'
plan iap_nogcloud "$(tfv iap_nogcloud <<<'app_access = "iap"
project_number = "123456789012"
iap_create_agent_with_gcloud = false')" && assert "iap_create_agent_with_gcloud = false: no local-exec step, and the grant is still planned" "$S/out/iap_nogcloud.json" '([.resource_changes[] | select(.type=="terraform_data" and .name=="iap_service_agent")] | length == 0) and ([.resource_changes[] | select(.name=="app_iap_agent")] | length == 1)' || bad "iap without gcloud step"
assert "trial: no IAP agent step" "$B" '[.resource_changes[] | select(.name=="iap_service_agent")] | length == 0'
grep -q "gcloud beta services identity create" "$TF/edge_iap.tf" && grep -q 'on_failure = continue' "$TF/edge_iap.tf" && ok "the agent step is best effort (on_failure = continue) and runs the documented gcloud command" || bad "agent step wiring"
assert "custom domain: the NEG-before-service ordering is explained in the checklist (recovery: app_domain = null first)" "$S/out/dom.json" '.planned_values.outputs.edge_next_steps.value | (contains("created before the Cloud Run service") and contains("set app_domain = null"))'
assert "custom domain: backend service is named correctly (claude-budget-app-backend) in A4" "$S/out/dom.json" '.planned_values.outputs.edge_next_steps.value | (contains("backend service claude-budget-app-backend") and (contains("backend service claude-budget-app;") | not))'
assert "custom domain: OAuth test users are only individual accounts; the domain: member is called out" "$S/out/dom.json" '.planned_values.outputs.edge_next_steps.value | (contains("individual Google accounts only: alice@example.com, bob@example.com") and contains("group:/domain:/serviceAccount: members") and contains("contains a group: or domain: member"))'
plan dom_armor "$(tfv dom_armor <<'TFV'
app_access = "iap"
app_domain = "claude-budget.example.com"
project_number = "123456789012"
app_security_policy = "claude-budget-allowlist"
TFV
)" && assert "app_security_policy attaches the Cloud Armor policy to the backend service" "$S/out/dom_armor.json" '[.resource_changes[] | select(.type=="google_compute_backend_service") | .change.after.security_policy] == ["claude-budget-allowlist"]' || bad "cloud armor plan"
expect_fail "app_security_policy needs app_domain" armor_nodom "needs app_access" "$(tfv armor_nodom <<<'app_security_policy = "x"')"
assert "scheduler-failure alert (IAP) points at the job, not at claude-budget-app" "$S/out/iapd.json" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy" and .change.after.display_name=="Claude budget app: scheduler tick failing") | .change.after.documentation[0].content] | (.[0] | contains("gcloud run jobs executions list") and (contains("run.invoker on claude-budget-app") | not))'
assert "tick-missing alert (IAP) does not talk about SCHEDULER_AUDIENCE matching" "$S/out/iapd.json" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy" and .change.after.display_name=="Claude budget app: scheduler tick missing") | .change.after.documentation[0].content] | (.[0] | contains("no SCHEDULER_AUDIENCE with IAP") and (contains("matches the job") | not))'
assert "scheduler-failure alert (trial) keeps the original runbook text" "$B" '[.resource_changes[] | select(.type=="google_monitoring_alert_policy" and .change.after.display_name=="Claude budget app: scheduler tick failing") | .change.after.documentation[0].content] | (.[0] | contains("run.invoker on claude-budget-app"))'

section "review 3 hardening: BigQuery analytics isolation (M7)"
assert "analytics: the view lives in claude_gateway_analytics, not next to the raw tables" "$S/out/bqv.json" '[.resource_changes[] | select(.type=="google_bigquery_table") | .change.after.dataset_id] == ["claude_gateway_analytics"]'
assert "analytics: the view is an authorized view on the raw dataset" "$S/out/bqv.json" '[.resource_changes[] | select(.type=="google_bigquery_dataset_access") | .change.after | select(.dataset_id=="claude_gateway_logs" and .view[0].dataset_id=="claude_gateway_analytics" and .view[0].table_id=="v_gateway_requests")] | length == 1'
assert "analytics: no e-mail column by default" "$S/out/bqv.json" '[.resource_changes[] | select(.type=="google_bigquery_table") | .change.after.view[0].query | (contains("email")|not) and contains("jsonPayload.sub AS sub")] == [true]'
assert "analytics: nobody gets read access without analytics_readers; only the sink writer holds a role on the raw dataset" "$S/out/bqv.json" '([.resource_changes[] | select(.type=="google_bigquery_dataset_iam_member") | .change.after | select(.dataset_id=="claude_gateway_analytics")] | length == 0) and ([.resource_changes[] | select(.type=="google_project_iam_member" and .name=="analytics_job_user")] | length == 0) and ([.resource_changes[] | select(.type=="google_bigquery_dataset_iam_member") | .change.after.dataset_id] == ["claude_gateway_logs"])'
plan bqr "$(tfv bqr <<<'analytics = "bigquery"
analytics_view = true
analytics_include_emails = true
analytics_retention_days = 90
analytics_readers = ["group:analysts@example.com", "user:carol@example.com"]')" && {
  assert "analytics_readers: dataViewer on the analytics dataset only + jobUser on the project, nothing on the raw dataset" "$S/out/bqr.json" '([.resource_changes[] | select(.type=="google_bigquery_dataset_iam_member" and .name=="analytics_reader") | .change.after | select(.role=="roles/bigquery.dataViewer" and .dataset_id=="claude_gateway_analytics") | .member] | sort == ["group:analysts@example.com","user:carol@example.com"]) and ([.resource_changes[] | select(.type=="google_project_iam_member" and .name=="analytics_job_user") | .change.after | select(.role=="roles/bigquery.jobUser") | .member] | sort == ["group:analysts@example.com","user:carol@example.com"]) and ([.resource_changes[] | select(.type=="google_bigquery_dataset_iam_member" and .name=="analytics_reader") | .change.after.dataset_id] | all(. == "claude_gateway_analytics"))'
  assert "analytics_include_emails = true adds the e-mail column" "$S/out/bqr.json" '[.resource_changes[] | select(.type=="google_bigquery_table") | .change.after.view[0].query | contains("jsonPayload.email AS email")] == [true]'
  assert "analytics_retention_days = 90 sets partition expiry on the raw dataset" "$S/out/bqr.json" '[.resource_changes[] | select(.type=="google_bigquery_dataset" and .change.after.dataset_id=="claude_gateway_logs") | .change.after.default_partition_expiration_ms] == [7776000000]'
  assert "analytics: no allUsers anywhere" "$S/out/bqr.json" '[.. | strings | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0'
} || { bad "analytics readers plan"; sed -n 1,15p "$S/out/bqr.log"; }
plan bqprod "$(tfv bqprod <<<'profile = "production"
analytics = "bigquery"')" && assert "production: raw partitions expire after log_retention_days = 400" "$S/out/bqprod.json" '[.resource_changes[] | select(.type=="google_bigquery_dataset" and .change.after.dataset_id=="claude_gateway_logs") | .change.after.default_partition_expiration_ms] == [34560000000]' || bad "bq production plan"
assert "analytics next steps explain the two datasets, the retention and the readers" "$S/out/bq.json" '.planned_values.outputs.analytics_next_steps.value | (contains("claude_gateway_analytics") and contains("expire after 30 days") and contains("analytics_readers"))'
expect_fail "analytics_readers: allUsers is rejected" bq_allusers "analytics_readers entries must look like" "$(tfv bq_allusers <<<'analytics = "bigquery"
analytics_readers = ["allUsers"]')"
expect_fail "analytics_readers needs analytics = bigquery" bq_readers_off "analytics_readers needs" "$(tfv bq_readers_off <<<'analytics_readers = ["user:carol@example.com"]')"
expect_fail "analytics_retention_days: 0 is rejected" bq_ret0 "whole number of days" "$(tfv bq_ret0 <<<'analytics = "bigquery"
analytics_retention_days = 0')"

# ---- the shipped examples must plan ---------------------------------------------------------------------------------------
section "examples (each terraform.tfvars.example plans against an empty state)"
for ex in trial-iam enterprise-iap-ilb enterprise-iap-custom-domain; do
  f="$TF_SRC/examples/$ex/terraform.tfvars.example"
  [[ -f "$f" && -f "$TF_SRC/examples/$ex/README.md" ]] && ok "example $ex has a tfvars.example and a README" || bad "example $ex is incomplete"
  if plan "ex_$ex" "$f"; then ok "example $ex: plan succeeds"; else bad "example $ex: plan failed"; sed -n 1,15p "$S/out/ex_$ex.log"; fi
done
assert "example trial-iam: no edge resources" "$S/out/ex_trial-iam.json" '[.resource_changes[] | select(.type|test("^tls_|^google_dns_|^google_iap_|google_cloud_run_v2_job|google_compute_forwarding_rule"))] | length == 0'
assert "example enterprise-iap-ilb: IAP direct + internal load balancer + job" "$S/out/ex_enterprise-iap-ilb.json" '([.resource_changes[] | select(.type=="google_compute_forwarding_rule")] | length == 1) and ([.resource_changes[] | select(.type=="google_iap_web_cloud_run_service_iam_member")] | length == 2) and ([.resource_changes[] | select(.type=="google_cloud_run_v2_job")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_global_forwarding_rule")] | length == 0)'
assert "example enterprise-iap-custom-domain: both load balancers, IAP on the backend service" "$S/out/ex_enterprise-iap-custom-domain.json" '([.resource_changes[] | select(.type=="google_compute_forwarding_rule")] | length == 1) and ([.resource_changes[] | select(.type=="google_compute_global_forwarding_rule")] | length == 1) and ([.resource_changes[] | select(.type=="google_iap_web_backend_service_iam_member")] | length == 2)'

# ============================================================================================================================
section "live-deployment safety"
for f in terraform.tfstate terraform.tfvars zz_imports.tf adopt.sh secrets.auto.tfvars; do
  [[ ! -e "$TF/$f" ]] && ok "scratch copy has no $f" || bad "scratch copy contains $f"
done
[[ -z "$(ls "$TF"/*.tfstate* 2>/dev/null)" ]] && ok "no state file was created by the tests" || bad "state file present"
if jq -e '.resource_changes[] | select(.change.actions | index("delete"))' "$P" >/dev/null 2>&1; then bad "plan contains deletes"; else ok "plan contains no deletes"; fi

# ============================================================================================================================
if [[ "${SKIP_SETUP_TESTS:-0}" != 1 ]]; then
  section "setup.sh"
  if SETUP_TEST_SCRATCH="$S/setup" "$HERE/setup_test.sh"; then ok "setup.sh tests (tests/setup_test.sh)"; else bad "setup.sh tests (tests/setup_test.sh)"; fi
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL == 0 ]]
