#!/usr/bin/env bash
# Network, service accounts, Artifact Registry and Cloud SQL (private IP only). Idempotent.
# Creates NEW resources only (names are prefixed claude-gateway / cc-gateway); it does not touch the
# prism-* or wedding-* services, secrets or databases already in the project.
# Cost: Cloud SQL db-f1-micro is roughly $10 a month; Cloud Run min-instances=1 for the gateway is a few dollars.
set -euo pipefail
cd "$(dirname "$0")"; source env.sh
gcloud config set project "$PROJECT_ID" >/dev/null

echo "== APIs"
gcloud services enable aiplatform.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com iam.googleapis.com compute.googleapis.com \
  servicenetworking.googleapis.com run.googleapis.com logging.googleapis.com

echo "== Service accounts"
gcloud iam service-accounts describe "$GW_SA" >/dev/null 2>&1 || gcloud iam service-accounts create claude-gateway --display-name="Claude apps gateway"
gcloud iam service-accounts describe "$APP_SA" >/dev/null 2>&1 || gcloud iam service-accounts create claude-budget-app --display-name="Claude gateway budget app"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${GW_SA}" --role=roles/aiplatform.user --condition=None >/dev/null

echo "== Artifact Registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --description="Claude apps gateway images"

echo "== VPC (own network, separate from prism-vpc)"
gcloud compute networks describe "$VPC" >/dev/null 2>&1 || gcloud compute networks create "$VPC" --subnet-mode=custom
gcloud compute networks subnets describe "$SUBNET" --region="$REGION" >/dev/null 2>&1 || \
  gcloud compute networks subnets create "$SUBNET" --network="$VPC" --region="$REGION" --range=10.0.0.0/24
gcloud compute addresses describe "google-managed-services-${VPC}" --global >/dev/null 2>&1 || \
  gcloud compute addresses create "google-managed-services-${VPC}" --global --purpose=VPC_PEERING --prefix-length=16 --network="$VPC"
gcloud services vpc-peerings list --network="$VPC" 2>/dev/null | grep -q servicenetworking || \
  gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges="google-managed-services-${VPC}" --network="$VPC"

echo "== Cloud SQL (private IP only; takes 10-15 minutes)"
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro \
    --region="$REGION" --network="projects/${PROJECT_ID}/global/networks/${VPC}" --no-assign-ip
fi
gcloud sql databases describe claude_gateway --instance="$SQL_INSTANCE" >/dev/null 2>&1 || gcloud sql databases create claude_gateway --instance="$SQL_INSTANCE"

echo "== DB user + connection-string secret"
if ! gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx gateway; then
  PGPASS="$(openssl rand -hex 24)"
  gcloud sql users create gateway --instance="$SQL_INSTANCE" --password="$PGPASS"
  PRIVATE_IP="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses[0].ipAddress)')"
  gcloud secrets describe claude-gateway-postgres-url >/dev/null 2>&1 || gcloud secrets create claude-gateway-postgres-url --replication-policy=automatic
  printf '%s' "postgres://gateway:${PGPASS}@${PRIVATE_IP}:5432/claude_gateway?sslmode=require" | gcloud secrets versions add claude-gateway-postgres-url --data-file=-
fi
echo "infra done"
