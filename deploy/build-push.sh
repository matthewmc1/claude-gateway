#!/usr/bin/env bash
# Build the gateway and budget-app images for linux/amd64 and push them to Artifact Registry.
#
#   PROJECT_ID=my-project REGION=europe-west2 deploy/build-push.sh
#
#   PROJECT_ID    required (unless LOCAL_ONLY=1)
#   REGION        Artifact Registry region, same as Terraform's `region`        (default europe-west2)
#   IMAGE_TAG     Claude Code release the gateway runs, e.g. 2.1.296             (default 2.1.296)
#                 Terraform's gateway_image_tag must match.
#   APP_TAG       tag for the budget-app image                                    (default: UTC timestamp; must be a timestamp of 8+ digits,
#                 a 7-40 hex git sha or semver-with-build-suffix, see deploy/lib/app-tag.sh; no :latest is pushed)
#   SKIP_APP_BUILD=1   reuse an existing app/dist instead of running `expo export`
#   LOCAL_ONLY=1       build into the local Docker daemon, push nothing, skip gcloud
#
# The gateway binary is downloaded from downloads.claude.ai and verified exactly as the Claude Code docs describe:
# the manifest's GPG signature must be made by the key whose PRIMARY fingerprint is the pinned one (deploy/lib/verify-release.sh;
# other keys in the downloaded key file are ignored), then the binary's SHA-256 is checked against the signed manifest. A cached binary is re-verified on every run.
# Needs: docker (buildx), curl, gpg, jq, node/npm (unless SKIP_APP_BUILD=1), gcloud (unless LOCAL_ONLY=1).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LOCAL_ONLY="${LOCAL_ONLY:-0}"
REGION="${REGION:-europe-west2}"
IMAGE_TAG="${IMAGE_TAG:-2.1.296}"
APP_TAG="${APP_TAG:-$(date -u +%Y%m%d%H%M%S)}"
if [[ "$LOCAL_ONLY" == 1 ]]; then PROJECT_ID="${PROJECT_ID:-local}"; else : "${PROJECT_ID:?set PROJECT_ID (your Google Cloud project id)}"; fi
REGISTRY="${REGISTRY:-${REGION}-docker.pkg.dev/${PROJECT_ID}/claude-gateway}"
# shellcheck source=lib/app-tag.sh
. "$HERE/lib/app-tag.sh"
app_tag_ok "$APP_TAG" || { echo "APP_TAG '$APP_TAG' is not an accepted build tag (8+ digit timestamp, 7-40 hex git sha, or semver with a build suffix; never latest/main/dev...): terraform's app_image_tag would refuse it" >&2; exit 1; }
[[ "$IMAGE_TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "IMAGE_TAG must be a release like 2.1.296" >&2; exit 1; }

BASE=https://downloads.claude.ai/claude-code-releases
FINGERPRINT="31DD DE24 DDFA B679 F42D  7BD2 BAA9 29FF 1A7E CACE"
BIN="$HERE/build/claude-${IMAGE_TAG}-linux-x64"
mkdir -p "$HERE/build"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# 1. Pinned gateway binary, verified against the GPG-signed manifest. The trust anchor is the pinned PRIMARY fingerprint:
#    deploy/lib/verify-release.sh imports only the key with that fingerprint and requires gpg's VALIDSIG to name it.
echo "== gateway binary ${IMAGE_TAG}"
# shellcheck source=lib/verify-release.sh
. "$HERE/lib/verify-release.sh"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
vr_curl https://downloads.claude.ai/keys/claude-code.asc -o "$WORK/claude-code.asc"
vr_curl "$BASE/$IMAGE_TAG/manifest.json" -o "$WORK/manifest.json"
vr_curl "$BASE/$IMAGE_TAG/manifest.json.sig" -o "$WORK/manifest.json.sig"
verify_release_manifest "$WORK/claude-code.asc" "$WORK/manifest.json" "$WORK/manifest.json.sig" "$FINGERPRINT" "$IMAGE_TAG" || { echo "manifest signature check failed: refusing to build" >&2; exit 1; }
WANT="$(release_checksum "$WORK/manifest.json" linux-x64)" || exit 1
if [[ ! -f "$BIN" || "$(sha256 "$BIN")" != "$WANT" ]]; then
  vr_curl "$BASE/$IMAGE_TAG/linux-x64/claude" -o "$BIN.part"
  [[ "$(sha256 "$BIN.part")" == "$WANT" ]] || { rm -f "$BIN.part"; echo "checksum mismatch" >&2; exit 1; }
  mv "$BIN.part" "$BIN"
fi
chmod +x "$BIN"
echo "verified sha256 ${WANT}"

# 2. Budget-app bundle.
if [[ "${SKIP_APP_BUILD:-0}" != 1 ]]; then
  echo "== app bundle"
  ( cd "$ROOT/app" && npm ci --no-audit --no-fund >/dev/null && npx expo export -p web >/dev/null )
fi
[[ -f "$ROOT/app/dist/index.html" ]] || { echo "app/dist is missing: run without SKIP_APP_BUILD, or: cd app && npx expo export -p web" >&2; exit 1; }

# 3. Images. Cloud Run needs linux/amd64; --provenance=false avoids an OCI index it rejects.
if [[ "$LOCAL_ONLY" == 1 ]]; then OUT=(--load); else OUT=(--push); gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet; fi
echo "== gateway image"
docker buildx build --platform=linux/amd64 --provenance=false "${OUT[@]}" \
  --build-arg "CLAUDE_VERSION=${IMAGE_TAG}" -f "$HERE/Dockerfile.gateway" -t "${REGISTRY}/gateway:${IMAGE_TAG}" "$HERE"
echo "== budget-app image"
docker buildx build --platform=linux/amd64 --provenance=false "${OUT[@]}" \
  -f "$HERE/Dockerfile.app" -t "${REGISTRY}/budget-app:${APP_TAG}" "$ROOT"

echo
if [[ "$LOCAL_ONLY" == 1 ]]; then echo "built locally (not pushed):"; else echo "pushed:"; fi
echo "  ${REGISTRY}/gateway:${IMAGE_TAG}"
echo "  ${REGISTRY}/budget-app:${APP_TAG}"
echo
echo "Next: set gateway_image_tag = \"${IMAGE_TAG}\" and app_image_tag = \"${APP_TAG}\" in terraform.tfvars, then terraform apply."
