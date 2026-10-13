# Once a minute the budget app is asked to apply due budget overrides, revert expired ones and ingest new usage from the
# gateway's logs. The request carries a Google OIDC token for claude-scheduler; Cloud Run IAM admits only that identity
# (plus the admins), and the app verifies the token's signature, audience (SCHEDULER_AUDIENCE) and email (SCHEDULER_SA) itself.

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
    uri         = "${google_cloud_run_v2_service.app.uri}/api/internal/tick"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.scheduler_audience
    }
  }

  depends_on = [google_cloud_run_v2_service_iam_member.app_scheduler, google_project_service.apis]
}
