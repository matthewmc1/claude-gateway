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
cp "$BASE/config/models.json" "$S/models.orig.json"

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
assert "MODELS_JSON passes the catalog (3 models, default sonnet)" "$P" '.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | [.change.after.template[0].containers[0].env[] | select(.name=="MODELS_JSON") | .value][0] | fromjson | (.default=="sonnet" and (.models|length)==3)'
assert "the system key and read key are secret-backed (no plaintext env)" "$P" '.resource_changes[] | select(.type=="google_cloud_run_v2_service" and .name=="app") | [.change.after.template[0].containers[0].env[] | select(.name=="GATEWAY_SYSTEM_WRITE_KEY" or .name=="GATEWAY_ADMIN_READ_KEY") | (.value == null or .value == "")] | all'
assert "log retention is not managed by default (project-wide bucket untouched)" "$P" '[.resource_changes[] | select(.type=="google_logging_project_bucket_config")] | length == 0'
assert "outputs: client_defaults, oidc_redirect_uri, oidc_setup_steps, proxy_command, client_install_hint, admin_credentials exist" "$P" '.output_changes | (has("client_defaults") and has("oidc_redirect_uri") and has("oidc_setup_steps") and has("oidc_console_url") and has("oidc_consent_screen_url") and has("proxy_command") and has("client_install_hint") and has("admin_credentials"))'
assert "oidc_redirect_uri = public_url + /oauth/callback" "$P" '.planned_values.outputs.oidc_redirect_uri.value == "http://localhost:8891/oauth/callback"'
assert "client_defaults carries gateway url, default model and effort" "$P" '.planned_values.outputs.client_defaults.value | fromjson | (.gatewayUrl=="http://localhost:8891" and .defaultModel=="claude-sonnet-5-5" and .effort=="medium")'
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
client_default_effort = "high"')" && assert "write_client_defaults=true plans ../client/defaults.json" "$S/out/cd.json" '[.resource_changes[] | select(.type=="local_file" and (.change.after.filename|endswith("/client/defaults.json")) and (.change.after.content|fromjson|.effort=="high"))] | length == 1' || bad "client defaults plan"
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
expect_fail "unknown default alias in models.json is rejected" unk_default "must be the alias of a model in the list"
jq '.models[1].id = .models[0].id' "$S/models.orig.json" >"$S/m_dup.json"
setmodels "$S/m_dup.json"
expect_fail "duplicate model ids are rejected" dup_ids "model ids must be unique"
jq '(.models[] | select(.alias=="sonnet") | .enabled) = false' "$S/models.orig.json" >"$S/m_disabled_default.json"
setmodels "$S/m_disabled_default.json"
expect_fail "a disabled default model is rejected" dis_default "must have \"enabled\": true"
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
  assert "alert '$nm': metric $met, fires at ${thr}+1 events, window ${per}s, severity $sev" "$P" "[$ALERT | select(.display_name | endswith(\"$nm\")) | {c: .conditions[0].condition_threshold[0], s: .severity}] | (length==1 and .[0].c.filter==\"metric.type=\\\"logging.googleapis.com/user/$met\\\"\" and .[0].c.threshold_value==$thr and .[0].c.aggregations[0].alignment_period==\"${per}s\" and .[0].s==\"$sev\")"
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
SON=claude-sonnet-5-5; OPU=claude-opus-5-5; HAI=claude-haiku-5-5

if render a1 "$S/models.orig.json" "$UP1" "$ADM1"; then
  ok "render 1 admin / 1 upstream: valid YAML"
  assert "1 admin: write keys = alice + system:overrides, keys present" "$(Y a1)" ".admin.write_keys | (map(.id) == [\"alice@example.com\",\"system:overrides\"]) and (.[0].key==\"$K1\") and (.[1].key|length >= 32)"
  assert "1 upstream: vertex at proj-a" "$(Y a1)" '.upstreams | (length==1 and .[0].provider=="vertex" and .[0].project_id=="proj-a" and .[0].region=="global" and .[0].auth=={})'
  assert "availableModels: default first, all three" "$(Y a1)" ".managed.policies[0].code | (.availableModels==[\"$SON\",\"$OPU\",\"$HAI\"] and .enforceAvailableModels==true)"
  assert "env pins for sonnet/opus/haiku aliases" "$(Y a1)" ".managed.policies[0].code.env | (.ANTHROPIC_DEFAULT_SONNET_MODEL==\"$SON\" and .ANTHROPIC_DEFAULT_OPUS_MODEL==\"$OPU\" and .ANTHROPIC_DEFAULT_HAIKU_MODEL==\"$HAI\")"
  assert "secrets stay as \${VAR} references (JWT, OIDC secret, Postgres, read key)" "$(Y a1)" '(.session.jwt_secret=="${GATEWAY_JWT_SECRET}" and .oidc.client_secret=="${OIDC_CLIENT_SECRET}" and .store.postgres_url=="${GATEWAY_POSTGRES_URL}" and .admin.read_keys[0].key=="${GATEWAY_ADMIN_READ_KEY}")'
  assert "oidc: issuer, client id, allowed domains" "$(Y a1)" '.oidc | (.issuer=="https://accounts.google.com" and .allowed_email_domains==["example.com","corp.example.org"] and (.extra_auth_params=={}))'
else bad "render a1"; tail -12 "$S/out/r_a1.log"; fi

if render a3 "$S/models.orig.json" "$UP2" "$ADM3" '{"access_type":"offline","prompt":"consent","hd":"example.com"}'; then
  ok "render 3 admins / 2 upstreams: valid YAML"
  assert "3 admins: all personal keys plus system:overrides" "$(Y a3)" ".admin.write_keys | (map(.id) == [\"alice@example.com\",\"bob@example.com\",\"carol@example.com\",\"system:overrides\"]) and (map(.key)[0:3] == [\"$K1\",\"$K2\",\"$K3\"])"
  assert "2 upstreams, second in us-east5 / proj-b" "$(Y a3)" '.upstreams | (length==2 and .[1].region=="us-east5" and .[1].project_id=="proj-b" and .[1].provider=="vertex")'
  assert "extra auth params (access_type, prompt, hd) rendered" "$(Y a3)" '.oidc.extra_auth_params == {"access_type":"offline","prompt":"consent","hd":"example.com"}'
else bad "render a3"; tail -12 "$S/out/r_a3.log"; fi

# models disabled / default switched / 4th model
jq '(.models[] | select(.alias=="opus") | .enabled) = false' "$S/models.orig.json" >"$S/m_noopus.json"
if render nopus "$S/m_noopus.json" "$UP1" "$ADM1"; then
  assert "disabled model leaves availableModels and the env pins" "$(Y nopus)" ".managed.policies[0].code | (.availableModels==[\"$SON\",\"$HAI\"] and (.env|has(\"ANTHROPIC_DEFAULT_OPUS_MODEL\")|not) and .env.ANTHROPIC_DEFAULT_SONNET_MODEL==\"$SON\")"
else bad "render nopus"; tail -8 "$S/out/r_nopus.log"; fi
jq '.default = "haiku"' "$S/models.orig.json" >"$S/m_haiku.json"
if render haiku "$S/m_haiku.json" "$UP1" "$ADM1"; then
  assert "default alias moves its model to the front of availableModels" "$(Y haiku)" ".managed.policies[0].code.availableModels == [\"$HAI\",\"$SON\",\"$OPU\"]"
else bad "render haiku"; tail -8 "$S/out/r_haiku.log"; fi
jq '.models += [{"alias":"custom","id":"claude-test-9-9","label":"Test 9.9","tier":"fast","description":"x","enabled":true}]' "$S/models.orig.json" >"$S/m_four.json"
if render four "$S/m_four.json" "$UP1" "$ADM1"; then
  assert "a 4th model appears in availableModels (and changes the rendered config)" "$(Y four)" ".managed.policies[0].code.availableModels == [\"$SON\",\"$OPU\",\"$HAI\",\"claude-test-9-9\"]"
  assert "a non-Claude-Code alias adds no env pin" "$(Y four)" '.managed.policies[0].code.env | keys == ["ANTHROPIC_DEFAULT_HAIKU_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL"]'
  if ! diff -q "$S/out/r_a1.yaml" "$S/out/r_four.yaml" >/dev/null; then ok "rendered config differs from the 3-model one"; else bad "rendered config did not change"; fi
else bad "render four"; tail -8 "$S/out/r_four.log"; fi
jq '.models += [{"alias":"sonnet","id":"claude-other","enabled":true}]' "$S/models.orig.json" >"$S/m_dupalias.json"
if render dupalias "$S/m_dupalias.json" "$UP1" "$ADM1"; then bad "duplicate alias should fail"; else flat "$S/out/r_dupalias.log" | grep -qF "aliases must be unique" && ok "duplicate alias is rejected with a message" || { bad "duplicate alias message"; tail -8 "$S/out/r_dupalias.log"; }; fi
if render short "$S/models.orig.json" "$UP1" '[{"email":"alice@example.com","key":"tooshort"}]'; then bad "short admin key should fail"; else flat "$S/out/r_short.log" | grep -qF "at least 32 characters" && ok "admin key shorter than 32 characters is rejected" || bad "short key message"; fi

# the repository's real catalog drives the real configuration
assert "real models.json: root plan's availableModels equals the catalog's enabled ids, default first" "$P" ".planned_values.outputs.effective_settings.value.enabled_models == [$(jq -r '[.default as $d | (.models | map(select(.enabled)) | (map(select(.alias==$d)) + map(select(.alias!=$d))) | .[].id)] | map("\"" + . + "\"") | join(",")' "$REPO/config/models.json")]"

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
