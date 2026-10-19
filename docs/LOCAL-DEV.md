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

## Test the IAP + internal load balancer setup locally

The deployed enterprise setup puts the budget app behind Google IAP and the gateway behind an internal load balancer with TLS
([INSTALL.md](INSTALL.md)). `scripts/edge.sh` runs the **same topology** on your laptop with no cloud access, so you can see what admins and
engineers will see and debug origin/CSRF/TLS problems before a real apply:

```
 browser ──http://app.localhost:19330──▶ IAP emulator ──(signed JWT, Host kept)──▶ budget app (APP_AUTH_MODE=iap)
 Claude Code ──https://gateway.localhost:19331──▶ ILB emulator (TLS, throwaway CA) ──▶ real `claude gateway` (public_url = that https URL)
                                                                                   └─▶ local IdP (sign-in), Postgres (database gateway_edge)
```

**Prerequisites:** node 20+, the `claude` binary and `openssl` on PATH, and a Postgres: `docker compose up -d postgres` after `scripts/setup.sh` (the edge uses its own
database `gateway_edge` on it) or `EDGE_POSTGRES_URL=postgres://...`. Nothing leaves the machine; model replies are canned (`load_test_mode`).
Ports 19330-19334 (override with `EDGE_APP_PORT`, `EDGE_GATEWAY_PORT`, `EDGE_IDP_PORT`, `EDGE_GATEWAY_INTERNAL_PORT`, `EDGE_APP_INTERNAL_PORT`); everything generated is in `data/edge/` (gitignored).

```bash
scripts/edge.sh up        # generates certs/config, starts everything, prints URLs and a "what to do next" list
scripts/edge.sh status    # expected: processes idp gateway ilb iap app; signed-out app 302 -> /_iap/signin; direct /api/users 401; gateway /readyz 200; gateway without the CA refused
scripts/edge.sh check     # the whole flow with curl, PASS/FAIL per step (expected: "check: 28 passed, 0 failed")
scripts/edge.sh test      # the automated L6 layer: 18 tests incl. a headless Chrome (needs Docker for a throwaway Postgres; expected RESULT: PASS)
scripts/edge.sh down      # stops only what `up` started
```

### What `check` walks through, by hand

```bash
A=http://app.localhost:19330; CA=data/edge/ca.pem; G=https://gateway.localhost:19331
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' $A/                         # 302 -> http://app.localhost:19330/_iap/signin?next=%2F
curl -s -o /dev/null -w '%{http_code}\n' $A/api/health -H 'accept: application/json'     # 401: no token, no data
curl -s -c admin.jar -o /dev/null -X POST $A/_iap/signin -H "origin: $A" --data-urlencode email=ada@example.com --data-urlencode next=/   # sign in as the admin
curl -s -b admin.jar $A/api/health -H 'sec-fetch-site: same-origin'                       # ..."auth":"iap","identity":{"email":"ada@example.com","name":"ada","admin":true}
W=(-H "origin: $A" -H 'x-app-csrf: 1' -H 'sec-fetch-site: same-origin' -H 'content-type: application/json')
curl -s -b admin.jar -X PUT $A/api/org/budget "${W[@]}" --data '{"period":"weekly","action":"set","usd":25}'   # 200 {"ok":true,"limit":{...}}  (writes the local gateway_edge database only)
# the same with a viewer's cookie (sign in as bob@example.com):                            # 403 {"error":"only admins can do this"}
# cross-site: -H 'origin: http://evil.localhost:1' -H 'sec-fetch-site: cross-site'          # 403 {"error":"cross-origin request refused"}
# no CSRF header:                                                                           # 403 {"error":"cross-site or non-browser request refused"}
curl -s -o /dev/null -w '%{http_code}\n' -b admin.jar "$A/api/company?secure_token_test=bad-signature"   # 401 (also: expired wrong-aud wrong-iss wrong-alg unknown-kid too-long no-email garbage none)
curl --cacert $CA $G/readyz                                                                 # ready
curl $G/readyz                                                                              # curl: (60) SSL certificate problem: unable to get local issuer certificate
curl --cacert $CA --tls-max 1.1 $G/readyz                                                   # fails: TLS 1.2+ only
```

Each line proves our wiring: no data without a token the app itself verified (it ignores the unsigned `x-goog-authenticated-user-*` headers), admin vs viewer from the verified
email, a write needs the CSRF header **and** a same-origin proof, a tampered token is refused whatever is wrong with it, the gateway answers only over https with a name its
certificate covers, and its `public_url` matches the `Host` it sees.

### Use a real browser and a real Claude Code

* **Browser.** Open `http://app.localhost:19330` in Chrome, Firefox or Safari. `*.localhost` resolves to loopback, so no hosts-file edit is needed and the browser origin, the `Host` the app
  receives and `APP_ALLOWED_HOSTS` really are the same name (the property IAP needs). Pick `ada@example.com` (admin) or `bob@example.com` (viewer); change a budget as each. Append
  `?secure_token_test=bad-signature` to any app URL to watch a tampered token being refused. The app itself is plain http; only the gateway is https.
* **Gateway page in the browser.** `https://gateway.localhost:19331/device` shows a certificate warning until you trust `data/edge/ca.pem` (macOS: Keychain Access, import, set *Always trust*; remove it afterwards).
* **Claude Code.** `scripts/edge.sh claude` starts `claude` with its own config dir (`data/edge/claude-config`, so your real `~/.claude` and `.claude-test` are untouched), `forceLoginGatewayUrl` set to the https gateway and the
  throwaway CA trusted for that one process. Run `/login`, choose *Cloud gateway*, sign in as `alice@example.com` or `bob@example.com` on the local IdP page. By hand:
  `NODE_EXTRA_CA_CERTS=data/edge/ca.pem CLAUDE_CONFIG_DIR=<dir whose settings.json has forceLoginMethod "gateway" and forceLoginGatewayUrl "https://gateway.localhost:19331"> claude`.
  (The interactive sign-in was not driven by us; the gateway's `/device` page and OIDC redirect are covered by L6.)

### What this proves, and what it cannot

| Proves (locally) | Cannot prove (needs a real deployment) |
|---|---|
| The app refuses everything without a valid ES256 token (`iss`, `aud`, `exp`/`iat`, `kid`, `alg` checks), ignores unsigned headers, separates admin and viewer | That Google's keys at `https://www.gstatic.com/iap/verify/public_key-jwk` verify our code path in production (the emulator signs with its own key; Google's key rotation, `hd`/`sub` values for your accounts) |
| One origin end to end: browser origin == `Host` == allow-list, CSRF and Fetch-Metadata rules, cross-site writes fail | The exact `IAP_AUDIENCE` string Google puts in `aud` for your service (we follow Google's documented formats; a mismatch shows as `iap.denied reason=aud` in the app log) |
| The header name `x-goog-iap-jwt-assertion`, JWT claim shapes and lifetimes as Google documents them | The real consent screen, the Google sign-in page, custom OAuth client binding, the IAP service agent, org policies |
| TLS trust: the gateway answers only over https with the generated CA, name checks, TLS 1.2+, `public_url` equals the `Host`, `X-Forwarded-For` reaches the gateway | The real internal Application Load Balancer, private DNS from Cloud Run and from your VPN, Google's `X-Forwarded-For` layout, Claude Code's leaf pinning and private-address check against these certificates (`gateway.localhost` is loopback, which Claude Code accepts; a corporate hostname resolving to a private IP is the real case) |
| The real `claude gateway` binary runs with this config and serves `/readyz`, `/device`, admin APIs | A real model reply through Vertex |

Never point the emulators at anything but this machine.

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
