# Trial: private Cloud Run + IAM + local proxy

The original topology, and the default of every new variable. Nothing is public: Google IAM guards both services.

1. Copy `terraform.tfvars.example` to `terraform/terraform.tfvars` (or run `terraform/setup.sh` and pick "trial").
2. `terraform init -upgrade` (the provider is 7.30+ in every topology and an old lock file pins 6.x), the registry-first apply, `deploy/build-push.sh`, then `terraform apply` (docs/DEPLOY.md).
3. Admins reach the app and engineers reach the gateway through `terraform output -raw proxy_command | sh`.
4. Sign-in client for engineers: `terraform output oidc_setup_steps` (console only).
5. Cost: no load balancer, no DNS zone. The estimate for the whole trial is in docs/DEPLOY.md.
6. Limit: Claude Code only accepts the gateway at `http://localhost:8891`, so each engineer runs the proxy.
7. Moving to the enterprise edge later: add the variables of `../enterprise-iap-ilb` and plan; the existing resources stay.
8. `public_url` stays `http://localhost:8891`; the OAuth redirect URI is `http://localhost:8891/oauth/callback`.
9. Not verified here: nothing beyond the offline plan tests (terraform/tests/run.sh).
10. Remove with `terraform destroy` (trial profile allows it; production does not).
