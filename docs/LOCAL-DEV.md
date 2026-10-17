# Local development stack

This page covers running everything on your laptop. For Google Cloud see [DEPLOY.md](DEPLOY.md).

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
* Local mode has one shared admin password, so the audit trail shows `local-admin`. Production (Terraform) gives each admin their own account and gateway key.
* `./scripts/demo.sh` runs the app on built-in sample data with no gateway at all (bannered "Sample data").
* Rebuild after editing `app/`: `BUILD=1 ./scripts/run-app.sh`. Dev server: `cd app && npx expo start --web` (talks to :8792).
* Daily caps are shown read-only; manage them with `scripts/set-limit.sh`.
* The app only listens on `127.0.0.1` and refuses to start otherwise (see `APP_ALLOW_NON_LOOPBACK`).

## Run the enterprise edge locally

The deployed enterprise setup puts the budget app behind Google IAP and the gateway behind an internal load balancer with TLS. You can run the
**same topology** on a laptop, with no cloud access, to see what engineers and admins will see and to debug origin/CORS/CSRF/TLS problems early:

```bash
scripts/edge.sh up        # certs, local IdP, gateway, ILB + IAP emulators, the app in iap mode (needs the compose Postgres, or EDGE_POSTGRES_URL)
scripts/edge.sh status    # what answers (the app must refuse requests that bypass IAP: 401; the gateway must refuse an untrusted CA)
scripts/edge.sh test      # the L6 end-to-end layer (Docker, a headless Chrome for the browser parts); `scripts/edge.sh down` stops only what `up` started
```

| Open | What it is |
|---|---|
| `http://app.localhost:19330` | the budget app behind the **IAP emulator**: sign in by picking an email (admins are `EDGE_ADMINS`, default `ada@example.com`; others are viewers). The app only trusts the signed `x-goog-iap-jwt-assertion`. Add `?secure_token_test=bad-signature` to a URL to send a broken token and watch the app refuse it. |
| `https://gateway.localhost:19331` | the gateway behind the **ILB emulator**: TLS with a throwaway CA (`data/edge/ca.pem`, `curl --cacert ...`), `public_url` is this https URL, `/device` sign-in is served under it. Sign in with `alice@example.com` or `bob@example.com` on the local IdP page. |

Browser origin, the `Host` the app sees and the allow-list are all `http://app.localhost:19330`, which is exactly what makes IAP work without a proxy.
`*.localhost` resolves to loopback in browsers and Node. Replies are canned (`load_test_mode`), so nothing is sent to Vertex; state lives in `data/edge/` and the
`gateway_edge` database. Ports can be changed with `EDGE_APP_PORT`, `EDGE_GATEWAY_PORT`, `EDGE_IDP_PORT`, `EDGE_GATEWAY_INTERNAL_PORT`, `EDGE_APP_INTERNAL_PORT`.

**What is only emulated.** The emulators are not Google. They prove our wiring (one origin, JWT verification, CSRF defence, TLS trust, `public_url` vs `Host`), not
Google's own behaviour: real IAP sign-in, real key rotation, the real internal Application Load Balancer, real certificates, and Claude Code's gateway-certificate
pinning and "private address only" check are unverified until you deploy. Never point the emulators at anything but this machine.

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
