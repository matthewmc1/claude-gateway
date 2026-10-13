# Provision on Google Cloud with Terraform

Creates the whole deployment: private Cloud Run services for the **gateway** and the **budget app**, a private-IP
Cloud SQL Postgres, Secret Manager, Artifact Registry, the VPC, service accounts, and **the admin users**.

```
terraform.tfvars  ->  admin_users, allowed_email_domains, OIDC client
        |
        v
 Secret Manager   one gateway write key + one password per admin
 Cloud Run        claude-gateway (OIDC sign-in, caps, Vertex)   claude-budget-app (admin UI)
 Cloud SQL        gateway state (private IP only)
```

## Admin users

Admins are declared once, in `terraform.tfvars`:

```hcl
admin_users = [
  { email = "platform-lead@example.com", name = "Platform Lead" },
  { email = "finance@example.com" },
]
```

For each one Terraform generates a password and a **personal gateway write key**, grants them permission to reach the
private services (`roles/run.invoker`), and registers the key with the gateway. The budget app signs the admin in with
email and password and changes caps with *their* key, so the gateway's own audit trail reads
`admin-key:platform-lead@example.com`, not a shared account. Add or remove an admin by editing the list and applying.

```bash
terraform output -json admin_credentials          # initial passwords
terraform apply -replace='random_password.admin_password["finance@example.com"]'   # rotate one password
```

## Steps

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars      # edit: project, admins, domains, OIDC client id
export TF_VAR_oidc_client_secret=...              # from the Google OAuth client (see ../deploy/gcp/README.md)

terraform init
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis   # registry first
PROJECT_ID=<project> REGION=<region> ../deploy/gcp/02-build-push.sh                                      # build + push images
terraform apply                                                                                          # everything else (Cloud SQL takes 10-15 min)

PROJECT_ID=<project> REGION=<region> ../deploy/gcp/05-proxy.sh                                           # gateway :8891, app :8892
```

The first apply is split because Cloud Run needs the images to exist. After that, `terraform apply` is the only command
you need; changing `admin_users`, `allowed_models` or the OIDC settings rolls a new revision automatically.

## Reaching it

Both services are private (Google IAM, no public access). `05-proxy.sh` opens them on localhost using your own Google
login, and Claude Code accepts a localhost gateway. For a team, put an internal load balancer in front and set
`public_url` to its `https://` hostname; Claude Code refuses public addresses.

## Notes

* Terraform state contains the generated passwords and keys. Use a private GCS backend (see `versions.tf`).
* If you already created resources with `deploy/gcp/*.sh`, either delete them first or `terraform import` them; the names match.
* Cost: Cloud SQL `db-f1-micro` about $10 a month, plus the always-on gateway instance.
* Tear down: set `db_deletion_protection = false`, apply, then `terraform destroy`.
