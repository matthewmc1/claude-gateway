#!/usr/bin/env bash
# Create Secret Manager secrets and render gateway.yaml. Idempotent: existing secrets keep their value unless you pass --rotate-config.
# Set OIDC_CLIENT_ID and export OIDC_CLIENT_SECRET (from the Google console) before running for real sign-in.
set -euo pipefail
cd "$(dirname "$0")"; source env.sh

put() {   # put <name> <value>   (adds a new version only when the secret is new or force=1)
  local name="$1" val="$2" force="${3:-0}"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then gcloud secrets create "$name" --replication-policy=automatic >/dev/null; force=1; fi
  [[ "$force" == 1 ]] && printf '%s' "$val" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  return 0
}
rand() { openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40; }

put claude-gateway-jwt-secret "$(openssl rand -base64 32)"
put claude-gateway-admin-write-key "$(rand)$(rand)"
put claude-gateway-admin-read-key "$(rand)$(rand)"
put claude-budget-app-password "$(rand)"
put claude-budget-app-session-secret "$(openssl rand -base64 32)"
# Google OAuth client secret: a placeholder until you provide the real one; set OIDC_CLIENT_SECRET to replace it.
put claude-gateway-oidc-client-secret "${OIDC_CLIENT_SECRET:-placeholder-set-me}" "$([[ -n "${OIDC_CLIENT_SECRET:-}" ]] && echo 1 || echo 0)"

export PUBLIC_URL="${PUBLIC_URL:-http://localhost:${GATEWAY_LOCAL_PORT}}"
envsubst '${PUBLIC_URL} ${OIDC_CLIENT_ID} ${ALLOWED_EMAIL_DOMAIN} ${VERTEX_REGION} ${PROJECT_ID}' < gateway.yaml.tmpl > build/gateway.yaml
put claude-gateway-config "$(cat build/gateway.yaml)" 1

# Per-secret access via the REST API (works around gcloud installs where `gcloud secrets add-iam-policy-binding` crashes).
bind_secret() {   # bind_secret <secret> <service-account-email>
  local base="https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/$1" tok pol
  tok="$(gcloud auth print-access-token)"
  pol="$(curl -fsS -H "Authorization: Bearer $tok" -H "x-goog-user-project: ${PROJECT_ID}" "$base:getIamPolicy")"
  pol="$(MEMBER="serviceAccount:$2" python3 -c '
import json,os,sys
p=json.load(sys.stdin); m=os.environ["MEMBER"]; r="roles/secretmanager.secretAccessor"
b=next((x for x in p.get("bindings",[]) if x["role"]==r),None)
if b is None: p.setdefault("bindings",[]).append({"role":r,"members":[m]})
elif m not in b["members"]: b["members"].append(m)
print(json.dumps({"policy":p}))' <<<"$pol")"
  curl -fsS -X POST -H "Authorization: Bearer $tok" -H "x-goog-user-project: ${PROJECT_ID}" -H "Content-Type: application/json" -d "$pol" "$base:setIamPolicy" >/dev/null
}
for s in claude-gateway-config claude-gateway-jwt-secret claude-gateway-oidc-client-secret claude-gateway-postgres-url claude-gateway-admin-write-key claude-gateway-admin-read-key; do bind_secret "$s" "$GW_SA"; done
for s in claude-gateway-admin-write-key claude-gateway-admin-read-key claude-budget-app-password claude-budget-app-session-secret; do bind_secret "$s" "$APP_SA"; done
echo "secrets ready (public_url=${PUBLIC_URL}, client_id=${OIDC_CLIENT_ID})"
