# Provision on Google Cloud with Terraform

Creates the whole deployment: private Cloud Run services for the **gateway** and the **budget app**, a private-IP
Cloud SQL Postgres, Secret Manager, Artifact Registry, the VPC, service accounts, a private state bucket, a Cloud
Scheduler job, monitoring and alerting, and **the admin users**. The full guide is [`docs/DEPLOY.md`](../docs/DEPLOY.md).

## Quick start

```bash
cd terraform
./setup.sh                      # asks a few questions, writes terraform.tfvars (+ secrets.auto.tfvars), checks it offline
terraform init
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis   # registry first
PROJECT_ID=<project> REGION=<region> ../deploy/build-push.sh                                              # build + push images
terraform apply                                                                                          # everything else (Cloud SQL takes 10-15 min)
terraform output oidc_setup_steps                                                                        # create the Google OAuth client (console, ~3 min)
```

`setup.sh` prints these exact commands with your values. Prefer a file? `cp terraform.tfvars.example terraform.tfvars` and
edit: only four values are required (`project_id`, `admin_users`, `allowed_email_domains`, `oidc.client_id`).
`./setup.sh --check` re-validates an existing `terraform.tfvars` without contacting Google.

The registry is applied first because Cloud Run needs the images to exist; after that `terraform apply` is all you need.

## What you set

| Variable | Purpose |
|---|---|
| `project_id`, `region` | Where it runs (an existing project; `create_project = true` can create one) |
| `admin_users` | Who can sign in to the budget app and change budgets (own password and own gateway key each) |
| `allowed_email_domains` | Who can sign in to the gateway |
| `oidc` / `oidc_client_secret` | Google (or company IdP) sign-in; secret via `secrets.auto.tfvars` or `TF_VAR_oidc_client_secret` |
| `profile` | REQUIRED, no default: `trial` or `production`: one switch for database size, HA, warm instances, alert thresholds, log retention |
| `upstreams` | Vertex regions/projects the gateway fails over between |
| `view_access` | `open` (default) or `admin`: whether reading usage needs a sign-in |
| `enable_monitoring`, `alert_emails`, `alert_thresholds` | Alerts and dashboard |
| `manage_log_retention`, `log_retention_days` | Opt-in retention for the project's `_Default` log bucket |

Models are not a variable: edit [`../config/models.json`](../config/models.json) and apply. It drives the gateway policy,
the `sonnet`/`opus`/`haiku` aliases pinned for every engineer and the budget app.

## Files

`variables.tf` inputs, `locals.tf` profiles and derived values, `main.tf` identities, network, database, state bucket,
`secrets.tf` generated secrets + the rendered gateway config (`modules/gateway_config`), `run.tf` Cloud Run,
`scheduler.tf`, `monitoring.tf`, `outputs.tf`, `backend.tf.example` (private GCS state), `tests/` (offline tests).

## Tests

```bash
terraform/tests/run.sh          # fmt, validate, plan in a scratch copy with a fake token; assertions on the plan and on the rendered gateway.yaml; setup.sh tests
```

Nothing in the tests touches your `terraform.tfvars`, state or `.terraform` directory, and nothing contacts Google.

## Notes

* Terraform state contains the generated passwords and keys. Use a private GCS backend (`backend.tf.example`).
* Both services are private (Google IAM, no `allUsers`). `deploy/proxy.sh` opens them on localhost with your own login.
* Cost, teardown, adding a model or an upstream, monitoring, security notes: see [`docs/DEPLOY.md`](../docs/DEPLOY.md).
