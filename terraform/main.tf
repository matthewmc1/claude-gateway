resource "google_project" "this" {
  count               = var.create_project ? 1 : 0
  name                = var.project_id
  project_id          = var.project_id
  org_id              = var.org_id
  folder_id           = var.folder_id
  billing_account     = var.billing_account
  auto_create_network = false
  deletion_policy     = "PREVENT"
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
  depends_on         = [google_project.this]
}

# ---- identities -----------------------------------------------------------------------------------------------------
resource "google_service_account" "gateway" {
  account_id   = "claude-gateway"
  display_name = "Claude apps gateway"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "app" {
  account_id   = "claude-budget-app"
  display_name = "Claude gateway budget app"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "scheduler" {
  account_id   = "claude-scheduler"
  display_name = "Claude gateway scheduler (calls the budget app tick)"
  depends_on   = [google_project_service.apis]
}

# The gateway reaches Claude on Vertex AI with this identity (Application Default Credentials). No key files exist.
resource "google_project_iam_member" "gateway_vertex" {
  project    = var.project_id
  role       = var.gateway_vertex_role
  member     = local.gateway_sa
  depends_on = [google_service_account.gateway]
}

# Failover upstreams in other projects need the same grant there.
resource "google_project_iam_member" "gateway_vertex_upstream" {
  for_each   = local.upstream_extra_projects
  project    = each.value
  role       = var.gateway_vertex_role
  member     = local.gateway_sa
  depends_on = [google_service_account.gateway]
}

moved {
  from = google_project_iam_member.app_logs
  to   = google_project_iam_member.app_logs[0]
}

# The budget app builds its usage views from the gateway's request logs (Cloud Logging).
# Default: roles/logging.viewer on the whole project. HONEST EXPOSURE: that lets the budget app's service account (and anyone
# who can run code as it) read every log entry in the project, not only the gateway's. IAM conditions cannot narrow it,
# because the permission is checked against the project, not against individual logs.
resource "google_project_iam_member" "app_logs" {
  count      = var.scope_app_log_access ? 0 : 1
  project    = var.project_id
  role       = "roles/logging.viewer"
  member     = local.app_sa
  depends_on = [google_service_account.app]
}

# Opt-in (scope_app_log_access): a log view limited to the gateway's Cloud Run logs, read through roles/logging.viewAccessor
# on that view only. The app has to query the view (env USAGE_LOGS_VIEW) rather than projects/<id>.
resource "google_logging_log_view" "gateway" {
  count       = var.scope_app_log_access ? 1 : 0
  name        = "claude-gateway-logs"
  bucket      = "projects/${var.project_id}/locations/global/buckets/_Default"
  description = "Only the claude-gateway Cloud Run service's logs (read by the budget app)."
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"claude-gateway\""
  depends_on  = [google_project_service.apis]
}

resource "google_project_iam_member" "app_log_view" {
  count   = var.scope_app_log_access ? 1 : 0
  project = var.project_id
  role    = "roles/logging.viewAccessor"
  member  = local.app_sa
  condition {
    title       = "gateway-log-view-only"
    description = "Only the claude-gateway-logs view"
    expression  = "resource.name == \"${local.gateway_log_view}\""
  }
  depends_on = [google_service_account.app, google_logging_log_view.gateway]
}

# ---- images ---------------------------------------------------------------------------------------------------------
resource "google_artifact_registry_repository" "images" {
  repository_id = "claude-gateway"
  location      = var.region
  format        = "DOCKER"
  description   = "Claude apps gateway and budget app images"
  depends_on    = [google_project_service.apis]
}

# ---- private network + database -------------------------------------------------------------------------------------
resource "google_compute_network" "vpc" {
  name                    = "cc-gateway-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = "cc-gateway-subnet"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = "10.0.0.0/24"
}

resource "google_compute_global_address" "private_services" {
  name          = "google-managed-services-cc-gateway-vpc"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name                = "claude-gateway-db"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = local.db_deletion_protection

  settings {
    tier              = local.db_tier
    edition           = "ENTERPRISE"
    availability_type = local.p.db_availability

    # Deletion protection at the GCP level too (the Terraform-level flag above only stops `terraform destroy`; this one also
    # stops console/gcloud deletes). Profile production: on.
    deletion_protection_enabled = local.db_deletion_protection

    ip_configuration {
      ipv4_enabled    = false # private IP only
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = local.p.db_point_in_time
    }
    maintenance_window {
      day          = var.db_maintenance_window.day
      hour         = var.db_maintenance_window.hour
      update_track = "stable"
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "gateway" {
  name     = "claude_gateway"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "gateway" {
  name     = "gateway"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# ---- app state (budget overrides, usage ingest cursor) --------------------------------------------------------------
resource "google_storage_bucket" "app_state" {
  name                        = "${var.project_id}-claude-gateway-state"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = local.state_force_destroy

  versioning {
    enabled = true
  }

  # Keep recent history for recovery, drop old versions.
  lifecycle_rule {
    condition {
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 90
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "app_state" {
  bucket     = google_storage_bucket.app_state.name
  role       = "roles/storage.objectUser"
  member     = local.app_sa
  depends_on = [google_service_account.app]
}

# ---- log retention (opt-in; the _Default bucket is shared by the whole project) -------------------------------------
resource "google_logging_project_bucket_config" "default" {
  count          = var.manage_log_retention ? 1 : 0
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = local.log_retention_days
  depends_on     = [google_project_service.apis]
}
