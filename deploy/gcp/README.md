# Deploy to Cloud Run with shell scripts

> Terraform in `../../terraform` is the recommended path and also creates the admin users. These scripts are the same
> deployment as plain `gcloud`; use them to see each step, or to build and push the images (`02-build-push.sh`),
> and for the local proxy (`05-proxy.sh`) either way. Set `PROJECT_ID`, `REGION` and `ALLOWED_EMAIL_DOMAIN` first.

Gateway and budget app as two **private** Cloud Run services (Google IAM guards them, no `allUsers`),
a private-IP Cloud SQL Postgres, Secret Manager, and Google accounts for sign-in.
You reach both through `gcloud run services proxy`, which gives Claude Code a `localhost` address
(it only accepts private or loopback gateways).

Only new resources are created (`claude-gateway*`, `claude-budget-app`, `cc-gateway-*`); nothing existing in the project is modified.

## Steps

```bash
cd deploy/gcp
./01-infra.sh        # APIs, service accounts, registry, VPC, Cloud SQL (10-15 min)
# create the Google OAuth client (below), then:
export OIDC_CLIENT_ID=<id>.apps.googleusercontent.com OIDC_CLIENT_SECRET=<secret>
./03-secrets.sh      # Secret Manager + rendered gateway.yaml
./02-build-push.sh   # verified binary -> amd64 images -> Artifact Registry
./04-deploy.sh       # Cloud Run: claude-gateway, claude-budget-app
./05-proxy.sh        # localhost:8891 (gateway), localhost:8892 (app)
```

`03-secrets.sh` can run before the OAuth client exists (it stores a placeholder); re-run it with the
real values and redeploy: `./04-deploy.sh`.

## Google sign-in client (manual, about 3 minutes)

1. Cloud console > APIs & Services > OAuth consent screen: User type **External**, leave it in **Testing**,
   add your Google account under **Test users**. Only listed test users can sign in.
2. Credentials > Create credentials > OAuth client ID > **Web application**.
3. Authorized redirect URI: `http://localhost:8891/oauth/callback` (must match `public_url` exactly).
4. Copy the client ID and secret into the `export` line above. Never commit them.

Set `ALLOWED_EMAIL_DOMAIN` to your company domain. A broad domain such as `gmail.com` is only acceptable for a
personal trial, where the real gates are the Testing-mode test-user list and Cloud Run IAM.

## Use it

```bash
./05-proxy.sh &
# app password:
gcloud secrets versions access latest --secret=claude-budget-app-password
# Claude Code (isolated config, same as local):
GATEWAY_URL=http://localhost:8891 ../../scripts/claude-dev.sh
```

## Known limits of this first deployment

* **No analytics store.** ClickHouse/Grafana are not deployed, so request counts and charts in the app are
  empty; budgets and caps work. The app lists people who have spend or a personal cap.
* **`public_url` is `http://localhost:8891`.** The docs describe `public_url` as an `https://` origin. If the
  gateway refuses to boot with it, set `PUBLIC_URL` to the `*.run.app` URL, re-run `03-secrets.sh` and
  `04-deploy.sh`. Browser and admin-API tests then work, but Claude Code's own sign-in will refuse the address.
* **Real model calls still need Vertex quota** (`global_online_prediction_requests_per_base_model`).
  Sign-in, model allow-list, caps and the budget app can be tested without it.
* **Cost:** Cloud SQL `db-f1-micro` about $10 a month, gateway `min-instances=1` a few dollars.

## Tear down

```bash
gcloud run services delete claude-gateway claude-budget-app --region=europe-west2
gcloud sql instances delete claude-gateway-db
gcloud secrets list --filter="name~claude-" --format="value(name)" | xargs -n1 gcloud secrets delete
gcloud artifacts repositories delete claude-gateway --location=europe-west2
gcloud compute networks subnets delete cc-gateway-subnet --region=europe-west2
gcloud compute addresses delete google-managed-services-cc-gateway-vpc --global
gcloud compute networks delete cc-gateway-vpc
```
