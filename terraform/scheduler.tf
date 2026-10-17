# Once a minute the budget app is asked to apply due budget overrides, revert expired ones and ingest new usage from the
# gateway's logs. The request carries a Google OIDC token for claude-scheduler; Cloud Run IAM admits only that identity
# (plus the admins), and the app verifies the token's signature, audience (SCHEDULER_AUDIENCE) and email (SCHEDULER_SA) itself.
# With app_access = "iap" the same job instead starts the Cloud Run job claude-budget-tick through the Run API (tick_job.tf).

resource "google_cloud_scheduler_job" "tick" {
  name             = "claude-budget-tick"
  description      = "Budget app tick: apply and revert budget overrides, ingest usage"
  region           = var.region
  schedule         = var.tick_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = local.app_iap ? "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.tick_job_name}:run" : "${google_cloud_run_v2_service.app.uri}/api/internal/tick"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode("{}")

    # session mode: an OIDC token for the app's own URL. IAP mode: an OAuth token for the Run API (the job is the tick).
    dynamic "oidc_token" {
      for_each = local.app_iap ? [] : [1]
      content {
        service_account_email = google_service_account.scheduler.email
        audience              = local.scheduler_audience
      }
    }
    dynamic "oauth_token" {
      for_each = local.app_iap ? [1] : []
      content {
        service_account_email = google_service_account.scheduler.email
        scope                 = "https://www.googleapis.com/auth/cloud-platform"
      }
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.app_scheduler, google_cloud_run_v2_job_iam_member.tick_scheduler, google_project_service.apis]
}
