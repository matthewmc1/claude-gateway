# Enterprise: IAP for the app, internal load balancer for the gateway

Browser users open the app after a Google sign-in (no proxy, no password). Claude Code connects to a private https name.
**Nothing here has been applied to a real project yet**: the steps marked (unverified) are what Google's documentation says, not something we saw work.
`docs/INSTALL.md` section 11 lists every such assumption with its symptom and remedy.

## First apply, in this order

Console-only means Terraform and the Google APIs cannot do it (a project without an organisation has no API for the consent screen or OAuth clients).

**0. Before Terraform (console / gcloud, once)**

1. Billing is on and you can run `gcloud auth application-default login` with Owner (or at least `roles/editor`, `roles/run.admin`, `roles/iam.securityAdmin`,
   `roles/compute.networkAdmin`). Users outside your organisation, or a project with no organisation, also need `roles/iap.settingsAdmin` and `roles/oauthconfig.editor`.
2. APIs: Terraform enables compute, dns, iap, run, cloudscheduler and the rest itself, but it needs `serviceusage.googleapis.com` and
   `cloudresourcemanager.googleapis.com` to do so. New projects have them on; if the first apply says "API has not been used", run
   `gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project=<project>` and apply again.
3. Organisation policies (skip when the project has no organisation). Check each; an "enforced"/restricted answer is a blocker you must ask the policy owner to relax for this project:
   ```bash
   for c in run.managed.requireInvokerIam run.allowedIngress iam.allowedPolicyMemberDomains compute.restrictLoadBalancerCreationForTypes gcp.resourceLocations; do
     echo "== $c"; gcloud org-policies describe constraints/$c --project=<project> --effective 2>&1 | head -12
   done
   ```
   - `run.managed.requireInvokerIam` enforced: Terraform cannot turn the gateway's invoker check off (apply fails at `claude-gateway`). No public fallback exists by design.
   - `run.allowedIngress` must allow `all` (the app with direct IAP) and `internal-and-cloud-load-balancing` (the gateway).
   - `iam.allowedPolicyMemberDomains` must list the domain of everyone you put in `admin_users` / `app_viewers` (IAP grants are IAM bindings).
   - `compute.restrictLoadBalancerCreationForTypes` must allow `INTERNAL_HTTP_HTTPS` (the gateway's regional internal Application Load Balancer) and, with `app_domain`, `GLOBAL_EXTERNAL_MANAGED_HTTP_HTTPS` ([Google: load balancer org policy constraints](https://cloud.google.com/load-balancing/docs/org-policy-constraints)).
   - `gcp.resourceLocations` must allow your region.
4. The VPC must not already have an ACTIVE proxy-only subnet in your region (only one per region and VPC):
   `gcloud compute networks subnets list --filter='purpose=REGIONAL_MANAGED_PROXY' --project=<project>`. Terraform's own VPC is new, so this only matters if you changed the module to reuse a VPC.
5. OAuth consent screen (Google Auth Platform, Branding): Audience **Internal** in a Workspace / Cloud Identity organisation, otherwise **External** in Testing with every person added as a **test user**
   (individual accounts only). Without it IAP shows a Google OAuth error instead of the app.
6. Engineers' sign-in client (Credentials, OAuth client ID, Web application) with redirect URI `https://<gateway_hostname>/oauth/callback`; put its id in `oidc.client_id` and the secret in `TF_VAR_oidc_client_secret`.
   Google only accepts a redirect host on a public top-level domain (`corp.example.com`, not `.internal`).
7. Choose the private name `gateway_hostname` and a network path (VPN / Interconnect) from engineers' laptops to the VPC. Terraform cannot create either.

**1. Terraform, two phases**
```bash
cp terraform/examples/enterprise-iap-ilb/terraform.tfvars.example terraform/terraform.tfvars   # edit project, admins, hostname
cd terraform && terraform init -upgrade
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
PROJECT_ID=<project> REGION=<region> ../deploy/build-push.sh                                    # prints app_image_tag
terraform apply -var app_image_tag=<tag>                                                        # Cloud SQL takes 10-15 minutes
terraform output edge_next_steps
```
If the full apply stops, the usual causes are (symptom -> fix): `service account ... does not exist` at `app_iap_agent` -> `gcloud services identity create --service=iap.googleapis.com --project=<project>`, apply again;
an organisation-policy error at `claude-gateway` -> step 0.3; `An active proxy-only subnetwork is required` -> step 0.4.

**2. After the apply (console / your network)**

1. Custom OAuth client for direct IAP (needed when anyone outside your organisation signs in, or the project has no organisation; unverified that Google's managed client is not enough otherwise):
   create a Web client with redirect URI `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`, then bind it:
   `gcloud iap settings set iap-oauth.yaml --project=<project> --resource-type=cloud-run --region=<region> --service=claude-budget-app` (`terraform output edge_next_steps` prints the file format; delete the file after).
2. Open `terraform output -raw app_url` and sign in with an admin. Admins are the emails in `admin_users`; everyone else with `roles/iap.httpsResourceAccessor` is a read-only viewer.
3. Gateway DNS and routing: `gateway_hostname` must resolve to `terraform output gateway_lb_ip` from engineers' machines (add the A record in your corporate DNS, or forward the name to Cloud DNS) and the route must exist. Then, from such a machine:
   `terraform output -raw gateway_ca_pem > claude-gateway-ca.pem && curl --cacert claude-gateway-ca.pem https://<gateway_hostname>/healthz` (expect `ok`).
4. Distribute `claude-gateway-ca.pem` (self-signed mode) to the OS trust store of every engineer, then the installer (`docs/INSTALL.md` section 5).
5. Verify with the checklist in `docs/INSTALL.md` section 8, including `gcloud run jobs executions list --job=claude-budget-tick --region=<region>`.

## Commands only

```bash
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project=P
# console: consent screen, OIDC client (redirect https://HOST/oauth/callback)
cd terraform && terraform init -upgrade
terraform apply -target=google_artifact_registry_repository.images -target=google_project_service.apis
PROJECT_ID=P REGION=R ../deploy/build-push.sh && terraform apply -var app_image_tag=TAG
terraform output edge_next_steps
# console: IAP custom OAuth client  ->  gcloud iap settings set iap-oauth.yaml --project=P --resource-type=cloud-run --region=R --service=claude-budget-app
# DNS: HOST -> $(terraform output -raw gateway_lb_ip) in your corporate DNS; VPN route to the LB subnet
terraform output -raw gateway_ca_pem > claude-gateway-ca.pem
curl --cacert claude-gateway-ca.pem https://HOST/healthz
```

## Notes

- The gateway has no IAM check (Claude Code cannot send a Google token): the private address and ingress "internal load balancer" protect it, and its `run.app` URL is switched off.
- TLS: `self_signed` (default, trials) makes a CA whose PRIVATE KEY is in the Terraform state and which cannot be limited to your hostname; distribute `gateway_ca_pem` only if you accept that. For production use `gateway_tls = { mode = "provided", cert_pem = ... }` + `gateway_tls_key_pem`. Claude Code pins the leaf on first connect; the 1-year leaf is not renewed automatically (`terraform output gateway_cert_expires`).
- Estimated extra cost per month: internal load balancer about 18 USD + traffic, private DNS zone about 0.2 USD, IAP free, the tick job roughly 0 to 5 USD.
- Try the same topology on a laptop first: `scripts/edge.sh up` (docs/LOCAL-DEV.md).
- Back to the trial topology: remove `app_access`, `gateway_exposure`, `gateway_hostname` and plan before applying.
