# Budget app: the Node backend plus the exported React Native Web bundle.
# Build from the repo root: docker build -f deploy/gcp/Dockerfile.app .   (needs app/dist: cd app && npx expo export -p web)
FROM node:22-slim
WORKDIR /srv
COPY api/server.mjs api/server.mjs
COPY app/dist app/dist
ENV NODE_ENV=production APP_HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "api/server.mjs"]
