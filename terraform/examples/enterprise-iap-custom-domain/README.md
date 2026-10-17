# Enterprise: custom domain for the app + internal load balancer for the gateway

Same as `../enterprise-iap-ilb`, but the budget app lives at your own domain behind a global external load balancer.

1. Copy `terraform.tfvars.example` to `terraform/terraform.tfvars` and set `app_domain` and `gateway_hostname`.
2. Apply, then create the DNS A record `app_domain` -> `terraform output app_lb_ip`. The managed certificate turns ACTIVE after that (up to about an hour).
3. Create the OAuth client for IAP in the console (`terraform output edge_next_steps`, step A3), set `iap_oauth_client_id` and the secret, apply again.
4. The app's Cloud Run ingress becomes "internal load balancer": the run.app URL stops answering from the Internet.
5. Browser origin, the Host the app sees, `APP_ALLOWED_HOSTS` and `APP_ALLOWED_ORIGINS` are all `https://<app_domain>`.
6. IAP audience is `/projects/<number>/global/backendServices/<id>`: Terraform fills it in (output `iap_audience`).
7. Estimated extra cost per month: global load balancer about 18 USD + traffic, plus the gateway's internal load balancer (about 18 USD).
8. Needs the same route and DNS from engineers' machines to the gateway as `../enterprise-iap-ilb`.
9. Unverified until you apply: the serverless NEG created before its Cloud Run service exists, and IAP without a custom client.
10. Without the consent screen / client from step 3, IAP shows a sign-in error instead of the app.
