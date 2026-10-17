# Enterprise: IAP for the app, internal load balancer for the gateway

Browser users open the app after a Google sign-in (no proxy, no password). Claude Code connects to a private https name.

1. Copy `terraform.tfvars.example` to `terraform/terraform.tfvars`, set the project, admins and `gateway_hostname`.
2. `terraform init -upgrade` (the Google provider needs 7.30 or newer for IAP on Cloud Run), then apply as in docs/DEPLOY.md.
3. `terraform output edge_next_steps` lists what only the console can do: OAuth consent screen, DNS/routing, CA, managed settings.
4. The gateway has no IAM check (Claude Code cannot send a Google token): the private address and ingress "internal load balancer" protect it.
5. TLS: `self_signed` (default, trials) makes a CA whose PRIVATE KEY is in the Terraform state and which cannot be limited to your hostname; distribute `terraform output -raw gateway_ca_pem` only if you accept that. For production use `gateway_tls = { mode = "provided", cert_pem = ... }` + `gateway_tls_key_pem` from your corporate PKI. Claude Code pins the leaf on first connect; the 1-year leaf is not renewed automatically (`terraform output gateway_cert_expires`).
6. Estimated extra cost per month: internal load balancer about 18 USD + traffic, private DNS zone about 0.2 USD, IAP free.
7. The tick runs as a Cloud Run job (a scheduler cannot call an IAP service): roughly 0 to 5 USD.
8. Needs a route and DNS from engineers' machines to the load balancer subnet (VPN/Interconnect). Terraform cannot create that.
9. Unverified until you apply: IAP on Cloud Run (BETA), serverless NEG behind the internal load balancer, DNS from Cloud Run, the IAP service agent (Terraform tries `gcloud beta services identity create`; docs/DEPLOY.md).
10. Back to the trial topology: remove `app_access`, `gateway_exposure`, `gateway_hostname` and plan before applying.
