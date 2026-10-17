# Identity-Aware Proxy in front of the budget app (app_access = "iap"). Nothing here exists with app_access = "iam".
#
#   browser -> IAP (Google sign-in, IAM check) -> Cloud Run app, which verifies the signed x-goog-iap-jwt-assertion header itself
#
# Two variants: IAP directly on the Cloud Run URL (default; iap_enabled on the service, no load balancer), or, with app_domain,
# IAP on the backend service of a global external Application Load Balancer (edge_app_lb.tf).
#
# What Terraform CANNOT do (a project without an organization has no way to create these through an API): the OAuth consent
# screen and, for the load-balancer variant, a custom OAuth client. `terraform output edge_next_steps` lists exactly what to click.

# The project NUMBER is part of the IAP audience. Waits for the APIs, so on a first apply it is read during apply.
data "google_project" "this" {
  count      = local.app_iap && var.project_number == null ? 1 : 0
  project_id = var.project_id
  depends_on = [google_project_service.apis]
}

# IAP's service agent (service-<PROJECT_NUMBER>@gcp-sa-iap.iam.gserviceaccount.com) is what calls Cloud Run on behalf of signed-in people.
# Google creates it when IAP is first used, and the GA provider has no resource to create it earlier (google_project_service_identity is
# google-beta only). Ordering that Terraform CAN express: the iap API is enabled first (google_project_service.apis), then this step asks
# Google to create the agent, then the grant waits for the service (direct IAP: iap_enabled is set on it) or the backend service (load
# balancer), which are the places that make Google create it. The command is best effort (gcloud may be missing on the machine that
# applies, or lack the beta component): its failure is ignored and, if the agent really does not exist yet, the grant below stops with
# "service account ... does not exist"; run the same command once by hand and apply again (edge_next_steps says so).
resource "terraform_data" "iap_service_agent" {
  count = local.app_iap && var.iap_create_agent_with_gcloud ? 1 : 0

  triggers_replace = [var.project_id]

  provisioner "local-exec" {
    command    = "gcloud beta services identity create --service=iap.googleapis.com --project='${var.project_id}' || echo 'IAP service agent: could not run gcloud (see edge_next_steps); continuing'"
    on_failure = continue
  }

  depends_on = [google_project_service.apis]
}

# The only run.invoker on the app in IAP mode. Without it IAP answers 403/"Forbidden" after sign-in.
resource "google_cloud_run_v2_service_iam_member" "app_iap_agent" {
  count    = local.app_iap ? 1 : 0
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = local.iap_agent
  depends_on = [
    google_project_service.apis,
    terraform_data.iap_service_agent,
    google_compute_backend_service.app,
    google_iap_web_cloud_run_service_iam_member.app,
    google_iap_web_backend_service_iam_member.app,
  ]
}

# Who may open the app: admins and app_viewers. Never allUsers (the variable validation refuses it).
resource "google_iap_web_cloud_run_service_iam_member" "app" {
  for_each               = local.app_iap_direct ? local.app_iap_members : toset([])
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}

resource "google_iap_web_backend_service_iam_member" "app" {
  for_each            = local.app_iap_lb ? local.app_iap_members : toset([])
  project             = var.project_id
  web_backend_service = google_compute_backend_service.app[0].name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value
}
