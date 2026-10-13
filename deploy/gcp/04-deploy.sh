#!/usr/bin/env bash
# Deploy the gateway and the budget app to Cloud Run. Both stay private: Google IAM guards them (no allUsers),
# and you reach them with `gcloud run services proxy` (05-proxy.sh), which gives Claude Code a localhost address.
set -euo pipefail
cd "$(dirname "$0")"; source env.sh

gcloud run deploy claude-gateway \
  --image="${REGISTRY}/gateway:${IMAGE_TAG}" --region="$REGION" --service-account="$GW_SA" \
  --min-instances=1 --max-instances=2 --timeout=3600 --port=8080 \
  --set-env-vars="DEPLOY_NONCE=$(date +%s)" \
  --ingress=all --no-allow-unauthenticated \
  --network="$VPC" --subnet="$SUBNET" --vpc-egress=private-ranges-only \
  --set-secrets="/etc/claude/gateway.yaml=claude-gateway-config:latest,GATEWAY_JWT_SECRET=claude-gateway-jwt-secret:latest,OIDC_CLIENT_SECRET=claude-gateway-oidc-client-secret:latest,GATEWAY_POSTGRES_URL=claude-gateway-postgres-url:latest,GATEWAY_ADMIN_WRITE_KEY=claude-gateway-admin-write-key:latest,GATEWAY_ADMIN_READ_KEY=claude-gateway-admin-read-key:latest"

GW_URL="$(gcloud run services describe claude-gateway --region="$REGION" --format='value(status.url)')"
gcloud run services add-iam-policy-binding claude-gateway --region="$REGION" --member="serviceAccount:${APP_SA}" --role=roles/run.invoker >/dev/null

APP_IMAGE="${REGISTRY}/budget-app:$(cat build/app-tag 2>/dev/null || echo latest)"   # unique tag per build so Cloud Run rolls a new revision
gcloud run deploy claude-budget-app \
  --image="$APP_IMAGE" --region="$REGION" --service-account="$APP_SA" \
  --min-instances=0 --max-instances=1 --port=8080 \
  --ingress=all --no-allow-unauthenticated \
  --set-env-vars="GATEWAY_URL=${GW_URL},GATEWAY_AUDIENCE=${GW_URL},APP_ALLOWED_ORIGINS=http://localhost:${APP_LOCAL_PORT}" \
  --set-secrets="GATEWAY_ADMIN_WRITE_KEY=claude-gateway-admin-write-key:latest,GATEWAY_ADMIN_READ_KEY=claude-gateway-admin-read-key:latest,APP_ADMIN_PASSWORD=claude-budget-app-password:latest,APP_SESSION_SECRET=claude-budget-app-session-secret:latest"
# The app's own host name is only known after the first deploy; set it now so the host guard accepts proxied requests.
APP_URL="$(gcloud run services describe claude-budget-app --region="$REGION" --format='value(status.url)')"
gcloud run services update claude-budget-app --region="$REGION" --update-env-vars="APP_ALLOWED_HOSTS=${APP_URL#https://}" >/dev/null
echo "gateway: $GW_URL"; echo "app:     $APP_URL"
