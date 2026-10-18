# Budget app: the Node backend (no dependencies), the model catalog and the exported React Native Web bundle.
# Build from the repo root:  docker buildx build --platform=linux/amd64 -f deploy/Dockerfile.app .
# Needs app/dist first:      (cd app && npm ci && npx expo export -p web)
# deploy/build-push.sh does both. Context is filtered by deploy/Dockerfile.app.dockerignore.
# Pinned by digest (multi-arch index of node:22-slim, resolved with `docker buildx imagetools inspect node:22-slim`).
# Dependabot (docker ecosystem, /deploy) proposes updates; to refresh by hand, re-run the inspect command and paste the digest.
FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
WORKDIR /srv
COPY api/server.mjs api/server.mjs
# The same image runs the tick job (Cloud Run job `claude-budget-tick`, command: node api/tick.mjs) when the app sits behind IAP.
COPY api/tick.mjs api/tick.mjs
COPY api/lib api/lib
COPY config/models.json config/models.json
COPY app/dist app/dist
# APP_HOST=0.0.0.0 is accepted only on Cloud Run (K_SERVICE is set there); anywhere else the app refuses to start unless
# APP_ALLOW_NON_LOOPBACK=1. The only writable path is /tmp (used when no APP_STATE_BUCKET is set).
ENV NODE_ENV=production APP_HOST=0.0.0.0 PORT=8080 APP_DATA_DIR=/tmp/app-data
USER node
EXPOSE 8080
CMD ["node", "api/server.mjs"]
