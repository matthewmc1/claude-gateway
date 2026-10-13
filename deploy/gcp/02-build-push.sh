#!/usr/bin/env bash
# Build both images for linux/amd64 and push them to Artifact Registry. Needs 01-infra.sh first.
set -euo pipefail
cd "$(dirname "$0")"; source env.sh
BASE=https://downloads.claude.ai/claude-code-releases
mkdir -p build; cd build

# 1. Pinned gateway binary, verified against the GPG-signed manifest (same steps as the Claude Code docs).
if [[ ! -x claude-linux-x64 ]]; then
  export GNUPGHOME="$(mktemp -d)"; chmod 700 "$GNUPGHOME"; trap 'rm -rf "$GNUPGHOME"' EXIT
  curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o claude-code.asc
  gpg --import claude-code.asc >/dev/null 2>&1
  gpg --fingerprint security@anthropic.com | grep -q "31DD DE24 DDFA B679 F42D  7BD2 BAA9 29FF 1A7E CACE" || { echo "signing key fingerprint mismatch"; exit 1; }
  curl -fsSLO "$BASE/$IMAGE_TAG/manifest.json"; curl -fsSLO "$BASE/$IMAGE_TAG/manifest.json.sig"
  gpg --verify manifest.json.sig manifest.json 2>&1 | grep -q "Good signature"
  curl -fsSL "$BASE/$IMAGE_TAG/linux-x64/claude" -o claude-linux-x64
  [[ "$(jq -r '.platforms["linux-x64"].checksum' manifest.json)" == "$(shasum -a 256 claude-linux-x64 | cut -d' ' -f1)" ]] || { echo "checksum mismatch"; exit 1; }
  chmod +x claude-linux-x64
fi
cd ..

# 2. App bundle.
( cd ../../app && npm install --no-audit --no-fund >/dev/null && npx expo export -p web >/dev/null )

# 3. Images. Cloud Run needs linux/amd64; --provenance=false avoids an OCI index it rejects.
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker buildx build --platform=linux/amd64 --provenance=false -f Dockerfile.gateway -t "${REGISTRY}/gateway:${IMAGE_TAG}" --push .
APP_TAG="$(date +%Y%m%d%H%M%S)"; echo "$APP_TAG" > build/app-tag
docker buildx build --platform=linux/amd64 --provenance=false -f Dockerfile.app -t "${REGISTRY}/budget-app:${APP_TAG}" -t "${REGISTRY}/budget-app:latest" --push ../..
echo "images pushed to ${REGISTRY}"
