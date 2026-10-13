locals {
  console_credentials_url = "https://console.cloud.google.com/apis/credentials?project=${var.project_id}"
  console_consent_url     = "https://console.cloud.google.com/auth/overview?project=${var.project_id}"
  client_defaults = {
    gatewayUrl   = local.public_url
    defaultAlias = module.gateway_config.default_alias
    defaultModel = module.gateway_config.default_model_id
    effort       = var.client_default_effort
    models       = module.gateway_config.available_models
  }
}

output "gateway_url" {
  description = "Cloud Run URL of the gateway (private; reach it through the local proxy)."
  value       = google_cloud_run_v2_service.gateway.uri
}

output "app_url" {
  description = "Cloud Run URL of the budget app (private)."
  value       = google_cloud_run_v2_service.app.uri
}

output "admin_credentials" {
  description = "Initial sign-in for each admin: terraform output -json admin_credentials"
  sensitive   = true
  value       = { for a in local.admin_accounts : a.email => { name = a.name, password = a.password } }
}

output "registry" {
  description = "Artifact Registry path for the images."
  value       = local.registry
}

output "state_bucket" {
  description = "Private GCS bucket holding the budget app's state."
  value       = google_storage_bucket.app_state.name
}

output "dashboard_url" {
  description = "Cloud Monitoring dashboard (empty when enable_monitoring is false)."
  value       = var.enable_monitoring ? "https://console.cloud.google.com/monitoring/dashboards?project=${var.project_id}" : null
}

# ---- reaching the private services ---------------------------------------------------------------------------------------
output "proxy_command" {
  description = "Open the private gateway and budget app on localhost (uses your own Google login)."
  value       = "GATEWAY_URL=${google_cloud_run_v2_service.gateway.uri} APP_URL=${google_cloud_run_v2_service.app.uri} ../deploy/proxy.sh"
}

# ---- sign-in (Google OAuth client: console only, no API) ---------------------------------------------------------------
output "oidc_redirect_uri" {
  description = "Paste this as the Authorized redirect URI of the OAuth client."
  value       = local.redirect_uri
}

output "oidc_console_url" {
  description = "Where to create the OAuth client (Credentials page)."
  value       = local.console_credentials_url
}

output "oidc_consent_screen_url" {
  description = "OAuth consent screen (Google Auth Platform) for this project."
  value       = local.console_consent_url
}

output "oidc_setup_steps" {
  description = "Step-by-step: create the Google OAuth client. Terraform and the Google APIs cannot create a standard Web application client."
  value       = <<-EOT
    Google does not let Terraform or any API create the "Web application" OAuth client that people sign in with, so this
    is the one manual step (about 3 minutes). Nothing else in the deployment needs the console.
    ${local.oidc_ready ? "(An OAuth client is already configured; these steps are only needed to change it.)" : "Sign-in is on a PLACEHOLDER until you finish these steps and apply again."}

    1. Consent screen: ${local.console_consent_url}
       - Everyone in one Google Workspace / Cloud Identity organization: choose Audience "Internal".
         Only accounts in your organization can sign in; no review needed.
       - Personal Gmail accounts, or people outside the organization: choose "External", leave publishing status
         "Testing", and add every engineer under "Test users" (up to 100). Testing-mode sign-ins expire after 7 days of
         refresh-token use, which is fine for a trial; publish the app for production use with external users.
    2. Credentials: ${local.console_credentials_url}
       Create credentials > OAuth client ID > Application type "Web application".
    3. Authorized redirect URI, exactly (scheme, host, port and path must match public_url):
         ${local.redirect_uri}
       No JavaScript origin is needed.
    4. Copy the Client ID (looks like 123456789012-abc123.apps.googleusercontent.com) into terraform.tfvars:
         oidc = { client_id = "<client id>" }
       and the Client secret into terraform/secrets.auto.tfvars (git-ignored, chmod 600) or the environment:
         export TF_VAR_oidc_client_secret='<client secret>'
       ./setup.sh does both for you.
    5. terraform apply   (it rolls a new gateway revision with the real client)
    6. Allowed domains: ${join(", ", local.allowed_email_domains)}${local.oidc_is_google && var.oidc.google_workspace_domain != null ? " (the Google account chooser is limited to ${var.oidc.google_workspace_domain})" : ""}.
  EOT
}

# ---- engineer install ---------------------------------------------------------------------------------------------------
output "client_defaults" {
  description = "JSON the engineer installer consumes (also written to ../client/defaults.json with write_client_defaults)."
  value       = jsonencode(local.client_defaults)
}

output "client_install_hint" {
  description = "How engineers install."
  value       = "client/claude-gateway-setup.sh install --gateway-url '${local.public_url}'"
}

output "next_steps" {
  value = <<-EOT
    1. First apply only: build and push the images once the registry exists (docs/DEPLOY.md):
         PROJECT_ID=${var.project_id} REGION=${var.region} ../deploy/build-push.sh
       then set app_image_tag to the timestamp tag it prints (there is no default and "latest" is refused) and run terraform apply.
    2. Open the private services on localhost:
         terraform output -raw proxy_command | sh
         gateway http://localhost:8891    budget app http://localhost:8892
    3. Admin passwords:  terraform output -json admin_credentials
    4. Sign-in client:   terraform output oidc_setup_steps
    5. Engineers:        client/claude-gateway-setup.sh install --gateway-url '${local.public_url}'
  EOT
}

resource "local_file" "client_defaults" {
  count           = var.write_client_defaults ? 1 : 0
  filename        = "${path.module}/../client/defaults.json"
  content         = "${jsonencode(local.client_defaults)}\n"
  file_permission = "0644"
}

# ---- what this configuration resolved to (profile + overrides) ---------------------------------------------------------
output "effective_settings" {
  description = "The settings in force after the profile and your overrides."
  value = {
    profile                = var.profile
    db_tier                = local.db_tier
    db_availability        = local.p.db_availability
    db_deletion_protection = local.db_deletion_protection
    gateway_min_instances  = local.gateway_min_instances
    gateway_max_instances  = local.gateway_max_instances
    gateway_db_connections = local.gateway_db_conns
    db_max_connections     = local.db_max_connections
    gateway_vertex_role    = var.gateway_vertex_role
    scope_app_log_access   = var.scope_app_log_access
    scheduler_audience     = local.scheduler_audience
    state_force_destroy    = local.state_force_destroy
    log_retention_days     = local.log_retention_days
    manage_log_retention   = var.manage_log_retention
    alert_thresholds       = local.th
    alert_emails           = local.alert_emails
    upstreams              = local.upstreams
    allowed_email_domains  = local.allowed_email_domains
    oidc_extra_auth_params = local.extra_auth_params
    oidc_configured        = nonsensitive(local.oidc_ready)
    enabled_models         = module.gateway_config.available_models
  }
}
