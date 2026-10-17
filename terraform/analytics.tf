# analytics = "bigquery": the gateway's Cloud Run logs are ALSO routed to a BigQuery dataset, for analysts and Looker Studio. The budget
# app does not use it: it keeps reading Cloud Logging. Nothing here exists with analytics = "logging" (the default).
#
# Two datasets (the authorized-view pattern), because a view in the same dataset as the raw tables isolates nothing:
#   claude_gateway_logs       raw sink tables: every gateway log field (client addresses, e-mails, auth.denied events). Nobody gets access
#                             here except project owners/editors and the sink; partitions expire after analytics_retention_days.
#   claude_gateway_analytics  the view v_gateway_requests (inference events only, no e-mail unless analytics_include_emails). The view is
#                             AUTHORIZED on the raw dataset, so readers of this dataset can query it without reading the raw tables.
# analytics_readers gets roles/bigquery.dataViewer on the second dataset only (+ roles/bigquery.jobUser on the project to run queries).
#
# The log sink writes with its OWN identity (unique_writer_identity), which gets roles/bigquery.dataEditor on the raw dataset only.
# BigQuery creates the log table (run_googleapis_com_stdout) lazily, when the first entry arrives, and a view over a table that does
# not exist yet fails. So the view is created in a second step: send one request through the gateway, then set
# analytics_view = true and apply again (`terraform output analytics_next_steps`). spend.blocked events are not in the view (they have
# their own fields), so "requests" there does not count requests refused for a cap.

locals {
  bq_dataset_id           = "claude_gateway_logs"
  bq_analytics_dataset_id = "claude_gateway_analytics"
  bq_retention_days       = var.analytics_retention_days == null ? local.log_retention_days : var.analytics_retention_days
  bq_view_id              = "v_gateway_requests"
  # Only fields the gateway writes on EVERY inference event: BigQuery adds a column when a field first appears, and a view cannot name
  # a column that does not exist yet (spend.blocked has its own fields, which this view therefore leaves out).
  bq_view_columns = concat(
    ["timestamp AS ts", "jsonPayload.request_id AS request_id", "jsonPayload.sub AS sub"],
    var.analytics_include_emails ? ["jsonPayload.email AS email"] : [],
    [
      "jsonPayload.model AS model",
      "jsonPayload.upstream AS upstream",
      "SAFE_CAST(jsonPayload.status AS INT64) AS status",
      "SAFE_CAST(jsonPayload.ms AS INT64) AS ms",
      "IF(SAFE_CAST(jsonPayload.status AS INT64) < 400, 'ok', 'error') AS outcome",
    ],
  )
  bq_view_sql = "SELECT\n  ${join(",\n  ", local.bq_view_columns)}\nFROM `${var.project_id}.${local.bq_dataset_id}.run_googleapis_com_stdout`\nWHERE jsonPayload.evt = 'inference'\n"
}

resource "google_bigquery_dataset" "gateway_logs" {
  count                      = local.analytics_bq ? 1 : 0
  dataset_id                 = local.bq_dataset_id
  location                   = var.region
  friendly_name              = "Claude gateway logs (raw)"
  description                = "Raw Cloud Run logs of the Claude gateway, routed by a log sink. Sensitive (client addresses, e-mails): analysts use the view in ${local.bq_analytics_dataset_id}."
  delete_contents_on_destroy = local.state_force_destroy
  # Applies to the partitioned tables the sink creates (use_partitioned_tables): partitions older than this are dropped. The whole table is never expired.
  default_partition_expiration_ms = local.bq_retention_days * 24 * 60 * 60 * 1000
  depends_on                      = [google_project_service.apis]
}

resource "google_bigquery_dataset" "analytics" {
  count                      = local.analytics_bq ? 1 : 0
  dataset_id                 = local.bq_analytics_dataset_id
  location                   = var.region
  friendly_name              = "Claude gateway analytics"
  description                = "Analyst view ${local.bq_view_id} over the raw gateway logs (an authorized view: no raw table is readable from here)."
  delete_contents_on_destroy = local.state_force_destroy
  depends_on                 = [google_project_service.apis]
}

resource "google_logging_project_sink" "gateway_bigquery" {
  count                  = local.analytics_bq ? 1 : 0
  name                   = "claude-gateway-to-bigquery"
  description            = "Gateway logs for analysts (the budget app reads Cloud Logging, not this)."
  destination            = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.gateway_logs[0].dataset_id}"
  filter                 = local.log_gw
  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }
}

resource "google_bigquery_dataset_iam_member" "sink_writer" {
  count      = local.analytics_bq ? 1 : 0
  dataset_id = google_bigquery_dataset.gateway_logs[0].dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.gateway_bigquery[0].writer_identity
}

resource "google_bigquery_table" "gateway_requests" {
  count               = local.analytics_bq && var.analytics_view ? 1 : 0
  dataset_id          = google_bigquery_dataset.analytics[0].dataset_id
  table_id            = local.bq_view_id
  description         = "One row per gateway inference event (status, model, user, latency). Source: the log sink's run_googleapis_com_stdout table in ${local.bq_dataset_id}."
  deletion_protection = false

  view {
    query          = local.bq_view_sql
    use_legacy_sql = false
  }
}

# The authorization: the view (in the analytics dataset) may read the raw dataset on its readers' behalf.
resource "google_bigquery_dataset_access" "authorized_view" {
  count      = local.analytics_bq && var.analytics_view ? 1 : 0
  dataset_id = google_bigquery_dataset.gateway_logs[0].dataset_id

  view {
    project_id = var.project_id
    dataset_id = google_bigquery_dataset.analytics[0].dataset_id
    table_id   = google_bigquery_table.gateway_requests[0].table_id
  }
}

# Analysts: read the view's dataset only, and run queries (jobUser is a project role; the query cost is billed to this project).
resource "google_bigquery_dataset_iam_member" "analytics_reader" {
  for_each   = local.analytics_bq ? toset(var.analytics_readers) : toset([])
  dataset_id = google_bigquery_dataset.analytics[0].dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = each.value
}

resource "google_project_iam_member" "analytics_job_user" {
  for_each = local.analytics_bq ? toset(var.analytics_readers) : toset([])
  project  = var.project_id
  role     = "roles/bigquery.jobUser"
  member   = each.value
}
