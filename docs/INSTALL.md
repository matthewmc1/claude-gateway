# Install guide

One path from "nothing" to "engineers use Claude Code through your gateway", for a company whose **gateway** must not be reachable from the
public internet. Read [Pick a topology](#1-pick-a-topology) first; everything else follows from that choice.

What is and is not public, honestly (the enterprise topologies):

| Part | Reachable from the internet? | What protects it |
|---|---|---|
| Gateway (Claude Code talks to it) | No: private IP and private DNS name behind an internal load balancer; Cloud Run ingress is "internal load balancer only" | the network path (VPN / Interconnect), the ingress setting, the gateway's own sign-in and keys. Cloud Run's **invoker IAM check is deliberately OFF** for the gateway (Claude Code cannot present a Google token), so there is no IAM layer behind the network one. Because ingress "internal load balancer only" would still admit callers inside the VPC (and on-prem hosts using Private Google Access) that use the service's `run.app` URL directly, Terraform also **switches that URL off** (`default_uri_disabled`); the gateway answers only through its load balancer. Treat everything that can reach the load balancer as inside the trust boundary |
| Budget app (admins and viewers, browser) | **Yes.** With `app_access = "iap"` the app is on a public `run.app` URL (or a public global load balancer with `app_domain`) | Google IAP sign-in plus the app's own signed-token check, admin list and CSRF rules. Anyone can reach the sign-in page; only the principals you grant `roles/iap.httpsResourceAccessor` get in |
| Trial topology (default) | No: both Cloud Run services require Google IAM and are reached through a local proxy | Google IAM |

"No public endpoints" is therefore true of the gateway and of the trial topology, not of the enterprise budget app.

> Status honesty: the pieces below are tested offline (unit, Terraform plan and end-to-end tests against the real gateway
> binary with emulated Google Cloud parts). **Nothing in the enterprise topology has been applied to a real project yet.**
> Every step that depends on Google behaviour we could not test is marked **(unverified until applied)**. Do a `trial`
> apply in a scratch project before a client rollout. Saved plans (`terraform plan -out`, `terraform show -json`) and the state
> contain secrets in clear (generated passwords, TLS keys): treat them like the state and never upload them as CI artifacts.

## 1. Pick a topology

| | **trial** | **enterprise** | **enterprise-domain** |
|---|---|---|---|
| Budget app (admins, browser) | private Cloud Run + local proxy `localhost:8892`, password sign-in | **IAP** on the `run.app` URL: Google sign-in, no proxy, no password | IAP behind your own domain (global external load balancer) |
| Gateway (engineers, Claude Code) | private Cloud Run + local proxy `localhost:8891` | **internal Application Load Balancer**, private IP, private DNS name, https | same as enterprise |
| Reaches engineers via | the proxy on every laptop | VPN / Interconnect to the load balancer subnet | same |
| Extra cost (estimate, per month) | none | about 18 USD + traffic | about 36 USD + traffic |
| Use it for | one admin trying it out | a team behind a private network | when the app needs a company URL |

Why the gateway can never sit behind IAP or a public address: Claude Code's `/login` refuses a gateway whose name resolves to a public
address (only private, link-local, CGNAT, ULA or loopback are accepted, or blocks you declare in the managed setting
`gatewayInternalNetworks`). It also pins the gateway's TLS certificate on first connect and refuses to go through an HTTPS proxy. IAP's
front end is public and the CLI cannot present IAP credentials, so the gateway gets a **private** address instead. The budget app is just a
website, so IAP fits it well.

The rule that keeps the app free of CORS/CSRF errors: **the origin in the browser, the `Host` header the app receives and the app's
allowed host/origin are always the same name.** With IAP there is no proxy in between to change it. Do not put another proxy or rewrite
rule in front of the app.

## 2. Prerequisites

* A Google Cloud project with billing enabled (Owner is simplest for the first run; see the IAP note below if users are outside your
  organisation) and these tools: `terraform` 1.5+, `gcloud`, `docker` (buildx), `node` 20+, `curl`, `gpg`, `jq`.
* `gcloud auth login` and `gcloud auth application-default login`. With `app_access = "iap"` the machine that runs `terraform apply` should also
  have `gcloud` with the beta component: Terraform runs `gcloud beta services identity create --service=iap.googleapis.com` once to create IAP's
  service agent (best effort; `iap_create_agent_with_gcloud = false` turns it off, see [step 4.6](#4-console-only-steps-terraform-cannot-do-these)).
* **Claude models enabled for the project** in Vertex AI Model Garden, with quota (see [section 7](#7-models-enable-sonnet-46-and-opus-46)).
* An identity provider for engineer sign-in (Google Workspace by default; Okta/Entra work). You create its OAuth client by hand
  (Terraform cannot): see [step 4](#4-console-only-steps-terraform-cannot-do-these).
* Enterprise only: a **private DNS name** you control (for example `claude-gateway.corp.example.com`) and a network path
  (VPN or Interconnect) from engineers' laptops to the project's VPC. Terraform creates the load balancer, a private DNS zone and an
  A record, but it cannot connect your network to Google. **Use a public top-level domain** in that name (`.com`, `.org`, ...): with
  Google as the sign-in provider, Google's OAuth consent rejects a redirect URI whose host is `.internal`, `.local`, `.lan` and similar.
  (Okta and Entra do not have this limit.) The name still resolves only privately.
* Enterprise with users outside your Google organisation (or a project with no organisation): the account that runs Terraform and the
  console steps also needs `roles/iap.settingsAdmin` and `roles/oauthconfig.editor`; Owner alone is not always enough for the IAP and OAuth consent steps.
* **Engineers' machines:** macOS or Linux with `python3` and `sudo` (the installer writes the system policy), and **Claude Code 2.1.285
  or newer** (`claude update`; the installer refuses older versions). Install Claude Code before the first `/login`. The Windows
  PowerShell installer exists but has never been run: prefer MDM for Windows.
* Terraform needs the **Google provider 7.30 or newer** (IAP on Cloud Run). Existing trial states created with 6.x must run
  `terraform init -upgrade` and **read the plan** before applying (see [Upgrading](#10-upgrading-and-rollback)).

## 3. Deploy

### 3a. Try it on your laptop first (no cloud)

```bash
./scripts/demo.sh                 # sample data, http://localhost:8792, admin: admin@example.com / demo-admin
./scripts/edge.sh up              # the enterprise topology on your laptop: IAP + internal load balancer emulators
./scripts/edge.sh status          # prints the URLs (app http://app.localhost:19330, gateway https://gateway.localhost:19331) and what answers
./scripts/edge.sh test            # runs the whole edge end to end test (needs Docker and Chrome)
./scripts/edge.sh down
```

`edge.sh up` needs: `node` 20+, the `claude` binary and `openssl` on PATH, a `.env` (run `scripts/setup.sh` once) and the compose
Postgres running (`docker compose up -d postgres`), or `EDGE_POSTGRES_URL` pointing at any Postgres. The default `demo.sh` needs none of that.

The emulators are not Google: they prove our code and configuration (sign-in, token validation, same-origin rule, CSRF refusal,
private https for the gateway), not Google's behaviour.

### 3b. Deploy to Google Cloud

```bash
cd terraform
./setup.sh --create-state-bucket
```

The wizard asks for the project, admins, sign-in domains, **profile** (`trial` or `production`, no default) and **topology**
(`trial`, `enterprise`, `enterprise-domain`). It asks only what the chosen topology needs and writes `terraform.tfvars`. For CI use flags:

```bash
./setup.sh --non-interactive --project my-proj --admins you@example.com --profile production \
  --topology enterprise --gateway-hostname claude-gateway.corp.example.com --viewers group:engineering@example.com
```

Or copy a ready-made example and edit it:
[`trial-iam`](../terraform/examples/trial-iam/), [`enterprise-iap-ilb`](../terraform/examples/enterprise-iap-ilb/),
[`enterprise-iap-custom-domain`](../terraform/examples/enterprise-iap-custom-domain/).

Without `--create-state-bucket` (or an existing `--state-bucket`) the wizard falls back to a **local** Terraform state file and says so:
that file then holds the generated passwords and keys, so do not do that for a real deployment. The region defaults to `europe-west2`
(`--region` changes it; see [section 7](#7-models-enable-sonnet-46-and-opus-46) for which regions serve Claude 4.6 upstream).

Then apply in the usual two phases (the images must exist before Cloud Run can start):

```bash
terraform init -upgrade
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
PROJECT_ID=<project> REGION=<region> ../deploy/build-push.sh     # prints the app image tag
terraform apply -var app_image_tag=<that tag>                    # the database takes 10-15 minutes
terraform output edge_next_steps                                  # enterprise: exactly what is left to do by hand
```

Key variables (full list in `terraform/variables.tf` and `edge_variables.tf`):

| Variable | Meaning |
|---|---|
| `app_access` | `"iam"` (default, trial) or `"iap"` |
| `app_domain` | optional custom domain for the app (needs `app_access = "iap"`); `null` = IAP directly on the `run.app` URL |
| `app_viewers` | who may open the app besides the admins: `user:`, `group:` or `domain:` members. Everyone who passes IAP and is not an admin can read **all per-person usage and e-mails** while `view_access = "open"`, so a `group:` or `domain:` entry gives all its members that; use specific `user:` entries or `view_access = "admin"` if that is too broad |
| `gateway_exposure` | `"run_app"` (default) or `"internal_lb"` |
| `gateway_hostname` | the private name engineers use; `public_url` is derived as `https://<hostname>` |
| `gateway_tls` | `{ mode = "self_signed" }` (default; **a trial option**, see [section 5 step 2](#5-roll-out-to-engineers)) or `{ mode = "provided", cert_pem = "...", ca_pem = "..." }` (your corporate PKI, recommended for production). `cert_pem` (leaf then intermediates) is required; **`ca_pem` is what the budget app trusts** when it calls the gateway, so give it whenever the certificate is not from a public CA |
| `gateway_tls_key_pem` | **sensitive.** The private key of `gateway_tls.cert_pem`, required with `mode = "provided"`. Put it in a git-ignored `*.auto.tfvars` or `export TF_VAR_gateway_tls_key_pem=...`, never in a committed file (it used to be `gateway_tls.key_pem`; that field is gone) |
| `gateway_tls_early_renewal_hours` | self-signed only; `0` (default) = the 1-year leaf is replaced only after it has expired, never silently (a new leaf makes Claude Code re-pin). See [section 5 step 2](#5-roll-out-to-engineers) |
| `lb_subnet_cidr`, `proxy_only_subnet_cidr`, `lb_ip` | the load balancer's network; defaults (`10.0.1.0/24`, `10.0.2.0/23`) are fine unless they overlap yours. Rules below the table |
| `gateway_allow_cidrs`, `gateway_internal_networks` | optional client-address allow-list for the gateway (section 5 step 3) and the ranges for Claude Code's `gatewayInternalNetworks` MDM text |
| `app_security_policy` | optional, only with `app_domain`: name of an existing Cloud Armor policy (for example your office/VPN ranges) to attach to the custom-domain load balancer; without it IAP alone protects that public address |
| `iap_create_agent_with_gcloud` | default `true`: Terraform runs `gcloud beta services identity create --service=iap.googleapis.com` before granting IAP's service agent `run.invoker` (failure is ignored). `false` skips it |
| `analytics` | `"logging"` (default) or `"bigquery"`: two datasets, a log sink and an analyst view; see [BigQuery analytics](#bigquery-analytics-optional) |

Address rules (all checked at plan time): `lb_subnet_cidr` and `proxy_only_subnet_cidr` must lie in private space (`10/8`, `172.16/12`,
`192.168/16`, `100.64/10`), be network-aligned with valid octets, and overlap neither each other nor `cc-gateway-subnet` (`10.0.0.0/24`) nor
the `/16` that Google allocates for Cloud SQL (Terraform compares it after the first apply). `lb_subnet_cidr` is `/24` to `/29`;
`proxy_only_subnet_cidr` is `/22` to `/26` (it is a trusted `X-Forwarded-For` source, so keep it small). `lb_ip`, if set, must be inside
`lb_subnet_cidr` and not one of its first or last two addresses. `gateway_hostname` and `app_domain` must be different names. Use
`lb_subnet_cidr` for the load balancer only: its range is trusted for forwarded client addresses.

**First-apply ordering (unverified until applied).** With `app_domain`, the load balancer's serverless NEG is created before the Cloud Run
service it names (a reference would be a dependency cycle). If Google refuses that, set `app_domain = null`, apply, set it again and apply
(`edge_next_steps` step A1b says the same).

**Extra monthly cost (estimates from list prices):** internal load balancer about 18 USD plus 0.008 USD per GB; its private DNS zone about
0.2 USD plus 0.40 USD per million queries; custom-domain load balancer about 18 USD; the tick Cloud Run job (`app_access = "iap"`) about
1 vCPU-second x 1440 a day, roughly 0 to 5 USD; BigQuery storage about 0.02 USD per GB-month, streaming inserts about 0.05 USD per GB, queries
billed to whoever runs them. `terraform output edge_next_steps` ends with the same estimate for your topology.

### BigQuery analytics (optional)

`analytics = "bigquery"` routes the gateway's logs to BigQuery for analysts and Looker Studio; the budget app keeps reading Cloud Logging. There
are **two datasets**: `claude_gateway_logs` holds the raw log tables (every gateway field, including client addresses and e-mails; only project
owners/editors and the log sink can read it; partitions expire after `analytics_retention_days`, default the profile's `log_retention_days`, 30 for
trial and 400 for production) and `claude_gateway_analytics` holds the view `v_gateway_requests` as an **authorized view**. Related variables:

| Variable | Meaning |
|---|---|
| `analytics_readers` | `user:`/`group:`/`serviceAccount:`/`domain:` members who get `roles/bigquery.dataViewer` on the analytics dataset only, plus `roles/bigquery.jobUser` on the project to run queries. Empty (default): only project owners/editors can query |
| `analytics_retention_days` | days of raw data kept (1 to 3650); default the profile's `log_retention_days` |
| `analytics_include_emails` | default `false`: no e-mail column, analysts see the opaque `sub`; `true` adds it (personal data) |
| `analytics_view` | the second step: BigQuery creates the log table only when the first request arrives, so send one request through the gateway, then set `analytics_view = true` and apply again (`terraform output analytics_next_steps`) |

The view excludes `spend.blocked` events, so it undercounts requests refused for a cap.

## 4. Console-only steps (Terraform cannot do these)

`terraform output edge_next_steps` prints this list with your values filled in. In short:

1. **Engineer sign-in client (always).** Cloud Console, APIs & Services, Credentials, Create OAuth client ID, type *Web application*.
   Authorised redirect URI: `terraform output oidc_redirect_uri` (enterprise: `https://<gateway_hostname>/oauth/callback`).
   Put the client id in `oidc.client_id` and the secret in `TF_VAR_oidc_client_secret`, then apply. The host of this redirect URI must
   be exactly the gateway's `public_url` host.
   The redirect host must be on a **public top-level domain** (Google refuses `.internal`, `.local`, `.lan`), see [Prerequisites](#2-prerequisites).
2. **IAP consent screen (enterprise).** Google Auth Platform, Branding: *Internal* if everyone is in your Google Workspace /
   Cloud Identity organisation; otherwise *External* and add every admin and viewer as a **test user** (individual accounts only: a
   `group:` or `domain:` member in `app_viewers` cannot be a test user). Skipping this shows a Google
   sign-in error instead of the app. A project with no organisation (such as a personal trial project) needs the External option.
3. **OAuth client for IAP (enterprise-domain only).** Create a *Web application* client with the redirect URI printed in
   `edge_next_steps` (step A3), then set `iap_oauth_client_id` and `TF_VAR_iap_oauth_client_secret` and apply again.
4. **DNS and certificate (enterprise-domain).** Create the A record `app_domain` -> `terraform output app_lb_ip`; the managed
   certificate becomes ACTIVE within about an hour.
5. **Network path (enterprise).** Make `gateway_hostname` resolve from laptops to the load balancer IP (`terraform output gateway_lb_ip`):
   forward the private zone through your resolvers, over VPN or Interconnect. Terraform cannot do this.
6. **IAP service agent (first IAP apply only).** Terraform first tries that itself (`iap_create_agent_with_gcloud`, local `gcloud` with the beta
   component, failure ignored). If the apply still stops with "service account ... does not exist", run
   `gcloud beta services identity create --service=iap.googleapis.com --project=<project>` by hand and apply again.

## 5. Roll out to engineers

**Enterprise first: make the name reachable.** `gateway_hostname` must resolve to the load balancer's private IP (`terraform output gateway_lb_ip`)
on every engineer's laptop, and that address must be routable from there. Terraform creates a private Cloud DNS zone for exactly that name, but it is
visible only to machines that use the VPC's DNS (Cloud Run, VMs), not to laptops. Either add the same A record in your corporate DNS or forward
queries for the name to Cloud DNS (inbound server policy), over your VPN or Interconnect (`edge_next_steps` step B1). Clients in another region
of the VPC need `lb_allow_global_access = true`. Check from a laptop on the VPN: `dig +short <gateway_hostname>` returns the private address.

1. Package the installer with your gateway address baked in (it also bakes in the model catalog, so **rebuild and redistribute it every time
   `config/models.json` changes**, [section 7](#7-models-enable-sonnet-46-and-opus-46)):
   ```bash
   cp config/models.json client/models.json                                              # keep the two copies identical (the client tests check it)
   scripts/package-client.sh --gateway-url https://claude-gateway.corp.example.com      # trial: http://localhost:8891
   ```
   Host `dist/client/` on your own HTTPS site or push it with MDM, and publish its SHA-256 somewhere else ([trust model](../client/README.md#trust-model-read-this-before-you-distribute-the-installer)).
2. **Trust the gateway's certificate (enterprise).** Two ways:
   * **`provided` (recommended for production):** `gateway_tls = { mode = "provided", cert_pem = "...", ca_pem = "..." }` with a certificate from your
     corporate PKI (already trusted on managed machines) and the key in the separate sensitive variable `gateway_tls_key_pem` (a git-ignored
     `*.auto.tfvars` or `TF_VAR_gateway_tls_key_pem`; the `gateway_tls` object itself holds no secret). Give `ca_pem` too: the budget app trusts only
     that PEM (or Terraform's generated CA) when it calls the gateway. No CA key exists in the Terraform state.
   * **`self_signed` (default; a trial option):** Terraform creates a CA (5 years, may sign leaf certificates only) and a leaf for `gateway_hostname`
     (1 year). Distribute the CA (`terraform output -raw gateway_ca_pem`) to engineers' machines through your normal MDM. **Do this only if you accept that the Terraform
     state is a fleet-wide trust root:** the CA's private key is in the state (and in any saved plan) and the CA cannot be restricted to the gateway's
     hostname (the `tls` provider has no name constraints), so whoever can read the state can mint a certificate for ANY site that the machines trusting the CA accept.
   Claude Code additionally **pins the gateway's leaf certificate** on first connect (the `/login` prompt shows the first 16 hex characters
   of the SHA-256 fingerprint). Publish the full fingerprint next to the URL. From a machine on the VPN, for the certificate the gateway really serves:
   ```bash
   openssl s_client -connect claude-gateway.corp.example.com:443 -servername claude-gateway.corp.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr -d : | tr 'A-F' 'a-f'
   ```
   (or `openssl x509 -noout -fingerprint -sha256 -in cert.pem | ...` on the certificate file). **The self-signed leaf is not renewed automatically**
   (`gateway_tls_early_renewal_hours = 0`; a silent renewal would make every engineer re-pin). `terraform output gateway_cert_expires` is the expiry date; any
   plan warns during the last 60 days (once a state exists). Rotate on purpose, after announcing the new fingerprint:
   `terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]'`; after expiry the next apply replaces it. A lapsed certificate does **not** trip the 5xx alerts
   (the failure never reaches Cloud Run's metrics, and no Terraform alert watches the load balancer or certificate expiry): put the date in a calendar and probe
   `https://<gateway_hostname>/healthz` from inside your network. A rotation shows every engineer the trust prompt again. **(unverified until applied)**
3. **If your internal network is numbered from public IPv4 space you own**, Claude Code refuses the gateway unless the managed setting
   `gatewayInternalNetworks` declares the block (Claude Code 2.1.268+). It is honoured **only** from a managed source on the machine
   (`managed-settings.json`, MDM profile, registry policy), **not** from the gateway's own policy and not from user settings, so Terraform
   cannot deliver it. Pick one:
   * **With the installer (simplest):** put the blocks in `client/defaults.json` (`"gatewayInternalNetworks": ["198.51.101.0/24"]`), rebuild
     with `package-client.sh`; `install`/`update` write the key into the system policy, and `status`/`install` stop calling that gateway "public".
     The installer validates the list with Claude Code's own rules (at most 4 IPv4 blocks, first address plus `/8`..`/32`, no overlap, nothing
     overlapping private, documentation, reserved or multicast space): a list Claude Code rejects would block **every** gateway sign-in on the machine.
   * **With MDM:** deploy the whole policy yourself (`claude-gateway-setup.sh print-managed` prints it, including the blocks when `defaults.json`
     declares them; `terraform output edge_next_steps` prints the same `gatewayInternalNetworks` text from `gateway_internal_networks`). Registry or plist
     policies replace the file rather than merge, so put all keys in the same mechanism.
   Keep the gateway unreachable from outside your network (Anthropic's warning). Optionally restrict who may call it with `gateway_allow_cidrs`
   (rendered as the gateway's `access_control.allow_cidrs`): list your engineers' VPN/office ranges, **not** the load balancer's. It is judged on the
   client address the gateway resolves from `X-Forwarded-For`, IPv4 only, `/0` is refused, and it is valid only with `gateway_exposure = "internal_lb"`;
   `cc-gateway-subnet` (`10.0.0.0/24`, where the budget app and the tick job call from) is added automatically so the app is not locked out.
   **A wrong list answers 403 `ip_not_allowlisted` to everyone** (only `/healthz` and `/readyz` are exempt), so first look at `client_ip` in the gateway's first
   audit events. That field is per engineer because the gateway trusts `X-Forwarded-For` from the Cloud Run front end (`169.254.0.0/16`), the load balancer's address
   (`lb_subnet_cidr`, or `lb_ip`/32 when pinned) and the proxy-only subnet (`terraform output effective_settings` shows `gateway_trusted_proxies`); the exact hop layout
   comes from Google's and the gateway's documentation and is **not verified live**. A request from a non-private address raises the alert "Claude gateway: request from a non-private address" (the gateway's `access.public_client` event).
   An address in CGNAT `100.64.0.0/10` needs none of this (Claude Code accepts it); documentation ranges such as `203.0.113.0/24` are always refused.
4. Engineers run, with no arguments:
   ```bash
   ./claude-gateway-setup.sh install
   claude          # /login -> "Cloud gateway" -> sign in with the work account
   ```
   The installer sets the gateway (`forceLoginMethod=gateway` and the gateway URL), locks sign-in to it, blocks direct Anthropic/Vertex/API-key use and
   writes the model list. (The printed `forceLoginGatewayUrl` JSON in `terraform output edge_next_steps`, step B5, is only for MDM-only deployments that skip the installer.) To
   test it safely first: `CLAUDE_MANAGED_DIR=/tmp/m CLAUDE_USER_DIR=/tmp/u HOME=/tmp/h ./claude-gateway-setup.sh install --yes`.
5. If engineers use `HTTPS_PROXY`, add the gateway host to `NO_PROXY`: `/login` sign-in refuses a gateway when a proxy applies to it
   (and, when the proxy host itself is not private, refuses the proxy too).
6. **When the gateway is retired**, engineers stay locked to it until the policy is removed. Tell them to run
   `sudo bash claude-gateway-setup.sh uninstall` (`print-lock-recovery` prints the steps; `--force` also removes values that were changed since), or push the
   change through MDM, **before or when** you destroy the deployment ([section 10](#10-upgrading-and-rollback)).

## 6. Open the budget app

* **trial:** `terraform output -raw proxy_command | sh`, then http://localhost:8892 (admin sign-in appears when you change something).
* **enterprise:** open `terraform output app_url` in a browser. Google (IAP) signs you in; anyone in `app_viewers` sees data read-only,
  admins (the `admin_users` list) can change budgets. No password, no proxy. The URL is Cloud Run's deterministic host
  `https://claude-budget-app-<project number>.<region>.run.app`, and **people must use exactly that one**: the app admits only that host (no `.run.app`
  wildcard in IAP mode), so the older hash-style `...-xx.a.run.app` URL of the same service answers `400 bad host`.
* **enterprise-domain:** open `https://<app_domain>`.

If something fails, see [Troubleshooting](#9-troubleshooting).

## 7. Models: enable Sonnet 4.6 and Opus 4.6

The catalog (`config/models.json`) contains Sonnet 5.5, Opus 5.5, Haiku 5.5 **and** Sonnet 4.6 (`claude-sonnet-4-6`) and Opus 4.6
(`claude-opus-4-6`). 5.5 stays the default; 4.6 is allowed for everyone. Changing the catalog needs a `terraform apply` (the gateway
policy, engineer aliases and the app all follow) **and** a rebuilt installer (below).

**How the default model is decided.** The gateway policy (`gateway.yaml`, delivered when Claude Code signs in) lists every enabled model in
`availableModels` (default first) and also sets `model` to the default explicitly. This matters: per Anthropic's gateway documentation,
`availableModels` on its own does not change a gateway session's default (that is the Opus the `opus` alias resolves to); `model` does. Per
Anthropic's settings precedence a policy-level `model` outranks the `model` in a person's own `~/.claude/settings.json`. So **the installer's
`model`, `upgrade`, `downgrade` and `reset` commands and `install --model` no longer decide which model a gateway session starts on**: they only
edit the personal file (which the installer still fills as a fallback for gateways whose policy sets no `model`). People switch models inside
a session with `/model`, or start one with `claude --model <id>`. **(precedence and `--model` behaviour: from the docs, unverified until applied)**

### Step 1: make the models available in Google Cloud

1. In the Cloud Console open Vertex AI, Model Garden, find *Claude Sonnet 4.6* (and *Opus 4.6*), and **Enable** them for the project.
2. Check quota for the region you use (quota names look like `global_online_prediction_requests_per_base_model`; Google's
   published defaults for 4.6 are 1,500 requests/min for Sonnet (1,800 in `europe-west1`) and 200 for Opus, 400 for Opus on the global endpoint).
3. Pick the region carefully. Claude 4.6 is served from **`global`**, `us-east5`, `europe-west1` and `asia-southeast1`. It is **not**
   served from `europe-west2`. Cloud Run and Cloud SQL may live anywhere; the Vertex *upstream* region is `vertex_region`
   (default `global`, which is right). Terraform warns (`check`) if an upstream region is not in that list while 4.6 is enabled; set
   `"enabled": false` on the two 4.6 entries if you never use them and want the warning gone.

### Step 2: choose who gets which model

| Goal | What to do |
|---|---|
| Allow 4.6, keep 5.5 as the default (the shipped state) | nothing; run `terraform apply` after pulling this version |
| **Run Sonnet 4.6 as the default for everyone** | the recipe below |
| Remove 4.6 | set `"enabled": false` on the two 4.6 entries; `terraform apply`; rebuild the installer |

`pin: true` means the `sonnet`/`opus` aliases that Claude Code uses resolve to that model for every engineer; at most one entry per family
may be pinned, an invalid catalog stops both Terraform and the installer before anything is written, and a family that has entries but no
pin is flagged (the Models page, the installer and the API all warn: `/model sonnet` would use Claude Code's own version, which may not be allowed).

**Recipe: Sonnet 4.6 (and Opus 4.6) as the default for everyone.** In `config/models.json`:

1. `"default": "sonnet-4-6"`.
2. `"pin": true` on `sonnet-4-6` and `opus-4-6`; `"pin": false` on `sonnet` and `opus`.
3. Swap the `tier` values so the cards, descriptions and the `upgrade` step follow: `sonnet-4-6` gets `"default"` and `sonnet` gets `"previous"`;
   `opus-4-6` gets `"upgrade"` and `opus` gets `"previous"`. Reword the `description` strings to match (they are shown to every engineer).
4. `cp config/models.json client/models.json`, then `terraform apply` (the gateway policy now starts everyone on Sonnet 4.6 and the aliases follow the pins).
5. **Rebuild and redistribute the installer:** `scripts/package-client.sh --gateway-url https://<gateway>`. A stamped installer carries its own copy of the
   catalog and ignores everything else, so an installer built before this change still has the old catalog: it does not know the 4.6 names for `model sonnet-4-6`
   and `update` with it is a no-op.
6. Tell engineers to run the **new** installer's `update` (refreshes the machine policy: model list and pins). The starting model comes from the gateway policy
   you just applied, so nothing else is needed; if someone set a personal model earlier, `downgrade` (or `reset`, which also resets effort) tidies their own file but
   does not change what a session starts on. Leave `model` out of `client/defaults.json`: a `model` there overrides the catalog default in the personal file.

### Step 3: what engineers do for Sonnet 4.6

While 5.5 is the company default, a session starts on Sonnet 5.5. To use 4.6, switch on purpose:

```bash
claude --model claude-sonnet-4-6                 # start a session on 4.6 (any catalog id works)
/model                                           # inside Claude Code: lists everything the catalog allows; pick Sonnet 4.6
./claude-gateway-setup.sh model sonnet-4-6       # also writes it to my personal settings (alias or id; see the precedence note above)
```

The installer's `upgrade` means the first catalog entry with tier `upgrade` (Opus 5.5 until the recipe's tier swap, then Opus 4.6); `model opus-4-6` and
`model opus` choose a specific entry by name. All of these edit only the personal file. The admin app's **Models** page shows each model, who uses it,
any unpinned-family warning and the recipe.

## 8. Verify end to end

| Check | Command / what to see |
|---|---|
| Plan is clean | `terraform plan` shows no unexpected destroy/replace |
| Gateway private | from a laptop on the VPN: `curl -s -o /dev/null -w '%{http_code}\n' --cacert claude-gateway-ca.pem https://<gateway_hostname>/healthz` -> 200 (`terraform output -raw gateway_ca_pem > claude-gateway-ca.pem`; with a corporate CA that is already in the OS store the `--cacert` is not needed); from outside: no answer |
| Gateway not public | `dig +short <gateway_hostname>` returns only private addresses. The gateway's own `run.app` URL is switched off (`default_uri_disabled`): `gcloud run services describe claude-gateway --region <region> --format='value(status.url)'` may print nothing, and a request to a `run.app` address is refused (403 or 404; **unverified until applied**). Smoke-test only with `https://<gateway_hostname>` |
| Client addresses | the first audit events show each engineer's own `client_ip`, not the load balancer's (from Google's docs, not verified live). Check it before you set `gateway_allow_cidrs` |
| Sign-in works | `claude`, `/login`, *Cloud gateway*: browser opens `https://<gateway_hostname>/device`, redirects to your IdP, back to the gateway |
| App through IAP | `terraform output app_url` opens after Google sign-in; the header shows a chip with your name, and its popover reads "Signed in as <your email> via your company sign-in" (admins can change budgets; everyone else: "Viewer: read-only") |
| Admin write | change a budget as an admin: succeeds; as a viewer: "only admins can change budgets" |
| Models | `terraform output effective_settings` lists the models; `/model` in Claude Code shows them |
| Usage visible | send a request in Claude Code; the person appears under *People* within a minute or two |
| Tick runs | `app_access = "iap"`: `gcloud run jobs executions list --job=claude-budget-tick --region=<region>` shows a run each minute. Trial (`iam`): there is no job; Cloud Scheduler calls the app (Cloud Console, Cloud Scheduler) |
| Alerts | no Terraform output lists them: Cloud Console, Monitoring, Alerting shows the policies (`terraform output dashboard_url` links the dashboard, `terraform output effective_settings` shows `alert_emails`, who gets email). With `internal_lb`, one of them, "Claude gateway: request from a non-private address", fires on the gateway's `access.public_client` event. **None watches load balancer health, an unhealthy backend or TLS/certificate expiry** (those metric names could not be checked offline): probe `https://<gateway_hostname>/healthz` from inside your network and keep `terraform output gateway_cert_expires` in a calendar |

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/login` says the gateway address is not private | the name resolves to a public address. Use the internal load balancer name; or declare your owned block in `gatewayInternalNetworks` |
| `/login` fails on TLS | the CA is not trusted on that machine (self-signed mode): distribute `gateway_ca_pem` or use `gateway_tls = { mode = "provided", cert_pem, ca_pem }` plus `gateway_tls_key_pem` with your corporate PKI. If it worked for a year and then stopped, check `terraform output gateway_cert_expires`: the self-signed leaf is not renewed automatically (section 5 step 2) |
| Every request answers 403 `ip_not_allowlisted` | `gateway_allow_cidrs` does not contain the client addresses the gateway resolves (check `client_ip` in its audit events; the list is judged on the client, not on the load balancer). Fix the list and apply; `/healthz` and `/readyz` stay open |
| Alert "request from a non-private address" | the gateway saw a client with a public address (`access.public_client`): a misrouted path, a proxy in front, or something that should not reach the load balancer. Find the source before widening anything |
| Budget app answers `400 bad host` on a `run.app` URL | with `app_access = "iap"` the app admits only `claude-budget-app-<project number>.<region>.run.app` (or `app_domain`), exactly what `terraform output app_url` prints. Use that URL, not the older hash-style `...-xx.a.run.app` address of the same service |
| `/login` refuses a proxy | add the gateway host to `NO_PROXY` (a proxy that applies to the gateway host blocks sign-in; a non-private proxy host is refused outright) |
| Browser: "cross-origin request refused" (403) | the browser origin and the host the app sees differ: something is rewriting the host. Remove the proxy/rewrite in front of the app; with `app_domain` set, use only `https://<app_domain>` |
| Browser: 403 on a write, reads fine | you are signed in but not an admin: add your email to `admin_users` and apply |
| Browser: 401 / Google error page | IAP consent screen missing, or you are not in `app_viewers`/admins (`roles/iap.httpsResourceAccessor`) |
| Google "redirect_uri_mismatch" at engineer sign-in | the OAuth client's redirect URI differs from `https://<gateway_hostname>/oauth/callback` in scheme, host or path |
| Google refuses to save the OAuth client / "invalid redirect" for a `.internal`, `.local` or `.lan` host | Google OAuth accepts only redirect hosts on a public top-level domain: rename the gateway to such a name (it can still resolve only privately) |
| App shows the gateway unreachable | either the app cannot resolve/route to the load balancer (check the VPC egress and the private DNS zone; `GATEWAY_URL` must be the same name as `gateway_hostname`), **or TLS fails**: with `gateway_tls.mode = "provided"` and a private corporate CA the app only trusts what you give in `gateway_tls.ca_pem` (Terraform warns with `gateway_tls_ca_for_app`); add `ca_pem` and apply |
| Engineers still land on Opus / an old model list after you changed the catalog | the gateway needs `terraform apply`; their machines need the **rebuilt** installer's `update` (a new `package-client.sh` build; the old file keeps the old catalog) |
| Apply stops: "service account does not exist" (IAP agent) | step 4.6 above (Terraform already tried `gcloud beta services identity create`; it needs `gcloud` with the beta component on the applying machine, or run it by hand) |
| Apply stops on `invoker_iam_disabled` | your organisation policy forbids disabling the invoker check; an administrator must allow it for this service (Terraform has no public fallback by design) |
| Model call fails with 404/403 from Vertex | the model is not enabled for the project, or quota is missing in that region (section 7) |

## 10. Upgrading and rollback

* **Provider bump.** This version needs `hashicorp/google ~> 7.30` and adds `hashicorp/tls`. Run `terraform init -upgrade`,
  then `terraform plan` and **read it**: expect new provider-default attributes, `app_scheduler` moving to `app_scheduler[0]`, a new
  `terraform_data.edge_checks` (created, no cloud effect) and new gateway and app revisions (the catalog and policy changed). No resource
  should be destroyed in the trial topology. We could only compare plans offline.
* **Provider bump, rehearsed.** Before the real apply, plan on a copy of your state with the recipe in [DEPLOY.md section 11](DEPLOY.md#enterprise-edge-operating-and-security-notes-iap-internal-load-balancer-bigquery)
  ("Upgrading an existing deployment to the 7.x Google provider"), then run `terraform apply -refresh-only` on the real directory. The plan list must contain **no** `delete,create`
  line for `google_sql_database_instance.main`, `google_cloud_run_v2_service.*` or `google_secret_manager_secret.*`.
* **Saved plans and state are secrets.** `terraform plan -out` and `terraform show -json` contain sensitive values in clear (generated passwords, TLS keys); only the
  human-readable plan is redacted. Keep them out of CI artifacts and tickets.
* **Self-signed certificate:** the leaf is not renewed automatically. Note `terraform output gateway_cert_expires`, and rotate on purpose with
  `terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]'` after announcing the new fingerprint (section 5 step 2).
* **`client_defaults` output** changed shape (`gatewayUrl, model, effortLevel, userSettings`). If you wrote `client/defaults.json` with `write_client_defaults` on an older
  version, regenerate it before the next `package-client.sh`.
* **Back to trial:** remove `app_access`, `gateway_exposure`, `gateway_hostname` (and `app_domain`) and plan before applying. After the apply, **verify Cloud Run enforces IAM again**:
  `curl -s -o /dev/null -w '%{http_code}\n' "$(gcloud run services describe claude-gateway --region <region> --format='value(status.url)')/healthz"` must print `403`
  (see [DEPLOY.md section 11](DEPLOY.md#enterprise-edge-operating-and-security-notes-iap-internal-load-balancer-bigquery)).
  Changing the gateway's public URL changes the OAuth redirect URI and every engineer's installer: plan it as a rollout, not a toggle.
* **Teardown:** [DEPLOY.md section 15](DEPLOY.md#15-teardown-and-the-destroy-path). Remove the engineers' lock first or at the same time
  ([section 5, step 6](#5-roll-out-to-engineers)): until the system policy is removed, Claude Code on their machines can only sign in to the gateway.

## 11. What is verified and what is not

| Verified (automated, offline) | Unverified until you apply |
|---|---|
| IAP token validation, same-origin and CSRF rules in the app, tests with generated keys | real IAP on Cloud Run (`iap_enabled`, launch stage), the consent screen behaviour |
| Terraform plans for all three topologies, validations, example files | the internal load balancer with a serverless backend, DNS from Cloud Run, `invoker_iam_disabled` and `default_uri_disabled` in your org, the first-apply ordering (IAP service agent, the app load balancer's NEG), the `X-Forwarded-For` hop layout behind Cloud Run, the BigQuery sink and authorized view |
| The gateway config parses in the real `claude gateway` binary | Claude Code's private-address check, certificate pinning and CA trust against our certificates |
| Whole chain locally with emulators and real headless Chrome | a real Claude reply through Vertex (needs Model Garden access and quota) |
| Installer on macOS/Linux | the PowerShell installer |
