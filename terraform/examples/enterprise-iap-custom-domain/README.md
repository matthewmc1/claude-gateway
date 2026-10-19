# Enterprise: custom domain for the app + internal load balancer for the gateway

Same as `../enterprise-iap-ilb`, but the budget app lives at your own domain behind a global external Application Load Balancer, with IAP on its backend service.
Read `../enterprise-iap-ilb/README.md` first: its step 0 (consent screen, OIDC client, organisation policies, proxy-only subnet) and the gateway steps (DNS, VPN, CA) are identical.
**Nothing here has been applied to a real project yet**; `docs/INSTALL.md` section 11 lists every assumption with its symptom and remedy.

## What differs

- The app's Cloud Run ingress becomes "internal and load balancing" and its `run.app` URL is switched off; people use only `https://<app_domain>`.
- Browser origin, the `Host` the app sees, `APP_ALLOWED_HOSTS` and `APP_ALLOWED_ORIGINS` are all `https://<app_domain>`. Do not put another proxy in front.
- IAP is on the backend service `claude-budget-app-backend` (not on the Cloud Run service); the audience is `/projects/<number>/global/backendServices/<id>` (output `iap_audience`).
- A custom OAuth client for that backend service is the documented path for external users or a project without an organisation; set `iap_oauth_client_id` and `TF_VAR_iap_oauth_client_secret`.
  Without them Terraform enables IAP on the backend without a client, i.e. it relies on IAP's Google-managed client, which Google documents for internal users only (unverified for your case).
- The legacy IAP OAuth brand/client API was shut down on 2026-03-19, so the client is always created in the console; there is no `google_iap_brand` / `google_iap_client` in this module.

## First apply, in this order

1. Everything in `../enterprise-iap-ilb/README.md` step 0. Additionally decide `app_domain` (a name in a zone you control) and, optionally, a Cloud Armor policy name for `app_security_policy`.
2. `cp terraform/examples/enterprise-iap-custom-domain/terraform.tfvars.example terraform/terraform.tfvars` and edit it. Leave `iap_oauth_client_*` out for now.
3. Registry first, then the full apply:
   ```bash
   cd terraform && terraform init -upgrade
   terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
   PROJECT_ID=<project> REGION=<region> ../deploy/build-push.sh
   terraform apply -var app_image_tag=<tag>
   ```
   If it stops at `google_compute_region_network_endpoint_group.app` (Google refuses a serverless NEG whose Cloud Run service does not exist yet; **unverified**, the NEG is created first to avoid a dependency cycle):
   set `app_domain = null`, apply (direct IAP creates the service), set `app_domain` again, apply.
4. DNS: create the A record `app_domain` -> `terraform output -raw app_lb_ip`. The Google-managed certificate turns ACTIVE only after that resolves (minutes to about an hour):
   `gcloud compute ssl-certificates describe claude-budget-app-cert --global --format='value(managed.status)'` (expect `ACTIVE`; `PROVISIONING` means wait, `FAILED_NOT_VISIBLE` means the record is wrong).
5. IAP client (console): Credentials -> OAuth client ID -> Web application; add the redirect URI `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`.
   Put the id in `iap_oauth_client_id`, export `TF_VAR_iap_oauth_client_secret`, `terraform apply` again.
6. Open `https://<app_domain>` and sign in. Then the gateway steps (DNS name -> `gateway_lb_ip`, VPN route, CA distribution) and `docs/INSTALL.md` section 8.

## Commands only

```bash
cd terraform && terraform init -upgrade
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
PROJECT_ID=P REGION=R ../deploy/build-push.sh && terraform apply -var app_image_tag=TAG
terraform output app_lb_ip                      # DNS: app_domain A record -> this
gcloud compute ssl-certificates describe claude-budget-app-cert --global --format='value(managed.status)'   # wait for ACTIVE
# console: IAP OAuth client; then
export TF_VAR_iap_oauth_client_secret=...   # and iap_oauth_client_id in terraform.tfvars
terraform apply -var app_image_tag=TAG
terraform output edge_next_steps
```

## Notes

- Estimated extra cost per month: global load balancer about 18 USD + traffic, plus the gateway's internal load balancer (about 18 USD); managed certificate and IAP are free.
- The load balancer's address is public; IAP is the gate. `app_security_policy` can attach a Cloud Armor policy (for example allow only your office / VPN ranges).
- Try the same wiring on a laptop first: `scripts/edge.sh up` (docs/LOCAL-DEV.md).
- Without the consent screen / client from step 5, IAP shows a sign-in error instead of the app.
