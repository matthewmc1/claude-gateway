# Deploying on Google Cloud

This guide takes a fresh Google Cloud project to a working, private gateway with a budget app, monitoring and alerts.
Terraform does all of it except one console step (the Google OAuth client, below).

```
 engineer ─Claude Code─▶ localhost:8891 (deploy/proxy.sh) ─▶ gateway (Cloud Run, private)  ──▶ Claude on Vertex AI
 admin ───── browser ──▶ localhost:8892 (deploy/proxy.sh) ─▶ budget app (Cloud Run, private)
                                                      gateway ─▶ Cloud SQL (private IP)       Secret Manager
 Cloud Scheduler (every minute, OIDC) ─▶ budget app /api/internal/tick     budget app ─▶ GCS state bucket, Cloud Logging
```

## 1. Prerequisites

* A Google Cloud project with **billing enabled**, and permission to create resources in it (Owner is simplest for a trial).
  Or let Terraform create the project (`create_project`, optional; see below).
* On your machine: `terraform` 1.5+, `gcloud` (logged in: `gcloud auth login` and `gcloud auth application-default login`),
  `docker` with buildx, `node` 20+ (for the budget-app bundle and the local proxy), `curl`, `gpg`, `jq`.
* Claude models enabled for your project in the Vertex AI Model Garden, with quota in the region you use
  (`global` by default).
* Terraform enables the APIs it needs (`google_project_service`): Cloud Run, Cloud SQL, Secret Manager, Artifact Registry,
  Vertex AI, Compute, Service Networking, IAM, Logging, Monitoring, Cloud Scheduler, Storage, Resource Manager.

## 2. Quick start

```bash
cd terraform
./setup.sh --create-state-bucket   # wizard: project, region, admins, domains, PROFILE, public URL, state bucket, OAuth client id/secret
terraform init                     # remote state in the bucket (an existing local state: terraform init -migrate-state)
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
PROJECT_ID=<project> REGION=<region> ../deploy/build-push.sh      # prints the budget-app image tag
terraform apply -var app_image_tag=<that tag>
terraform output oidc_setup_steps
```

* `setup.sh` detects your active `gcloud` project as the default, writes `terraform.tfvars`, writes the OAuth client
  secret only to `secrets.auto.tfvars` (mode 600, git-ignored, never echoed), and checks the result offline. It will not
  overwrite an existing file without asking and keeps a backup. `--non-interactive` (flags or environment variables) is for CI,
  `--check [file]` validates an existing `terraform.tfvars`.
* **The profile has no default.** The wizard explains `trial` and `production` and makes you type one; `--non-interactive`
  requires `--profile`/`PROFILE`; `terraform plan` fails with "No value for required variable" if `profile` is missing. A
  forgotten `trial` would mean a database without point-in-time recovery or deletion protection and a deletable state bucket.
* **Remote state is the recommended default.** Terraform state holds generated passwords and keys, so keep it in a private,
  versioned GCS bucket. `./setup.sh` asks for the bucket (default `<project>-tfstate`) and writes `backend.tf`; with
  `--create-state-bucket` it also creates the bucket: it prints the exact two `gcloud storage buckets create/update` commands (uniform
  access, public access prevention, versioning) and runs them only after you type `yes` (non-interactively:
  `--confirm-create-state-bucket`; `--force` never counts as confirmation). `--state-bucket none` keeps a local file and prints a
  warning. Grant `roles/storage.objectUser` on that bucket only to the people who run Terraform.
* Or copy `terraform.tfvars.example` to `terraform.tfvars` and edit. Required: `project_id`, `profile`, `admin_users`,
  `allowed_email_domains` (or `oidc.google_workspace_domain`) and `oidc.client_id`; the OAuth secret goes in `secrets.auto.tfvars`
  or `export TF_VAR_oidc_client_secret=...`. `app_image_tag` is required for the full apply (below).

### Why the first apply is in two phases

Cloud Run cannot create a service whose image does not exist, and the registry that will hold the images is itself a
Terraform resource. So: (1) apply the registry and APIs (no image tag needed yet), (2) `deploy/build-push.sh` builds and pushes both
images (it verifies the pinned Claude Code binary against Anthropic's signed manifest, see "Supply chain" below, and prints the
tags), (3) the full apply with `app_image_tag` set to the timestamp tag the script printed. `app_image_tag` has **no default and
must identify one build**: a mutable tag would make `terraform apply` blind to new builds. Accepted: a timestamp of 8 or more digits
(what `build-push.sh` prints), a 7-40 character lower-case hex git sha, or semver with a build suffix (`1.4.0-build.7`); refused, in any case:
`latest`, `main`, `master`, `dev`, `develop`, `stable`, `head`, `trunk`, `prod`, `production`, `staging`, `canary`, `nightly` as a word
(`APP_TAG` for the script is held to the same rule, `deploy/lib/app-tag.sh`). Set it to the new tag after every build to
roll a new budget-app revision. `gateway_image_tag` is the pinned Claude Code release (default `2.1.296`; use the same
`IMAGE_TAG` when building).

### The profile switch

| | `trial` | `production` |
|---|---|---|
| Cloud SQL | `db-f1-micro`, zonal, daily backups only | `db-custom-1-3840`, regional (HA), point-in-time recovery |
| Cloud SQL deletion protection | **off** (Terraform and GCP level) | on (Terraform and GCP level: console/gcloud deletes are refused too) |
| Gateway instances | 1 warm, at most 2 | 2 warm, at most 6 |
| State bucket | deletable with objects | protected |
| Log retention (if `manage_log_retention`) | 30 days | 400 days |
| Alert thresholds | relaxed | tighter |

Any variable overrides the profile (`db_tier`, `db_deletion_protection`, `gateway_min_instances`, `gateway_max_instances`,
`state_bucket_force_destroy`, `log_retention_days`, `alert_thresholds`). `terraform output effective_settings` shows what is in force.
Use `trial` only for something you are happy to lose; set `production` (or `db_deletion_protection = true`) for anything people depend on.

### Gateway sizing and the database connection budget

Each gateway instance opens up to `gateway_store_max_connections` (default 5, the gateway's own default) Postgres connections. So
`gateway_max_instances x gateway_store_max_connections + 3 (reserved)` must fit in the tier's `max_connections`; `terraform plan`
fails when it does not. Conservative floors used for the check: `db-f1-micro` 25, `db-g1-small` 50, `db-custom-1-3840` 100
(verify with `SHOW max_connections;`); for other tiers set `db_max_connections` or the check is skipped. A rollout briefly runs two
revisions, so leave headroom (the trial default of 2 instances x 5 = 10 of 25; production 6 x 5 = 30 of 100).
Each instance has explicit limits (`gateway_cpu` 1, `gateway_memory` 1Gi), startup CPU boost, a startup probe on `/readyz`
(the gateway asks Postgres) and a liveness probe on `/healthz` (process only, so a database blip never restarts healthy instances).
Cloud Run answers HTTP 429 itself when every instance is busy (about 80 concurrent requests per instance): that never appears in
the gateway's logs, so two alerts watch the Cloud Run metrics (section 9).

## 3. Google sign-in (the one manual step)

Engineers sign in to the gateway through OpenID Connect. For Google accounts you need an OAuth client of type
**Web application**. Google offers no API or Terraform resource to create that client, so it is created once in the
console. `terraform output oidc_setup_steps` prints the same steps with your project's links filled in:

1. **Consent screen** (`terraform output oidc_consent_screen_url`).
   * Everyone is in one Google Workspace / Cloud Identity organization: choose **Internal**. Only that organization's accounts can sign in.
   * Personal Gmail accounts or people outside the organization: choose **External**, keep it in **Testing**, and add each
     engineer under **Test users** (limit 100). Testing-mode refresh tokens expire after 7 days; fine for a trial, publish the app for production use.
2. **Credentials** (`terraform output oidc_console_url`): Create credentials, OAuth client ID, Web application.
3. **Authorized redirect URI**: exactly `terraform output -raw oidc_redirect_uri` (`<public_url>/oauth/callback`).
4. Put the client ID in `terraform.tfvars` (`oidc = { client_id = "..." }`) and the secret in `secrets.auto.tfvars` (`./setup.sh` does both).
5. `terraform apply` again: the gateway rolls a new revision with the real client.

You can run the first apply **before** the client exists: with no `oidc.client_id`/secret the gateway is configured with a clearly
labelled placeholder, a warning is printed on every plan, and sign-in simply does not work until you finish the steps.
`oidc.google_workspace_domain` limits Google's account chooser to your Workspace domain (`hd=`) and is the default for
`allowed_email_domains`. For a company IdP (Okta, Entra) set `oidc.issuer` and use that IdP's client id; any non-empty id is accepted.

## 4. Admins

```hcl
admin_users = [
  { email = "platform-lead@example.com", name = "Platform Lead" },
  { email = "finance@example.com" },
]
```

Each admin gets a generated password, a personal gateway write key, and `roles/run.invoker` on both private services. The budget
app signs the admin in with email and password and changes caps with *their* key, so the gateway's audit trail reads
`admin-key:platform-lead@example.com`. Automatic actions (a scheduled budget boost ending) use a separate key with id
`system:overrides`, so the trail tells people and the system apart.

```bash
terraform output -json admin_credentials                                           # initial passwords (sensitive)
terraform apply -replace='random_password.admin_password["finance@example.com"]'   # rotate one password
```

Add or remove an admin by editing the list and applying. `view_access = "admin"` makes even read-only views require an admin sign-in
(the default, `open`, lets anyone who can reach the app read usage; changes always need an admin).

## 5. Reaching the private services

Both services allow only authenticated Google identities (no `allUsers`). Claude Code accepts only a private or localhost gateway,
so the practical options are:

* **Local proxy** (default, `public_url = http://localhost:8891`): `terraform output -raw proxy_command | sh`, or
  `PROJECT_ID=... REGION=... deploy/proxy.sh`. It listens on `127.0.0.1` only (gateway `:8891`, budget app `:8892`), sends your Google
  identity token in `X-Serverless-Authorization`, and leaves the `Authorization` header (the gateway session token) untouched.
  Because every forwarded request carries *your* Google identity, the proxy is strict: `Host` must be exactly `localhost:<port>` or
  `127.0.0.1:<port>` (DNS-rebinding guard); a request with an `Origin` header is refused unless it is exactly
  `http://localhost:<port>` / `http://127.0.0.1:<port>`, and `Sec-Fetch-Site: cross-site` is refused **except for a top-level GET
  navigation** (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`), because the OIDC sign-in redirect from your identity
  provider back to `<public_url>/oauth/callback` is exactly that (and every later hop of a redirect chain that started cross-site keeps
  the `cross-site` label, so this is not limited by path). That exception is safe because a cross-site navigation cannot read the
  response and the gateway and budget app have no state-changing GET endpoints; fetch/XHR/images/scripts, iframes, form POSTs, any
  non-GET and any foreign `Origin` stay refused (a web page you have open cannot make blind requests with your identity; this is
  checked in real headless Chrome by `deploy/test/browser.test.mjs`); only origin-form request lines are accepted (absolute-URI proxy requests, `CONNECT`
  and websocket upgrades are refused); only an allow-list of request headers is forwarded (never `Cookie`, `Referer`, `Sec-Fetch-*`,
  `X-Forwarded-*`; add one with `PROXY_EXTRA_HEADERS=name1,name2`); it refuses to start when something already listens on the port;
  it never prints tokens (refusals are logged as a reason and method only, never the path, which can carry an OAuth code).
  **Limits you should know:** the proxy uses an *unscoped* `gcloud auth print-identity-token` token. It is replayable against any
  Cloud Run service your account may invoke, because tokens minted from user credentials cannot be audience-scoped, so treat the proxy
  process and the machine it runs on as holding your Cloud Run invoker identity. Behind an internal HTTPS load balancer or IAP the
  gateway sees the load balancer as the last hop of `X-Forwarded-For`, so the budget app's per-IP login bucket is shared by everyone
  behind it (per-account throttling still applies per person); `PROXY_REQUIRE_SECRET=header|path` additionally requires a random per-run secret (printed once at
  start-up) in an `X-Proxy-Secret` header or as a path prefix: useful on shared machines, but Claude Code cannot send the header, so
  it is opt-in. On a shared host any local user can still reach `127.0.0.1`: use a team load balancer instead. Each person who uses
  Claude Code runs it and needs `run.invoker`: admins get it from `admin_users`, others via
  `extra_invokers = ["group:eng@example.com"]` (only `user:`/`group:`/`serviceAccount:` followed by an email address and `domain:` followed by a DNS name
  are accepted; wildcards such as `domain:*`, empty values, `allUsers` and `allAuthenticatedUsers` are refused at plan time).
* **Team-wide**: put an internal HTTPS load balancer (or Cloud Run behind your VPN/IAP of choice) in front, set `public_url` to its
  `https://` hostname, and add that redirect URI to the OAuth client. Not provisioned here.

Engineers then install with `client/claude-gateway-setup.sh install --gateway-url '<public_url>'` (`terraform output client_install_hint`;
`terraform output client_defaults` is the JSON the installer reads, or set `write_client_defaults = true` to write `client/defaults.json`).
`public_url` is validated strictly because installers stamp it into scripts: `http://` only for `localhost`, `127.0.0.1` or `[::1]`,
otherwise `https://` with a plain DNS name (letters, digits, hyphens, dots), an optional port 1-65535, and nothing else (no path,
query, spaces, quotes, `$`, backticks, `;`, parentheses, `@`).

**Where the installer's trust comes from.** `scripts/package-client.sh --sign-key key.pem` can produce detached openssl signatures
for the packaged installer, but the trust in a packaged installer comes from *where you host it*: your own HTTPS site, a hash
published out of band (not next to the file), or your MDM. A `SHA256SUMS` file served next to the installer proves nothing against
someone who can replace both.

## 6. Models

[`config/models.json`](../config/models.json) is the single source of truth. Each entry has an `alias` (`sonnet`, `opus`, `haiku`),
the Vertex model `id`, label/tier/description, `enabled`, and optional `pricePerMTok`. `default` names the alias everyone starts on.
Terraform turns it into the gateway policy (`availableModels`, default first, `enforceAvailableModels`), pins
`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` for every engineer, and passes the catalog to the budget app as `MODELS_JSON`.

To add or retire a model: edit the file (set `"enabled": false` to retire), `terraform apply`. The plan fails with a readable message if
the default alias does not exist or is disabled, or ids/aliases repeat. The budget-app image also contains the file as a fallback;
Terraform's `MODELS_JSON` wins at runtime, so a rebuild is not needed.

## 7. Upstreams and failover

By default the gateway has one Vertex upstream (`vertex_region`, this project). To fail over across regions or projects:

```hcl
upstreams = [
  { region = "global" },
  { region = "us-east5" },
  { region = "global", project_id = "other-project" },
]
```

Terraform renders every entry into the gateway config. For a project other than `project_id` it also grants the gateway's service
account `roles/aiplatform.user` there (`upstream_project_iam = true`, the default; set it to `false` and grant it yourself if you lack
permission on that project). The Claude models must be enabled with quota in each region and project.

## 8. App state, usage tracking and the scheduler

* A private GCS bucket (`<project>-claude-gateway-state`: uniform access, public access prevention enforced, versioning, old versions
  expire) holds the budget app's state (budget overrides, ingest cursor). The app's service account has `roles/storage.objectUser`
  on that bucket only.
* Usage views come from the gateway's own request logs in Cloud Logging (`USAGE_SOURCE=logs`). **Residual exposure, stated plainly:**
  by default the app's service account holds `roles/logging.viewer` on the whole project, so it (and anyone who can run code as it)
  can read *every* log entry in the project, not only the gateway's; IAM conditions cannot narrow that role because the permission is
  checked against the project, not per log. The narrow alternative is opt-in: `scope_app_log_access = true` creates a log view
  limited to the gateway's Cloud Run logs on the `_Default` bucket, grants `roles/logging.viewAccessor` on that view only (with an IAM
  condition), removes the project-wide role and gives the app `USAGE_LOGS_VIEW=projects/<id>/locations/global/buckets/_Default/views/claude-gateway-logs`.
  It needs a budget-app release that queries that view (`resourceNames`) instead of `projects/<id>`; until then usage views would be
  empty, which is why it is off by default. Run the budget app in a project with only the gateway for the cleanest answer. Retention bounds how far back they reach: the default log retention is 30 days. `manage_log_retention = true`
  extends the **`_Default` log bucket of the whole project** to `log_retention_days` (400 in the production profile); it is off by
  default because it affects every service in the project and logs beyond 30 days are billed. Use it only in a project dedicated to the gateway.
* Cloud Scheduler (`claude-budget-tick`, every minute, `tick_schedule`) POSTs to `<app url>/api/internal/tick` with an OIDC token for the
  `claude-scheduler` service account. Cloud Run IAM admits only that identity and the admins, and the app verifies the token itself:
  signature against Google's keys, issuer, expiry, email equal to `SCHEDULER_SA` and audience equal to `SCHEDULER_AUDIENCE`. The
  audience is `https://claude-budget-tick.<project>.invalid`, registered on the app as a Cloud Run *custom audience* and passed to the app
  as `SCHEDULER_AUDIENCE` (the app's own URL cannot be used: the app's environment cannot refer to its own URL, a dependency cycle).
  The tick applies due budget overrides, reverts expired ones and ingests new usage.

## 9. Monitoring and alerts

`enable_monitoring = true` (default) creates email notification channels (`alert_emails`, default the admins), log-based metrics, alert
policies and a dashboard (`terraform output dashboard_url`).

| Alert | Intent | Fires when | Source |
|---|---|---|---|
| Gateway 5xx | the gateway or Cloud Run is failing requests | more than N 5xx in 5 min | Cloud Run `request_count`, `response_code_class=5xx` (sees what the gateway never logs) |
| Gateway 429 (Cloud Run level) | capacity or quota pressure | more than N 429 in 5 min | Cloud Run `request_count`, `response_code=429`. Counts every 429 the service returned: Cloud Run load shedding, Vertex quota relayed by the gateway and spend-cap refusals; use the other alerts to tell them apart |
| Gateway at maximum instances | scaling ceiling reached (the cause of Cloud Run's own 429s) | all `gateway_max_instances` running for 10 min (only when max > min) | Cloud Run `instance_count` |
| Gateway has no running instance | down or failing to start | no instance for 10 min (when min instances >= 1) | Cloud Run `instance_count` |
| Provider error burst | Vertex quota or an incident | more than N upstream errors in 5 min | log metric on `warn vertex upstream <4xx/5xx>` lines and inference events with status >= 500 (roughly double the failed requests) |
| Spend-cap blocks surge | budgets too tight, or someone looping against a cap | more than N refused requests in 15 min | log metric `evt="spend.blocked"` |
| Auth and admin denials | a guessing attempt or a misconfigured client or key | more than N in 15 min | log metrics: `auth.denied` **except** `reason=invalid_token`, `admin.denied`, `admin.login.failed` |
| Database CPU / disk / connections | database under pressure | above threshold (CPU sustained 10 min) | Cloud SQL metrics |
| Budget app 5xx | the app is failing | more than N 5xx in 5 min | Cloud Run `request_count` |
| Scheduler tick failing | overrides are not applied or reverted and usage is not ingested | more than N failed attempts in 10 min | log metric on `cloud_scheduler_job` errors |
| Boost overdue, cap NOT restored (critical) | a budget boost is past its end and the person still has the raised cap | 1 or more `override.overdue` in 10 min (logged every tick while it lasts) | budget-app log metric |
| Boost steps failing | gateway or store calls for a boost keep failing (retried next tick) | 5 or more `override.error` in 15 min | budget-app log metric |
| A boost could not start | a boost was not applied; the event's `reason` says why | 1 or more `override.failed` in 30 min | budget-app log metric |
| Boost claims being lost | two workers fight over boost items: clock trouble or more than one app instance | 5 or more `override.lost-claim` in 15 min | budget-app log metric |
| Boost created by a removed admin (warning) | an admin left, or the admin list has a typo, while their boost is active | 1 or more `override.creator-removed` in 1 hour (logged every tick per boost) | budget-app log metric |
| Override state unreadable (critical) | the stored override state cannot be read, so boosts can be neither started nor restored | 1 or more `overrides.store.error` in 10 min | budget-app log metric |
| Tick or usage ingest failing | the tick or the usage ingest is failing inside the app | 3 or more `tick.error` + `usage.ingest.error` in 15 min | budget-app log metrics |
| Scheduler tick missing (critical) | the app has stopped receiving scheduler ticks | no `tick` event for 5 min (absence condition; only with the default every-minute `tick_schedule`) | budget-app log metric `tick` |

Thresholds come from the profile; override with `alert_thresholds = { upstream_errors = 20, sql_connections = 40, gateway_429 = 50 }`
(`sql_connections` should be about 80% of your tier's `max_connections`). The budget-app event keys (`override_overdue`, `override_errors`, `override_failed`, `override_lost_claim`, `override_creator_removed`, `store_errors`, `tick_errors`, `tick_missing_minutes`) mean "N or more" (default 1 for the serious ones). The dashboard shows gateway and app request rate and
latency, Cloud Run-level 429/5xx, instances, Cloud SQL CPU/disk/connections and the log metrics, including the expired-token count.

### Budget boosts: when an alert fires

Boosts edit real spend caps unattended (they raise a person's cap at their start time and restore it at the end), so the budget app logs structured
JSON events on stdout and each of these has a log metric (resource `claude-budget-app`, `jsonPayload.evt`):
`override.overdue`, `override.error`, `override.failed` (payload has `reason`), `override.lost-claim`, `override.creator-removed`,
`overrides.store.error` (level error), `tick.error`, `usage.ingest.error`, plus `override.superseded` (a boost ended without a restore because the
cap was changed by hand meanwhile: dashboard counter only, no alert) and the `tick` heartbeat. The dashboard has widgets for all of them.

**Runbook** (critical and error alerts): open the budget app, **Activity** page, and compare each *active* boost's personal cap with its target
(the cap it should have been raised to). A boost past its end (`override.overdue`) must be **cancelled from the Activity page**, which restores
the previous limit, or the cap set back by hand; then look at why the restore failed (`override.error` events name the phase and the error: usually
the gateway being unreachable or the state bucket unreadable). For `overrides.store.error` check the state bucket `<project>-claude-gateway-state`
(permissions, a corrupted object; earlier versions are kept, see the restore runbook). For `override.creator-removed` decide whether the boost
should continue; cancel it from the Activity page if not, or fix the typo in `admin_users`.

**Scheduler tick missing.** The alert uses an *absence* condition on the app's `tick` log metric, so it is silent until the first tick after a deploy (a
series must exist before it can go missing) and it cannot be exercised offline: treat the first real firing, or a deliberate test (pause the
`claude-budget-tick` Cloud Scheduler job for 6 minutes), as its proof. It is created only for the default `tick_schedule = "* * * * *"`; with a
slower schedule it would fire constantly, so check by hand instead: the scheduler job's last run in the console, or the query
`resource.labels.service_name="claude-budget-app" AND jsonPayload.evt="tick"` in Logs Explorer should show an entry within one schedule interval.
The scheduler-failure alert covers ticks the app rejects (401/403); this one covers ticks that never arrive or are never logged.

The log metrics rely on the gateway's real event shapes (checked against `logs/gateway.log` and `tests/e2e/fixtures/gateway-sample.log`;
see `docs/ARCHITECTURE.md`):

* `{"evt":"spend.blocked","request_id","sub","cause":"over_limit","cap_cents","source","period"}`: a spend cap refused the request. The
  gateway writes **no** `inference` event for it, so the old filter (inference status 429 with an empty upstream) could never match.
* `{"evt":"inference",...,"status":N,"upstream":"vertex"}` for requests that reached Vertex; requests the gateway's policy rejects
  are logged with `"model":null` and `"upstream":null`.
* `{"evt":"auth.denied","reason":"invalid_token"}` is **routine**: it is logged for every expired session token (sessions last an hour).
  It is counted in its own metric for the dashboard and excluded from the denials alert; other reasons count.
* `{"evt":"admin.denied","reason":...}`, the text line `warn vertex upstream <status> request_id=...`, and the budget app's
  `{"evt":"admin.login.failed"}`.

If your Claude Code release logs differently, adjust the filters in `terraform/monitoring.tf`.

## 10. Costs (rough, monthly, check current Google pricing)

* Cloud SQL: `db-f1-micro` about $10; the production tier (regional `db-custom-1-3840`) is several times that.
* Gateway: warm instances are billed even when idle (a few dollars each).
* Budget app: scales to zero but wakes every minute for the tick; small.
* Cloud Scheduler: the first three jobs per billing account are free. Secret Manager, Artifact Registry, GCS state: cents.
* Logging: 50 GiB/month free per project, then per-GiB charges; retention beyond 30 days is billed per GiB-month.
* Monitoring: alert-policy conditions and log-based metrics are cheap but not free at scale.
* Vertex AI usage itself is the big line item and is what the budgets control.

## 11. State and security notes

* **Terraform state contains secrets** (database password, gateway keys, admin passwords, the OAuth secret). Use a private GCS backend
  (the recommended default: `./setup.sh` writes `backend.tf` and `--create-state-bucket` makes the bucket; or copy
  `terraform/backend.tf.example`), `terraform init -migrate-state`, and give only the people who run Terraform access. Never commit
  `terraform.tfvars`, `secrets.auto.tfvars` (both git-ignored), or any `*.tfstate`; CI runs `.github/scripts/secret-scan.sh` to catch
  credential shapes and forbidden files.
* Secrets also live in Secret Manager; Cloud Run services read them at start-up and no key files exist anywhere (service accounts use
  Application Default Credentials).
* Both Cloud Run services are `INGRESS_TRAFFIC_ALL` but unauthenticated callers get 403; there is no `allUsers` binding. Everyone with
  `run.invoker` (admins, `extra_invokers`) can open the budget app and, unless `view_access = "admin"`, read usage and budgets.
  Changing anything requires an admin sign-in; the app's own session token travels in `x-app-token` so the `Authorization` header stays free for IAM.
* The budget app uses admin keys on the gateway: the per-admin keys in `APP_ADMINS` and the `system:overrides` key. Treat the
  `claude-app-admins` and `claude-app-system-key` secrets as sensitive.
* **Per-admin keys and passwords exist in plaintext in three places, by design:** the Terraform state, the `claude-app-admins`
  secret (each admin's password and gateway write key, readable by the app's service account) and the `claude-gateway-config` secret
  (every write key, readable by the gateway's service account). Whoever can read the state bucket, or has
  `secretmanager.versions.access` on those secrets, or Owner/Editor on the project, can act as any admin. Keep the state bucket's
  access list to the people who run Terraform, and review who holds `roles/secretmanager.secretAccessor`. **Rotate one admin:**
  `terraform apply -replace='random_password.admin_password["a@example.com"]' -replace='random_password.admin_key["a@example.com"]'`
  (the new revision starts automatically, see "Operating"); remove an admin by deleting them from `admin_users` and applying. With
  `view_access = "open"` every invoker can read every person's usage and budgets; use `"admin"` if that is too open.
* Gateway write keys are written into the gateway config secret (the gateway reads its config from a file). Anyone with
  `secretmanager.versions.access` on that secret can read them.
* Cloud SQL has no public IP; only the gateway reaches it over the VPC.

## 12. Optional: let Terraform create the project

`create_project = true` with `billing_account` and exactly one of `org_id` / `folder_id` creates the project too, protected from
deletion (`deletion_policy = PREVENT`). While it is on, API quota is billed to your own gcloud quota project. The normal and
better-tested path is an existing project; this is a convenience.

## 13. Operating

* **Rotate**: `terraform apply -replace=random_password.jwt` (gateway session secret), `-replace=random_password.read_key`,
  `-replace=random_password.system_key`, `-replace=random_password.db` (database password: also changes the Cloud SQL user), or an
  admin's password/key as above. Both Cloud Run services carry a `SECRETS_HASH` environment variable, a digest of the values of every
  secret they consume, so a rotated secret (or an OAuth client secret filled in later, replacing the placeholder) creates a **new
  revision** that picks the new value up; `CONFIG_HASH` alone covered only the rendered config.
* **Upgrade Claude Code**: `IMAGE_TAG=<new release> deploy/build-push.sh`, set `gateway_image_tag`, apply.
* **Roll the budget app**: build, set `app_image_tag` to the new timestamp tag, apply.
* **Local checks**: `terraform/tests/run.sh` (offline, in a scratch copy) and `deploy/test/run.sh` (signature binding with throwaway
  keys, proxy, Dockerfile pins, secret scan).

## 14. Backup, restore and recovery runbook

* **What is backed up.** Cloud SQL (the gateway's spend ledger, limits and audit trail) has daily backups in both profiles; the
  `production` profile adds point-in-time recovery (PITR) and a regional replica. The app's state (overrides, ingest cursor) is in the
  versioned state bucket. Everything else is rebuilt from Terraform.
* **Restore the database to a point in time** (production): `gcloud sql instances clone claude-gateway-db claude-gateway-db-restored
  --point-in-time <RFC3339 time, UTC>`; check the clone; then either point the gateway at it (change `gateway-postgres-url`, bump
  nothing else: the secret's hash rolls the revision) or export what you need and import it into the original. A clone gets a new
  private IP in the same VPC. Without PITR (trial) restore from a backup: `gcloud sql backups list --instance claude-gateway-db` then
  `gcloud sql backups restore <ID> --restore-instance claude-gateway-db` (this *overwrites* the instance). Do this on a clone first
  when you can: restores are not reversible.
* **Restore the Terraform state** (bucket versioning is on): `gcloud storage ls -a gs://<state-bucket>/claude-gateway/` lists
  generations; `gcloud storage cp gs://<bucket>/claude-gateway/default.tfstate#<generation> gs://<bucket>/claude-gateway/default.tfstate`
  restores one. Run `terraform plan` before anything else and read it. Never edit state by hand to "fix" a plan.
* **Restore the app's state** (budget overrides, cursor): the same per object in `<project>-claude-gateway-state` (versions are kept
  for 10 newer versions or 90 days).
* **"The gateway is dead and engineers are locked out."** Claude Code is locked to the gateway by a managed policy on each machine
  (it only accepts that provider). If the gateway cannot come back soon, an administrator on each machine runs the installer's
  uninstall (`sudo bash client/claude-gateway-setup.sh uninstall`; `... print-lock-recovery` prints the steps): that removes the managed policy, so
  Claude Code works with its normal sign-in again. Then fix the gateway at leisure (`terraform plan`, Cloud Run revision logs,
  Cloud SQL status). Keep the installer, the uninstall command and a break-glass administrator reachable *outside* the gateway.
* **A bad revision**: Cloud Run keeps the previous revision serving when a new one fails its startup probe; roll back with
  `gcloud run services update-traffic claude-gateway --to-revisions <good>=100`, then fix the cause (usually a wrong image tag or a
  missing secret) and apply.

## 15. Teardown and the destroy path

```bash
# trial: db_deletion_protection is false (profile = "trial"); production: set db_deletion_protection = false and apply FIRST,
# because the database is protected at both the Terraform and the GCP level
terraform destroy
```

* `state_bucket_force_destroy` (true for trial) lets the state bucket be deleted with its contents; the Artifact Registry repository is
  deleted with its images; APIs stay enabled; secrets and the database are deleted for good (take a backup or clone first).
* The VPC peering (service networking connection) can fail to delete right after the database goes ("producer services still using
  this connection"): wait a few minutes and run `terraform destroy` again; it is retried safely.
* The remote state bucket created by `setup.sh --create-state-bucket` is **not** a Terraform resource: delete it yourself
  (`gcloud storage rm -r gs://<bucket>`) after the destroy, and only when you no longer need the history.
* A project created with `create_project` is protected: `terraform state rm 'google_project.this[0]'` then delete it with
  `gcloud projects delete`.

## 16. Supply chain

* `deploy/build-push.sh` verifies the Claude Code binary against Anthropic's GPG-signed manifest, and the trust anchor is the pinned
  **primary key fingerprint** (not a user id): `deploy/lib/verify-release.sh` lists the keys in the downloaded key file, requires the
  pinned one, exports *only* that key into a throwaway keyring and requires gpg's machine-readable `VALIDSIG` to name the pinned
  primary fingerprint and the signed manifest's `version` to equal the requested `IMAGE_TAG` (a replayed older manifest is refused; a signature by any other key, an expired or revoked key, or a tampered manifest is refused). Downloads use
  `curl --proto '=https' --tlsv1.2`, nothing is cached in your own keyring and any gpg-agent started is stopped.
* Base images (`node:22-slim`, `distroless/cc-debian12:nonroot`) are pinned by digest in the Dockerfiles; Dependabot's docker
  ecosystem proposes bumps. The app bundle is built with `npm ci` (lockfile only). The budget-app tests run on Node 22, the image's
  major, plus Node 23 as a canary. GitHub Actions are pinned by commit SHA with the release in a comment and Terraform is pinned
  in CI. CI runs a dependency-free secret scan (`.github/scripts/secret-scan.sh`).

## 17. Least-privilege Vertex role (optional, test first)

The gateway's service account holds `roles/aiplatform.user` on the Vertex project(s): broad (it can also create datasets, jobs and
endpoints). The least-privilege alternative is a custom role with only `aiplatform.endpoints.predict`, which is the permission that
`rawPredict`/`streamRawPredict` on publisher models checks. This cannot be verified without a real call, so it is not the default:

```bash
gcloud iam roles create claudeGatewayPredict --project <project> --title "Claude gateway predict" \
  --permissions aiplatform.endpoints.predict
# then in terraform.tfvars:
#   gateway_vertex_role = "projects/<project>/roles/claudeGatewayPredict"
```

Test before relying on it: apply, then make one real request through the gateway for each model (including a streaming one) and watch
the gateway's logs for `403 ... Permission 'aiplatform...' denied`; the denied permission is named in the error, add it to the role. To roll
back, set `gateway_vertex_role` back to `roles/aiplatform.user`. The variable applies to every upstream project too.

## 18. Troubleshooting

* *First apply fails creating Cloud Run*: the images are missing; do the two-phase apply (section 2).
* *"Set app_image_tag to the tag deploy/build-push.sh printed"*: expected until you set it (section 2); `latest` is refused.
* *"No value for required variable profile"*: set `profile = "trial"` or `"production"` in `terraform.tfvars` (section 2).
* *"Database connection budget exceeded"*: lower `gateway_max_instances`/`gateway_store_max_connections` or pick a bigger `db_tier`.
* *"Sign-in is using a PLACEHOLDER OAuth client"*: expected until section 3 is done; the next apply after you set the secret rolls the gateway.
* *Sign-in redirect_uri_mismatch*: the redirect URI in the OAuth client must equal `terraform output -raw oidc_redirect_uri` exactly.
* *Usage views are empty*: the logs source needs the budget app's log access (project-wide `roles/logging.viewer`, or the view with
  `scope_app_log_access`) and gateway traffic; check the app's logs.
* *The scheduler tick returns 401/403*: the scheduler's audience must equal the app's `SCHEDULER_AUDIENCE` and be one of its custom
  audiences (both are set by Terraform); check `claude-scheduler` still has `run.invoker` on the app.
* *403 opening a service*: you lack `run.invoker`; add yourself to `admin_users` or `extra_invokers`.
* *Plan errors mention models.json*: see section 6; the message names the problem.
