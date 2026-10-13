# Claude gateway

Give an engineering team Claude Code through **one company gateway**: everyone signs in with their work account,
every request is attributed and capped, and admins see and adjust budgets in a purpose-built app.

```
 engineer ──Claude Code──▶ gateway (OIDC sign-in, model policy, caps) ──▶ Claude on Vertex AI
                                │                                   
                admins ──▶ budget app (per-person weekly / monthly budgets, company defaults, change history)
```

* **Engineers:** `client/claude-gateway-setup.sh install` → Sonnet 5.5 at medium effort by default, one explicit command
  to step up to Opus 5.5, sign-in only through the company identity provider. See [`client/`](client/).
* **Admins:** defined in Terraform, sign in with their own account; every budget change is attributed to a person in
  the gateway's audit trail. See [`terraform/`](terraform/).
* **Platform:** Terraform provisions private Cloud Run services, Cloud SQL, Secret Manager and Vertex access.

## Quick start (Google Cloud)

```bash
cd terraform && cp terraform.tfvars.example terraform.tfvars   # set project, admin_users, allowed_email_domains
terraform init && terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
../deploy/gcp/02-build-push.sh && terraform apply
../deploy/gcp/05-proxy.sh                                      # gateway :8891, budget app :8892
./client/claude-gateway-setup.sh install --gateway-url http://localhost:8891
```

Full steps and caveats in [`terraform/README.md`](terraform/README.md).

## Repository map

| Path | What |
|---|---|
| `terraform/` | Provisioning, including admin users |
| `client/` | Engineer install, model and effort commands |
| `api/`, `app/` | Budget app (Node backend, React Native Web UI) |
| `deploy/gcp/` | Image build and push, local authenticating proxy, shell equivalents of the Terraform |
| `config/`, `docker-compose.yaml`, `scripts/`, `clickhouse/`, `grafana/` | Local development stack and Grafana dashboards |

---

# Local development stack

Anthropic's own [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)
(built into the `claude` binary) in front of Vertex AI, plus an analytics layer
that stores every request and shows it in Grafana.

```
 Claude Code / Desktop ──HTTPS+SSO token──▶ claude gateway ──ADC──▶ Vertex AI
                                              │   │  │
                          spend ledger, audit │   │  └─ audit log (JSON, per request)
                                  Postgres ◀──┘   │            │
                                                  └─ OTLP relay│
                                                       ▼       ▼
                                                   OTel collector ──▶ ClickHouse ──▶ Grafana
```

| Piece | What it gives you |
|---|---|
| gateway | SSO sign-in, per-group model allowlist, live spend caps (429 at cap), failover, no keys on laptops |
| Postgres | the gateway's spend ledger, caps, admin audit, last-seen identity |
| collector + ClickHouse | every gateway request (incl. failures) and client OTLP metrics/logs/traces, kept 180 days |
| Budget app (`app/` + `api/`) | React Native Web app on http://localhost:8792: per-person usage, weekly and monthly budget editing, company defaults, change history. A small backend keeps the admin keys off the browser. |
| Grafana | `Claude gateway: overview`: outcomes, models, users, latency, upstream error causes, per-request trace.<br>`Claude gateway: budgets and tracking`: caps in force, cap history, budget adjustment log (who changed what, before/after), usage by user, request tracker with request-ID lookup |

## Run locally

Needs Docker, the `claude` CLI (v2.1.195+), and `gcloud auth application-default login`.

```bash
./scripts/setup.sh              # writes .env with random secrets; check VERTEX_PROJECT_ID
docker compose up -d
./scripts/apply-views.sh        # ClickHouse views (after the collector has written once)
./scripts/run-gateway.sh        # gateway on http://localhost:8791
./scripts/claude-dev.sh         # isolated Claude Code that signs in via the gateway
```

Grafana: http://localhost:3000, user `admin`, password is `GRAFANA_ADMIN_PASSWORD` in `.env`.
Dev users (Dex): `alice@example.com`, `bob@example.com`, password `changeme`.

Every cap change is written to the gateway's `admin_audit` table and shows in the budgets dashboard.
Spend caps: `./scripts/set-limit.sh org 100 monthly`, `... user <sub> 20 daily`, `... list`, `... effective`.

## Budget app

```bash
./scripts/run-app.sh          # builds app/dist on first run, serves http://localhost:8792
```

Sign in with `APP_ADMIN_PASSWORD` from `.env`. People page: usage and budget per person, click one to edit their
weekly and monthly cap (company default, custom amount, or unlimited). Company page: default per-person caps,
exposure and usage. Activity page: audit trail of every cap change.

* Caps are written through the gateway admin API, so they take effect on the next request and show in the gateway's own audit log.
* Org and group caps are **per-person defaults**, not a shared pool. A personal cap overrides them (higher or lower).
* The audit trail records the admin key (`local-admin`), not which person used the app. There is one shared password.
* `DEMO_SPEND=1 ./scripts/run-app.sh` overlays fabricated spend for design review (banner shown). Never use it for decisions.
* Rebuild after editing `app/`: `BUILD=1 ./scripts/run-app.sh`. Dev server: `cd app && npx expo start --web` (talks to :8792).
* Daily caps are shown read-only; manage them with `scripts/set-limit.sh`.

## Vertex requirements (the usual first-run failures)

| Symptom in the dashboard | Cause |
|---|---|
| 403 `BILLING_DISABLED` | billing account closed or not linked to the project |
| 404 publisher model not found | wrong region. Claude models are served from **`global`**, set `VERTEX_REGION=global` |
| 429 `RESOURCE_EXHAUSTED ... per_base_model` | project has no Claude quota yet. Request it under IAM & Admin > Quotas, filter `global_online_prediction_requests_per_base_model` |

The "Upstream errors" panel shows these with Google's own message, per request.

## Load-test mode (no model calls)

`LOAD_TEST=1 ./scripts/run-gateway.sh` runs the full gateway path with canned replies,
on a **separate database** (`gateway_loadtest`) so fake traffic never touches real
spend or caps. Audit events carry `load_test:true`; the dashboard's **Data** variable
filters `real` / `loadtest` / `all`. Restart without `LOAD_TEST` for real traffic.
Never run a gateway developers use in this mode.

## Privacy

Telemetry is stamped with each user's verified email and groups. Prompts, responses and
tool details stay **redacted** (`OTEL_LOG_*` = 0 in `config/gateway.yaml`). Turning those on
is a team decision; tell people first, and restrict who can open Grafana.

## Known limits

* The gateway's spend figures are list-price estimates, a guardrail rather than an invoice. Reconcile against the GCP bill.
* Audit events carry no token counts or cost. Tokens, cost, cache hit rate and tool behaviour come from **client** OTLP (`claude_code.api_request` etc.), which needs a real Claude Code session. Views and panels for that are not built yet.
* The spend-ledger panel is empty until a real model call is metered, so "spend vs cap" and "blocked by cap" are untested end to end. The ledger's period key format is unverified, so there is no percent-of-cap panel yet.
* A request rejected for policy logs `model: null`, so a rejection can't be attributed to the model asked for.
* Dex has no groups, so group-scoped caps/policies need a real IdP to exercise.
* `config/otel-collector.yaml` creates ClickHouse tables on first write (dev). For prod set `create_schema: false` and own the DDL.

## Cloud Run

Gateway and budget app run as private Cloud Run services, state in Cloud SQL, secrets in Secret Manager.
See `deploy/gcp/README.md`. Reach them with `deploy/gcp/05-proxy.sh` (gateway on localhost:8891, app on localhost:8892).
Google sign-in for the gateway needs an OAuth client you create in the console; until then the gateway runs
with a placeholder and sign-in can't complete. Not deployed: ClickHouse/Grafana (the app's usage views are empty there).

## Not done yet

Needs a decision on the real IdP (Google Workspace/Okta/Entra), a private network path
(Claude Code only connects to private addresses), Cloud SQL, and Cloud Logging as the
audit-log source instead of the local file. See the Google Cloud and deployment pages linked from the gateway docs.
