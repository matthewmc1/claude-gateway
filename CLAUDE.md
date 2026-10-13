# Claude gateway: project notes

Central Claude Code access for a team: Anthropic's own `claude gateway` (OIDC sign-in, per-person budgets, Vertex AI) plus a
budget/usage app for admins. Goals: one place to see and limit usage, and a good experience for engineers.

## Layout
- `terraform/` GCP provisioning (Cloud Run, Cloud SQL, Secret Manager, admin users). Primary deployment path.
- `deploy/` image build/push (`build-push.sh`), Dockerfiles and the local authenticating proxy (`proxy.sh`, `proxy.mjs`).
- `docs/ARCHITECTURE.md` is the contract between modules and the HTTP API; read it before changing shapes.
- `client/` engineer install script (`claude-gateway-setup.sh`). Writes system policy + user defaults.
- `api/` budget app backend (Node 20+, zero dependencies; `api/lib/**`). `app/` React Native Web frontend (Expo).
- `config/`, `docker-compose.yaml`, `scripts/` local dev stack: gateway, Postgres, Dex (fake IdP), ClickHouse, OTel, Grafana.

## Run locally
No gateway: `scripts/demo.sh`. Full local stack: `scripts/setup.sh`, `docker compose up -d`, `scripts/run-gateway.sh`, `scripts/run-app.sh` (http://localhost:8792).

## Tests
`cd api && node --test test/*.test.mjs` · `cd app && npx tsc --noEmit && node --experimental-strip-types --test test/*.test.ts` · `bash client/test/run.sh` · `bash terraform/tests/run.sh` (do not set a long TMPDIR: provider sockets fail) · `bash scripts/e2e.sh` (needs Docker for a throwaway Postgres).

## Rules that matter
- Never run `client/claude-gateway-setup.sh install` without `CLAUDE_MANAGED_DIR`/`CLAUDE_USER_DIR` set to temp dirs when testing: the
  real policy forces every Claude Code on the machine through the gateway.
- Org and group caps are per-person defaults, not shared pools; a personal cap overrides them.
- Data is visible without login by default; every write needs an admin. The app is local-only unless on Cloud Run.
- Temporary boosts (on-call) edit real caps unattended: change `api/lib/overrides.mjs` only with tests for every state transition.
- The app keeps the `Authorization` header free for Google IAM; its own session token is `x-app-token`.
- Metadata paths are `service-accounts` (plural). Gateway admin keys must be 32+ characters.
- Secrets live in `.env` (local) or Secret Manager (cloud). Never commit them; Terraform state holds them too.
