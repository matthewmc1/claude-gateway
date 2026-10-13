# Claude gateway: project notes

Central Claude Code access for a team: Anthropic's own `claude gateway` (OIDC sign-in, per-person budgets, Vertex AI) plus a
budget/usage app for admins. Goals: one place to see and limit usage, and a good experience for engineers.

## Layout
- `terraform/` GCP provisioning (Cloud Run, Cloud SQL, Secret Manager, admin users). Primary deployment path.
- `deploy/gcp/` shell equivalents, image build/push (`02-build-push.sh`) and the local authenticating proxy (`proxy.mjs`).
- `client/` engineer install script (`claude-gateway-setup.sh`). Writes system policy + user defaults.
- `api/server.mjs` budget app backend (Node 20+, no dependencies). `app/` React Native Web frontend (Expo).
- `config/`, `docker-compose.yaml`, `scripts/` local dev stack: gateway, Postgres, Dex (fake IdP), ClickHouse, OTel, Grafana.

## Run locally
`scripts/setup.sh`, `docker compose up -d`, `scripts/run-gateway.sh`, `scripts/run-app.sh` (http://localhost:8792).

## Rules that matter
- Never run `client/claude-gateway-setup.sh install` without `CLAUDE_MANAGED_DIR`/`CLAUDE_USER_DIR` set to temp dirs when testing: the
  real policy forces every Claude Code on the machine through the gateway.
- Org and group caps are per-person defaults, not shared pools; a personal cap overrides them.
- The app keeps the `Authorization` header free for Google IAM; its own session token is `x-app-token`.
- Metadata paths are `service-accounts` (plural). Gateway admin keys must be 32+ characters.
- Secrets live in `.env` (local) or Secret Manager (cloud). Never commit them; Terraform state holds them too.
