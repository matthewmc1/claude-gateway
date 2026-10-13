# Shared settings for the Cloud Run deployment. Source this, never run it.
export PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
: "${PROJECT_ID:?set PROJECT_ID or run: gcloud config set project <id>}"
export REGION="${REGION:-europe-west2}"            # Cloud Run, Cloud SQL and the registry live here
export VERTEX_REGION="${VERTEX_REGION:-global}"    # Claude models are served from "global" on Vertex AI
export VPC=cc-gateway-vpc
export SUBNET=cc-gateway-subnet
export SQL_INSTANCE=claude-gateway-db
export GW_SA="claude-gateway@${PROJECT_ID}.iam.gserviceaccount.com"
export APP_SA="claude-budget-app@${PROJECT_ID}.iam.gserviceaccount.com"
export REPO=claude-gateway
export REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
export IMAGE_TAG="${IMAGE_TAG:-2.1.296}"           # the pinned Claude Code release the gateway runs
export GATEWAY_LOCAL_PORT=8891                     # localhost ports used with `gcloud run services proxy`
export APP_LOCAL_PORT=8892
# Sign-in: Google OAuth "Web application" client you create in the console (see README.md)
export OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com}"
export ALLOWED_EMAIL_DOMAIN="${ALLOWED_EMAIL_DOMAIN:-example.com}"   # only these email domains may sign in; set yours
