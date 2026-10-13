# Architecture and contracts

This file is the contract between the parts of the system. If you change a shape here, say so loudly in your report.

## What it is
Engineers use Claude Code through a self-hosted **Claude apps gateway** (Anthropic's own, built into the `claude` binary) on Vertex AI.
This repo adds: a **budget app** for admins and engineers (Node backend `api/`, React Native Web UI `app/`), **Terraform** for GCP,
an **installer** for engineers (`client/`), and a local dev stack. Open source, brand-neutral, not affiliated with Anthropic.

## Principles
- **Data is visible, changes are gated.** Read endpoints are open by default (`APP_VIEW_ACCESS=open`; `admin` makes them need a login). Every write needs an admin session.
- **Local-only by default.** The server refuses to listen beyond loopback unless on Cloud Run (private by IAM) or `APP_ALLOW_NON_LOOPBACK=1`.
- **No dependencies in `api/`** (Node 20+, built-ins and `fetch` only). Secrets only from environment. Never log secrets.
- **Org/group caps are per-person defaults, not shared pools.** A personal cap overrides them. `null` amount = unlimited.
- **Honest data.** Never fabricate numbers outside demo mode (`APP_DEMO=1`), which is bannered. Token/cache analytics need client telemetry and are *not* available yet: say so.
- Cloud Run IAM owns the `Authorization` header; the app's own session token travels in `x-app-token`.

## File ownership (parallel work: stay in your lane, report needed changes elsewhere)
| Area | Owns |
|---|---|
| backend-core | `api/server.mjs`, `api/lib/{auth,overrides,coach,routes}.mjs`, `api/test/{auth,overrides,coach,api}*.test.mjs` |
| usage | `api/lib/usage/{index,logs,clickhouse,demo}.mjs`, `api/test/usage-*.test.mjs` |
| terraform | `terraform/**`, `config/models.json`, `deploy/**` (Dockerfiles, proxy, build script) |
| client | `client/**`, `scripts/package-client.sh` |
| brand+oss | `assets/brand/**`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/**` |
| ui | `app/**` |
Already written and tested (change only with a reason): `api/lib/{config,http,gateway,store}.mjs`, `api/lib/usage/aggregate.mjs`.

## Shared types
```
Window w = { range:'24h'|'7d'|'30d', data:'all'|'real'|'loadtest', n, b, start, end }   // epoch SECONDS; n buckets of b seconds; b is a multiple of 3600
Outcome  = 'ok' | 'spend_cap' | 'upstream_error' | 'rejected'
Event    = { ts(ms), requestId, sub, email, model, status, ms, upstream, loadTest, cause? }     // one gateway inference event
```

## Gateway interface (`api/lib/gateway.mjs`: HTTP and in-memory twin)
`ping()`, `listLimits()`, `effective(subs)`, `effectiveAll()`, `audit(limit)`, `upsert(scope, period, cents|null, who)`, `remove(id, who)`; `who = { key, actor }`.
Rows have the real gateway's shapes (see `createMemoryGateway`).

## Store (`api/lib/store.mjs`): `get(name, fb)`, `put(name, v)`, `update(name, fn, fb)` (serialised), `list(prefix)`. Backends: memory, file, GCS.

## Usage backend (`api/lib/usage/index.mjs` -> `createUsage(cfg, { store }) -> usage`)
```
usage.source            'none' | 'demo' | 'logs' | 'clickhouse'
await usage.ok()        true | false | null (null = not configured)
await usage.roster()    Map(sub -> email|null)
await usage.users(w)    { rows:[{sub,email,requests,ok,lastSeen(iso|null),models[]}], spark: Map(sub -> number[w.n]) }
await usage.detail(sub, w, limit=25)  { series:{models:[..], values:{model:number[w.n]}}, models:[{model,requests,ok,p50|null}], recent:[Recent] }
await usage.company(w)  { totals:{requests,ok,upstream_errors,blocked,rejected,users}, byUser:[{sub,email,requests}], byModel:[{model,requests,ok}], series:{sub:number[w.n]} }
await usage.ingest()    { ingested:number }   // logs backend pulls new gateway log events; others return {ingested:0}
Recent = { ts(iso), id, sub, email, model, outcome, status, ms, lt(bool), cause|null }
```
`none` returns empty shapes (never throws). The aggregation logic is in `usage/aggregate.mjs` (shared by `logs` and `demo`).

## Overrides (`api/lib/overrides.mjs` -> `createOverrides({ store, gateway, cfg, now }) -> o`)
Temporary, automatically-reverting budget boosts (on-call, launch, incident). `o.list({status?})`, `o.forUser(sub)`, `o.create(input, admin)`, `o.cancel(id, admin)`, `o.tick()` (apply due, revert expired).
```
Override = { id, sub, email, name, period:'weekly'|'monthly', extraCents, baseCents, targetCents|null, startsAt(iso), endsAt(iso), reason,
             createdBy, createdAt, status:'scheduled'|'active'|'ended'|'cancelled'|'superseded'|'failed', prev:null|{kind:'none'|'unlimited'|'cap',cents?},
             appliedAt|null, endedAt|null, note|null }
```
Rules: target = effective cap at activation + extra. At activation remember the user's own previous limit (`prev`) and set the personal cap. At expiry restore `prev`
(none -> delete the personal limit; unlimited -> null; cap -> cents) **only if the personal cap still equals `targetCents`**, otherwise mark `superseded` and leave it. No cap to extend -> `failed`.
One live (scheduled/active) override per user+period at overlapping times (409). Duration 1 hour to `cfg.maxOverrideDays`. Reason 3-200 chars required. System actions use the system key.

## Coach (`api/lib/coach.mjs`): `buildCoach({ user, budgets, detail, range, catalog, overrides }) -> { summary, insights:[Insight] }`
`Insight = { id, severity:'info'|'medium'|'high', category:'model'|'reliability'|'budget'|'telemetry', title, description, action|null, impact|null }`. Rules use only real data
(model mix, outcomes, budget pace). Always include the `telemetry` info insight that token/cache coaching needs client telemetry (not yet available).

## HTTP API (`api/server.mjs`). JSON. Errors: `{ error }` with 400/401/403/404/409/429/5xx
Open reads (need a session only if `APP_VIEW_ACCESS=admin`):
- `GET /api/health` -> `{ gateway:bool, usage:{source, ok:bool|null}, demo:bool, accounts:bool, viewAccess, admin:{email,name}|null }` (never needs a session)
- `GET /api/users?range&data` -> `{ range, data, demo, usage:{source,ok}, buckets[iso], users:[{sub,email,name,requests,ok,failed,lastSeen,models[],spark[],budgets,overrides:[Override(live only)]}] }`
- `GET /api/users/:sub?range&data` -> existing detail shape (`user`, `orgDefaults`, `series`, `models`, `recent`, `audit`) plus `overrides:[Override]` (all for this user, newest first) and `coach`
- `GET /api/company?range&data` -> existing shape plus `overrides:{active:n, scheduled:n}`
- `GET /api/models?range&data` -> `{ default, models:[{alias,id,label,tier,description,enabled,pricePerMTok}], usage:[{model,requests,ok}] }`
- `GET /api/overrides?status=active,scheduled` -> `{ overrides:[Override] }`
- `GET /api/audit` -> `{ events:[AuditEvent] }`
Writes (admin session, header `x-app-token`):
- `POST /api/login {email?,password}` -> `{ token, email, name }` (rate-limited; same error for unknown email and wrong password)
- `PUT /api/users/:sub/budget`, `PUT /api/org/budget` -> `{period, action:'set'|'unlimited'|'inherit', usd?}`
- `POST /api/overrides {sub, period, extraUsd, startsAt?(iso), endsAt(iso), reason}` -> `Override` (201) / `DELETE /api/overrides/:id` -> Override
- `POST /api/internal/tick` -> `{ overrides:{applied,ended,failed}, usage:{ingested[,error]} }`; allowed for an admin session **or** a Google-signed ID token (RS256, verified against Google's JWKS; `iss`, `aud == SCHEDULER_AUDIENCE`, `exp`, `email == SCHEDULER_SA`, `email_verified`). Overrides and usage ingest run on **separate** single-flights.
Budgets shape per period: `{ capCents|null, spendCents, source:'user'|'organization'|'rbac_group'|null, limitId|null, unlimited:bool }`.

## Environment (see `api/lib/config.mjs`)
`APP_DEMO`, `APP_HOST`, `PORT`, `GATEWAY_URL`, `GATEWAY_AUDIENCE`, `GATEWAY_ADMIN_READ_KEY`, `GATEWAY_ADMIN_WRITE_KEY`, `GATEWAY_SYSTEM_WRITE_KEY`, `APP_ADMINS`, `APP_ADMIN_PASSWORD`,
`APP_SESSION_SECRET`, `APP_VIEW_ACCESS`, `USAGE_SOURCE`, `CLICKHOUSE_*`, `APP_STATE_BUCKET`, `APP_DATA_DIR`, `SCHEDULER_SA`, `MODELS_JSON`/`MODELS_FILE`, `APP_ALLOWED_*`.

## Gateway event formats (Cloud Run stdout/stderr, same locally)
JSON line: `{"ts","evt":"inference","request_id","sub","email","path":"/v1/messages","model","upstream","status","ms","load_test"?}`.
Upstream error text line: `[gateway] <ts> warn vertex upstream <status> request_id=<id>: <status> {"error":{"code":..,"message":..,"status":"RESOURCE_EXHAUSTED"}}`.
Other events: `auth.denied`, `session.mint`, `device.authorize`, `device.verify`, `admin.limit.upsert|delete`, `admin.denied`, `config.load`.

## Testing
`cd api && node --test test/*.test.mjs` (no network, no ports except ones the test opens on 19100-19199). Demo mode (`APP_DEMO=1`) must work with zero external services.


## Contract changes made after the adversarial reviews (these supersede anything above)

**HTTP**
- `POST /api/logout` (admin) -> `{ok:true}`: revokes every session of that admin. Restarting the server or rotating `APP_SESSION_SECRET` revokes all sessions. Tokens carry `iat` and a per-account version; the format is opaque.
- `POST /api/overrides/:id/retry` (admin) -> `Override`; 409 unless the override is `failed`, still inside its window and not overlapping another.
- `GET /api/health` -> `{ gateway, usage:{source,ok}, demo, accounts, viewAccess, maxOverrideDays, admin }` and nothing else. Probes are cached ~10 s.
- `GET /api/company` adds `usersWithOverrides` (people with a personal cap) and `overrides.overdue`. `userOverrides` counts people, not limit rows.
- `GET /api/users/:sub` adds `auditTruncated:bool` (the gateway's audit endpoint returns at most 500 events and cannot be paged).
- Override adds `overdue`, `overdueMs`, `retryable`, `baseSource`. An override whose creator is no longer an admin is cancelled/reverted (note `creator removed`) when accounts mode is on.
- Errors: gateway unreachable -> `502 {"error":"gateway unavailable"}` with `Retry-After` (never 500); overload -> 503; login throttle -> 429 with `Retry-After`; a budget write for a user the gateway has never seen -> 404; invalid `range`/`data` -> 400; non-plain-decimal money (`0x10`, `1e3`, more than 2 decimals) -> 400.
- Reads are cached 8 s (every write clears the cache), identical in-flight requests are coalesced, at most 4 expensive computations run at once.

**Environment**
- New: `SCHEDULER_AUDIENCE` (required whenever `SCHEDULER_SA` is set; must equal the app's own URL and the Scheduler job's OIDC audience), `APP_DEV=1` (enables the Expo dev CORS origins; never on Cloud Run), `APP_DEMO_ALLOW_CLOUD=1` (demo mode is otherwise refused on Cloud Run), `APP_READ_CACHE_MS`, `APP_HEALTH_CACHE_MS`.
- Stricter: admin passwords >= 12 chars, `APP_SESSION_SECRET` >= 32 chars (required on Cloud Run, may be derived from `GATEWAY_JWT_SECRET` locally), `APP_MAX_OVERRIDE_DAYS` must be a number 1-365 or the server refuses to start, `GATEWAY_SYSTEM_WRITE_KEY` is required in accounts mode (no fallback to an admin key).
- Optional: `USAGE_LOGS_VIEW` (`projects/<id>/locations/<loc>/buckets/<bucket>/views/<view>`, validated) makes the logs backend read a Cloud Logging view limited to the gateway's logs instead of the whole project (Terraform `scope_app_log_access = true`). `SECRETS_HASH` / `CONFIG_HASH` are Terraform-set values whose only job is to roll a new Cloud Run revision when secrets or config change; the app ignores them.

**Gateway event formats (verified against the real gateway by the e2e suite)**
- A spend-cap block is its own event and has **no** `inference` event: `{"evt":"spend.blocked","request_id","sub","cause":"over_limit","cap_cents","source","period"[,"load_test"]}`. The usage backends count it as a 429 with an empty upstream (`spend_cap`); alerts must key on `evt="spend.blocked"`.
- Policy-rejected requests are logged with `model: null`.
- Session tokens are HS256 JWTs (`sub,email,name,aud=claude-gateway,iat,exp,iss=public_url`).

**Overrides invariant.** After a chain of boosts ends, the user's personal cap equals what it was before the first boost began (or none). A boost never activates while another boost for the same user and period is active or mid-activation; it waits and retries. If the org default changes mid-boost, a boost layered on the default is re-targeted to the new default plus the boost; a boost layered on a deliberate lower personal cap restores that cap exactly. A hand edit during a boost makes it `superseded` and is never overwritten.

**Storage.** Only a missing file/object means "empty"; any read or parse error fails loudly (`StoreError`, HTTP 500 generic) and a corrupt file is quarantined as `<name>.json.corrupt-<ts>`. Usage day documents are v2 (counts plus a ledger of hashed request ids so replays after a failure are no-ops); recent requests are per-user rings across 256 shard documents (`usage/recent/<00..ff>`); p50 is approximate (log-spaced bins with interpolation) and ignores missing latencies.

**Usage backend.** `ingest()` throws on failure (the route reports `usage:{ingested:0,error}` without failing the override tick); `usage.status()` exists on the logs backend. ClickHouse mode would need `clickhouse/views.sql` to union `spend.blocked` into `v_gateway_requests`.

**Sessions, login throttling and concurrency (round 2).** Admin sessions, logout revocation and login throttling live in the memory of one app process: a restart, a deploy, or rotating `APP_SESSION_SECRET` signs everyone out, and with more than one instance a logout or a lockout only applies to the instance that handled it, so run the app with exactly one instance (the Terraform default, `max_instances = 1`). Login failures lock per (account, client address) and per client address; a per-account ceiling (50 failures in a rolling hour) logs `admin.login.suspicious` and slows that account by 1.5 s but never blocks a correct password from a clean address. Behind a load balancer the last `X-Forwarded-For` hop is the balancer's own address, so every client then shares one per-address login bucket (10 failures lock it); the per-(account, address) and per-account protections still work, but give the app a direct client address if you can. New log events: `admin.login.suspicious`, `admin.logout`; `admin.login.failed.reason` is `bad_credentials` or `throttled`. Four workers serve expensive reads: anonymous callers can use three (48 queue slots), admins all four (16 reserved slots), then 503 with `Retry-After`; `GET /api/users/:sub` answers 404 from a cached known-users set without building the detail. Only origin-form request targets are served; anything else is a JSON 400.
