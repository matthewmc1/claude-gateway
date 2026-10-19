# Google sign-in (OAuth) for the gateway

Engineers sign in to the gateway with Google through OpenID Connect. Google will not let Terraform or any API create the
"Web application" OAuth client that this needs, so you create it once by hand (about 3 minutes). This page is everything you need to do
that correctly, in order, for each topology. If something goes wrong in the browser, jump to [Troubleshooting](#troubleshooting).

What Terraform checks for you at `terraform plan` (errors) and warns about (check blocks) is listed in
[What is checked where](#what-is-checked-where). Print the values for your deployment any time:

```bash
cd terraform
terraform output -raw oidc_redirect_uri     # the one value you must register at Google
terraform output oidc_setup_steps           # these steps, with your project's links filled in
```

## The one rule

The **Authorized redirect URI** at Google must equal `public_url` + `/oauth/callback`, character for character: scheme, host, port,
no trailing slash. The gateway builds it from `public_url`; Google compares strings. `oidc_redirect_uri` is that exact string.

| Topology | `public_url` | Redirect URI to register |
|---|---|---|
| Trial: private Cloud Run + local proxy (`deploy/proxy.sh`) | `http://localhost:8891` (default) | `http://localhost:8891/oauth/callback` |
| Trial, other port | `http://localhost:<port>` | `http://localhost:<port>/oauth/callback` |
| `enterprise-iap-ilb`: internal load balancer | derived: `https://<gateway_hostname>` | `https://<gateway_hostname>/oauth/callback` |
| `enterprise-iap-custom-domain` | same as above (the custom domain is the budget app's, not the gateway's) | same as above |

Never register two different URIs hoping one matches: add a second one only when you really run a second gateway address.

## 1. Consent screen (Google Auth Platform, "Audience")

Open `terraform output oidc_consent_screen_url` and choose:

* **Everyone is in one Google Workspace / Cloud Identity organization: "Internal".** Only that organization's accounts can sign in, no
  review, no test-user list. Set `allowed_email_domains = ["corp.example.com"]` (or `oidc.google_workspace_domain`).
* **Personal Gmail accounts (the trial), or people outside the organization, or a project with no organization: "External", publishing
  status "Testing".** Add every engineer under **Test users** (limit 100). Google refuses anyone else ("Access blocked") before the
  gateway sees them. Leave the app in Testing for a trial. Do not click "Publish app" while `gmail.com` is in `allowed_email_domains`:
  from then on anyone with a Gmail account could sign in and spend up to the per-person default cap.

Scopes are only `openid profile email`. Google's 7-day refresh-token expiry for Testing apps does **not** apply to apps that request only
those scopes, so Testing-mode sign-ins last. (If you add other Google scopes yourself, they would.)

Gmail accounts are not in a Workspace organization and carry no `hd` claim, so **do not set `oidc.google_workspace_domain` for a Gmail
trial** (it sends `hd=` to Google and steers the account chooser away from Gmail). `hd` is only a UI hint anyway: the gateway enforces
`allowed_email_domains`, and always rejects an id_token whose `email_verified` is explicitly `false`.

## 2. Create the client

`terraform output oidc_console_url` → Create credentials → **OAuth client ID** → Application type **Web application**.

* Authorized redirect URIs: the value of `terraform output -raw oidc_redirect_uri`. No JavaScript origin.
* Google accepts `http://` redirect URIs only for `localhost` (including its ports). Any other host needs `https://` **and** a name under a
  public top-level domain: no raw IP address, no `.internal`, `.local`, `.lan`, `.corp` or single-label names. Because
  `enterprise-iap-ilb` uses a private DNS name, choose one under a domain you own (`claude-gateway.corp.example.com`); it still resolves only
  privately. Terraform warns at plan time when the host would be refused.
* On creation Google shows the **Client ID** (`<digits>-<chars>.apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-...`).
  **The full secret is shown only once**, at creation: download the JSON or copy it now.

## 3. Give both values to Terraform

```hcl
# terraform.tfvars
oidc = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com" }   # no google_workspace_domain for Gmail
allowed_email_domains = ["gmail.com"]                                           # your domains, bare, no @
```

```bash
# terraform/secrets.auto.tfvars  (git-ignored, chmod 600)  or the environment. Paste only the secret, nothing around it.
export TF_VAR_oidc_client_secret='GOCSPX-...'
terraform apply        # rolls a new gateway revision that uses the real client
```

`./setup.sh` asks for both and writes them for you.

## 4. Test it

1. Start the proxy for the trial topology (`terraform output -raw proxy_command | sh`) and keep it running.
2. `claude-gateway-setup.sh install --gateway-url '<public_url>'` (use temp dirs when testing, see CLAUDE.md), then `/login` in Claude Code.
3. The browser opens `<public_url>/device`, then Google. Pick a **Test user** account. You land on `<public_url>/oauth/callback` and the CLI is signed in.

Fast checks before involving a person: `curl -s <public_url>/healthz` through the proxy, and in the Cloud Run log for `claude-gateway`
look for the boot line from `config.load` (no OIDC discovery error) and, after a sign-in attempt, `device.callback` / `auth.denied` events.

## Rotating the client secret

Google lets a client hold **two** secrets at once, which makes rotation zero-downtime:

1. Cloud Console → Credentials → your client → **Add secret**. Copy it immediately (shown once).
2. Put the new value in `secrets.auto.tfvars` (or `TF_VAR_oidc_client_secret`) and `terraform apply`. Terraform writes a new version of
   Secret Manager `claude-gateway-oidc-secret` and rolls a new gateway revision (the revision reads the secret at start, so it needs the roll).
3. Sign in once to confirm. Then **Disable** the old secret at Google (it can be re-enabled if something breaks), and delete it later.

**Lost the secret?** Google cannot show it again (only its last four characters). Do not hunt for it: add a new secret on the client,
and follow the three steps above. If the client already has two secrets, disable and delete the older one first. The old gateway
revision keeps working until you apply, because its secret is still enabled.

Rotating the **client id** (a new client) is the same, plus the redirect URI on the new client and `oidc.client_id` in tfvars.

Changing `public_url` (for example moving from the localhost trial to an internal load balancer) changes the redirect URI and every
engineer's installer: register the new URI on the client first, apply, then roll out the installer.

## Testing sign-in locally with Dex (no Google)

`scripts/setup.sh`, `docker compose up -d`, `scripts/run-gateway.sh` start the gateway on `http://localhost:8791` with Dex as the IdP
(`config/dex.yaml`, `config/gateway.yaml`). The Dex client `claude-gateway` has the redirect URI `http://localhost:8791/oauth/callback`; users
`alice@example.com` and `bob@example.com`, password `changeme`. `scripts/claude-dev.sh` runs an isolated Claude Code that signs in there.

What Dex proves: the gateway's sign-in flow, `allowed_email_domains`, sessions and caps. What it does not prove, only Google does:

| Dex | Google |
|---|---|
| Client is static in `dex.yaml`, redirect URI preset | Client created by hand; redirect URI must match exactly |
| Any listed user can sign in | Consent screen audience and Test users decide who can even reach the gateway |
| Scopes include `offline_access` | Google ignores `offline_access`; the Terraform config asks `openid profile email` plus `access_type=offline` and `prompt=consent` |
| `http://localhost:5556` issuer (needs `CLAUDE_GATEWAY_ALLOW_LOOPBACK=1`) | `https://accounts.google.com` |
| No groups | No groups either (Google needs `oidc.google_groups` with Workspace) |
| Secret and client id are free-form | `GOCSPX-` secret and `...apps.googleusercontent.com` id |

To rehearse the exact gateway.yaml the trial deploys, render it offline with the plan tests (`terraform/tests/oidc.sh`) rather than
changing the Dex config.

## What is checked where

| Mistake | Where it is caught |
|---|---|
| Client id not `<digits>-<chars>.apps.googleusercontent.com` (Google issuer) | error at `terraform plan` |
| Space, tab or newline in client id or secret | error at plan (secret value never printed) |
| `public_url` not an origin, `http://` to anything but localhost, trailing slash | error at plan |
| `allowed_email_domains` empty | error at plan |
| No client id or secret yet | warning at every plan ("PLACEHOLDER"), sign-in does not work |
| Secret not `GOCSPX-` shaped (Google issuer) | warning (older clients differ) |
| Redirect host Google refuses (raw IP, `.internal`, `.local`, single label) | warning |
| `oidc.google_workspace_domain` set and `gmail.com` allowed | warning |
| `gmail.com` allowed at all | warning: keep the consent screen in Testing |
| Redirect URI at Google differs from `oidc_redirect_uri` | **not detectable offline**: Google answers `redirect_uri_mismatch` |
| Test user missing, consent screen not configured, secret wrong at Google | **not detectable offline** (`access_denied` / `invalid_client`) |

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| Google: `Error 400: redirect_uri_mismatch` | The URI at Google is not exactly `terraform output -raw oidc_redirect_uri`. Check scheme, port, trailing slash. The error page shows the URI the gateway sent. |
| Google: `Access blocked: ... has not completed the Google verification process` / `Error 403: access_denied` | External + Testing and this account is not in **Test users**. Add it. |
| Gateway page "Sign-in could not be completed" | Email domain not in `allowed_email_domains`, or `email_verified` is false. |
| After consent, `invalid_client` / `Unauthorized` in the gateway log | The client secret in Secret Manager is wrong or still the placeholder. `gcloud secrets versions list claude-gateway-oidc-secret` should show a version newer than the first apply; re-apply with the real secret. |
| Sign-in works but the browser shows a proxy error instead of the callback | The local proxy is not running on the `public_url` port. |
| Browser (Chrome) blocks the Approve button, console mentions `form-action` | The IdP redirected through another host; add it to `oidc.form_action_origins` in the gateway config. Not seen with Google so far (UNVERIFIED either way). |
| Engineers are asked to sign in again every hour | No refresh token: `access_type=offline` missing, or the account was not re-consented. The Terraform config sets both. |
| Google refuses to save the client: "Invalid redirect" | Host rule, see step 2. |

## Sources

The redirect path, `public_url` rules, Google scopes and the `email_verified` rule are from Anthropic's gateway docs
(`code.claude.com/docs/en/claude-apps-gateway-config`, `.../claude-apps-gateway-deploy`); redirect URI, `hd`, `prompt`, `access_type` and
refresh-token expiry rules are from Google's OAuth 2.0 and OpenID Connect documentation; the two-secret rotation from Google's client-secret
help page. Re-check them when you upgrade: they are not enforced by anything in this repository.
