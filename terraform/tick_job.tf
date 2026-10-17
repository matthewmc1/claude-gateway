# With IAP in front of the budget app (app_access = "iap") Cloud Scheduler cannot call the app: the Google-managed scheduler
# identity has no IAP credentials. The once-a-minute tick (apply and revert budget boosts, ingest usage) therefore runs as a Cloud Run
# JOB with the same image, service account, secrets and environment as the app, started by Cloud Scheduler through the Run API:
#   POST https://run.googleapis.com/v2/projects/<project>/locations/<region>/jobs/claude-budget-tick:run   (OAuth token of claude-scheduler)
# The scheduler job itself is google_cloud_scheduler_job.tick (scheduler.tf); it only changes its target. api/tick.mjs runs the tick once
# and exits 0/1, logging {"evt":"tick.job"} lines (monitoring.tf watches them).

resource "google_cloud_run_v2_job" "tick" {
  count               = local.app_iap ? 1 : 0
  name                = local.tick_job_name
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.app.email
      max_retries     = 0
      timeout         = "300s"

      dynamic "vpc_access" {
        for_each = local.gateway_lb ? [1] : []
        content {
          egress = "PRIVATE_RANGES_ONLY"
          network_interfaces {
            network    = google_compute_network.vpc.id
            subnetwork = google_compute_subnetwork.subnet.id
          }
        }
      }

      containers {
        image   = "${local.registry}/budget-app:${local.app_image_tag}"
        command = ["node"]
        args    = ["api/tick.mjs"]
        dynamic "env" {
          for_each = local.app_env_all
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = local.secret_env.app
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.s[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
        env {
          name  = "ADMINS_HASH"
          value = sha256(jsonencode(local.admin_accounts))
        }
        env {
          name  = "SECRETS_HASH"
          value = local.app_secrets_hash
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.read,
    google_storage_bucket_iam_member.app_state,
    google_project_iam_member.app_logs,
    google_project_iam_member.app_log_view,
  ]
}

# Cloud Scheduler's identity may start this job (roles/run.invoker includes run.jobs.run) and nothing else of the app.
resource "google_cloud_run_v2_job_iam_member" "tick_scheduler" {
  count      = local.app_iap ? 1 : 0
  location   = var.region
  name       = google_cloud_run_v2_job.tick[0].name
  role       = "roles/run.invoker"
  member     = local.scheduler_sa
  depends_on = [google_service_account.scheduler]
}
