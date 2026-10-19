# Profile defaults, resolved settings and the derived values the other files share.

locals {
  profiles = {
    trial = {
      db_tier                = "db-f1-micro"
      db_availability        = "ZONAL"
      db_point_in_time       = false
      db_deletion_protection = false
      gateway_min_instances  = 1
      gateway_max_instances  = 2
      log_retention_days     = 30
      state_force_destroy    = true
      thresholds = {
        gateway_5xx              = 10
        gateway_429              = 200
        app_5xx                  = 10
        upstream_errors          = 10
        spend_cap_blocks         = 50
        security_denials         = 50
        sql_cpu                  = 0.9
        sql_disk                 = 0.9
        sql_connections          = 20
        scheduler_failures       = 5
        override_overdue         = 1
        override_errors          = 5
        override_failed          = 1
        override_lost_claim      = 5
        override_creator_removed = 1
        store_errors             = 1
        tick_errors              = 3
        tick_missing_minutes     = 5
      }
    }
    production = {
      db_tier                = "db-custom-1-3840"
      db_availability        = "REGIONAL"
      db_point_in_time       = true
      db_deletion_protection = true
      gateway_min_instances  = 2
      gateway_max_instances  = 6
      log_retention_days     = 400
      state_force_destroy    = false
      thresholds = {
        gateway_5xx              = 3
        gateway_429              = 100
        app_5xx                  = 3
        upstream_errors          = 5
        spend_cap_blocks         = 20
        security_denials         = 25
        sql_cpu                  = 0.8
        sql_disk                 = 0.85
        sql_connections          = 80
        scheduler_failures       = 3
        override_overdue         = 1
        override_errors          = 5
        override_failed          = 1
        override_lost_claim      = 5
        override_creator_removed = 1
        store_errors             = 1
        tick_errors              = 3
        tick_missing_minutes     = 5
      }
    }
  }

  p = local.profiles[var.profile]

  db_tier                = coalesce(var.db_tier, local.p.db_tier)
  db_deletion_protection = var.db_deletion_protection == null ? local.p.db_deletion_protection : var.db_deletion_protection
  gateway_min_instances  = var.gateway_min_instances == null ? local.p.gateway_min_instances : var.gateway_min_instances
  gateway_max_instances  = var.gateway_max_instances == null ? local.p.gateway_max_instances : var.gateway_max_instances
  app_image_tag          = var.app_image_tag == null ? "UNSET-run-deploy-build-push.sh-and-set-app_image_tag" : var.app_image_tag

  # Conservative floors for Postgres max_connections by tier (verify with SHOW max_connections). Unknown tier: no check
  # unless var.db_max_connections is set. 3 connections stay reserved for superusers.
  tier_max_connections = { "db-f1-micro" = 25, "db-g1-small" = 50, "db-custom-1-3840" = 100 }
  db_max_connections   = var.db_max_connections != null ? var.db_max_connections : lookup(local.tier_max_connections, local.db_tier, null)
  gateway_db_conns     = local.gateway_max_instances * var.gateway_store_max_connections

  gateway_log_view = "projects/${var.project_id}/locations/global/buckets/_Default/views/claude-gateway-logs"

  # The Cloud Scheduler OIDC token and the budget app agree on this audience (the app gets it as SCHEDULER_AUDIENCE and
  # Cloud Run accepts it through custom_audiences). The app's own https URL cannot be used: the app's environment
  # cannot refer to the app's own URL (a dependency cycle), and the URL is not known before the service exists.
  scheduler_audience  = "https://claude-budget-tick.${var.project_id}.invalid"
  state_force_destroy = var.state_bucket_force_destroy == null ? local.p.state_force_destroy : var.state_bucket_force_destroy
  log_retention_days  = var.log_retention_days == null ? local.p.log_retention_days : var.log_retention_days

  th = {
    for k, v in local.p.thresholds : k => coalesce(try(var.alert_thresholds[k], null), v)
  }

  # ---- who ----
  admins = { for a in var.admin_users : lower(a.email) => { email = lower(a.email), name = coalesce(a.name, split("@", a.email)[0]) } }

  alert_emails = length(var.alert_emails) > 0 ? var.alert_emails : [for a in local.admins : a.email]

  # ---- sign-in ----
  oidc_is_google = can(regex("^https://accounts\\.google\\.com/?$", var.oidc.issuer))
  has_client_id  = var.oidc.client_id != null && var.oidc.client_id != ""
  has_secret     = var.oidc_client_secret != null && var.oidc_client_secret != ""
  oidc_client_id = local.has_client_id ? var.oidc.client_id : "REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com"
  oidc_secret    = local.has_secret ? var.oidc_client_secret : "placeholder-set-me"
  oidc_ready     = local.has_client_id && local.has_secret

  allowed_email_domains = length(var.allowed_email_domains) > 0 ? var.allowed_email_domains : (var.oidc.google_workspace_domain == null ? [] : [var.oidc.google_workspace_domain])

  extra_auth_params = merge(
    local.oidc_is_google ? { access_type = "offline", prompt = "consent" } : {},
    local.oidc_is_google && var.oidc.google_workspace_domain != null ? { hd = var.oidc.google_workspace_domain } : {},
  )

  # Private load balancer: the gateway is https://<gateway_hostname> (edge_locals.tf); otherwise what you set, default the local proxy.
  public_url   = local.gateway_lb ? local.gateway_lb_url : trimsuffix(coalesce(var.public_url, "http://localhost:8891"), "/")
  redirect_uri = "${local.public_url}/oauth/callback"

  # ---- upstreams ----
  upstreams = [for u in var.upstreams : {
    provider   = u.provider
    region     = coalesce(u.region, var.vertex_region)
    project_id = coalesce(u.project_id, var.project_id)
  }]
  upstream_extra_projects = var.upstream_project_iam ? toset([for u in local.upstreams : u.project_id if u.project_id != var.project_id]) : toset([])

  # ---- identities (computed, not read from the resources, so for_each keys are known at plan time) ----
  gateway_sa_email   = "claude-gateway@${var.project_id}.iam.gserviceaccount.com"
  app_sa_email       = "claude-budget-app@${var.project_id}.iam.gserviceaccount.com"
  scheduler_sa_email = "claude-scheduler@${var.project_id}.iam.gserviceaccount.com"
  gateway_sa         = "serviceAccount:${local.gateway_sa_email}"
  app_sa             = "serviceAccount:${local.app_sa_email}"
  scheduler_sa       = "serviceAccount:${local.scheduler_sa_email}"

  invokers = concat([for a in local.admins : "user:${a.email}"], var.extra_invokers)

  registry = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"

  apis = concat([
    "run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com",
    "aiplatform.googleapis.com", "compute.googleapis.com", "servicenetworking.googleapis.com", "iam.googleapis.com",
    "iamcredentials.googleapis.com", "logging.googleapis.com", "cloudscheduler.googleapis.com", "monitoring.googleapis.com",
    "storage.googleapis.com", "cloudresourcemanager.googleapis.com", "serviceusage.googleapis.com",
  ], local.edge_apis)
}

# Cross-variable checks (variable validation cannot see other variables in Terraform 1.5).
resource "terraform_data" "input_checks" {
  lifecycle {
    precondition {
      condition     = !local.oidc_secret_has_whitespace
      error_message = "oidc_client_secret contains a space, tab or newline (a classic copy-paste slip: a trailing newline makes Google answer invalid_client at sign-in). Paste only the secret, for example GOCSPX-... for Google. (The value is not shown here on purpose.)"
    }
    precondition {
      condition     = length(local.allowed_email_domains) > 0
      error_message = "Set allowed_email_domains (for example [\"example.com\"]) or oidc.google_workspace_domain: only people with an email in these domains can sign in."
    }
    precondition {
      condition     = var.app_image_tag != null
      error_message = "Set app_image_tag to the tag deploy/build-push.sh printed (for example -var app_image_tag=20261013093000, or in terraform.tfvars). It has no default and may not be \"latest\", so that every new build rolls a new revision. (Only the registry-first apply, -target=google_artifact_registry_repository.images, works without it.)"
    }
    precondition {
      condition     = local.gateway_max_instances >= local.gateway_min_instances
      error_message = "gateway_max_instances (${local.gateway_max_instances}) must be at least gateway_min_instances (${local.gateway_min_instances})."
    }
    precondition {
      condition     = local.db_max_connections == null ? true : local.gateway_db_conns + 3 <= local.db_max_connections
      error_message = "Database connection budget exceeded: gateway_max_instances ${local.gateway_max_instances} x gateway_store_max_connections ${var.gateway_store_max_connections} = ${local.gateway_db_conns} (+3 reserved) is more than the ${local.db_max_connections == null ? 0 : local.db_max_connections} connections the tier ${local.db_tier} allows. Lower gateway_max_instances or gateway_store_max_connections, choose a bigger db_tier, or set db_max_connections if you raised the database flag."
    }
    precondition {
      condition     = !var.create_project || (var.billing_account != null && (var.org_id != null) != (var.folder_id != null))
      error_message = "create_project = true needs billing_account and exactly one of org_id or folder_id."
    }
    precondition {
      condition     = var.create_project || (var.billing_account == null && var.org_id == null && var.folder_id == null)
      error_message = "billing_account, org_id and folder_id are only used with create_project = true. Remove them, or set create_project = true."
    }
  }
}

# A warning (not an error) so a first apply can succeed before the OAuth client exists.
check "oidc_configured" {
  assert {
    condition     = local.oidc_ready
    error_message = "Sign-in is using a PLACEHOLDER OAuth client. Engineers cannot sign in until you create the client (terraform output oidc_setup_steps), set oidc.client_id and oidc_client_secret, and apply again."
  }
}
