# Tracking and monitoring: email notification channels, log-based metrics for the gateway's own events, alert policies
# and one dashboard. Everything here is switched by var.enable_monitoring. Thresholds come from the profile
# (locals.tf) and can be overridden with var.alert_thresholds.
#
# The gateway writes one JSON line per event to Cloud Run's stdout (jsonPayload.evt = inference | spend.blocked |
# auth.denied | admin.denied | ...) and plain text lines for upstream errors ("warn vertex upstream <status> ..."). The
# budget app logs {"evt":"admin.login.failed"} for a refused sign-in. Real shapes (checked against logs/gateway.log and
# tests/e2e/fixtures/gateway-sample.log):
#   {"evt":"inference","status":429,"upstream":"vertex",...}            an inference that reached Vertex (also null upstream + model null for policy rejections)
#   {"evt":"spend.blocked","request_id","sub","cause":"over_limit","cap_cents","source","period"}   a spend cap refused the request; NO inference event is written for it
#   {"evt":"auth.denied","reason":"invalid_token",...}                   routine: every expired session token
#   {"evt":"admin.denied","reason":"no_credentials",...}
#   [gateway] <ts> warn vertex upstream 429 request_id=...: ...           text line (textPayload)
# Cloud Run itself answers some requests (429 when every instance is at its concurrency limit, 503 on startup problems) before
# the container sees them: those exist ONLY in the Cloud Run request_count metric, which is why the 5xx and 429 alerts below
# use it and not the log metrics.

locals {
  mon = var.enable_monitoring ? 1 : 0

  gw_svc  = google_cloud_run_v2_service.gateway.name
  app_svc = google_cloud_run_v2_service.app.name
  sql_id  = "${var.project_id}:${google_sql_database_instance.main.name}"

  log_gw  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\""
  log_app = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.app_svc}\""

  log_metrics = {
    claude_gateway_upstream_errors = {
      description = "Upstream provider errors seen by the gateway (4xx/5xx from Vertex, or an inference event with status >= 500)."
      filter      = "${local.log_gw} AND (textPayload=~\"upstream [45][0-9][0-9]\" OR (jsonPayload.evt=\"inference\" AND jsonPayload.status>=500))"
    }
    claude_gateway_spend_cap_blocks = {
      description = "Requests the gateway refused because a spend cap was reached (evt=spend.blocked; the gateway writes no inference event for these)."
      filter      = "${local.log_gw} AND jsonPayload.evt=\"spend.blocked\""
    }
    # reason=invalid_token happens for EVERY expired session token (sessions last an hour), so it is not security-relevant on its own:
    # it is excluded here and counted separately for the dashboard only.
    claude_gateway_auth_denied = {
      description = "Gateway sign-in or token denials other than an expired/invalid session token (evt=auth.denied, reason != invalid_token)."
      filter      = "${local.log_gw} AND jsonPayload.evt=\"auth.denied\" AND NOT jsonPayload.reason=\"invalid_token\""
    }
    claude_gateway_auth_invalid_token = {
      description = "Gateway requests with an invalid or expired session token (evt=auth.denied, reason=invalid_token). Routine; dashboard only, no alert."
      filter      = "${local.log_gw} AND jsonPayload.evt=\"auth.denied\" AND jsonPayload.reason=\"invalid_token\""
    }
    claude_gateway_admin_denied = {
      description = "Gateway admin API calls refused (evt=admin.denied)."
      filter      = "${local.log_gw} AND jsonPayload.evt=\"admin.denied\""
    }
    claude_app_login_failed = {
      description = "Failed sign-ins to the budget app (evt=admin.login.failed)."
      filter      = "${local.log_app} AND (jsonPayload.evt=\"admin.login.failed\" OR textPayload:\"admin.login.failed\")"
    }
    # ---- budget-app events (stdout JSON, resource.labels.service_name = the app). Boosts edit REAL spend caps unattended, so a boost that
    # is not restored, or an override store that cannot be read, must reach a person. Emitted by api/lib/overrides.mjs and routes.mjs.
    claude_app_override_overdue = {
      description = "override.overdue (warn): an active budget boost is past its end and its cap has NOT been restored. Logged every tick while it lasts."
      filter      = "${local.log_app} AND jsonPayload.evt=\"override.overdue\""
    }
    claude_app_override_error = {
      description = "override.error: a gateway or store step of a budget boost failed; it is retried on the next tick."
      filter      = "${local.log_app} AND jsonPayload.evt=\"override.error\""
    }
    claude_app_override_failed = {
      description = "override.failed: a budget boost could not start (payload has reason)."
      filter      = "${local.log_app} AND jsonPayload.evt=\"override.failed\""
    }
    claude_app_override_lost_claim = {
      description = "override.lost-claim: another worker took a boost item over (rare; a flood means clock trouble)."
      filter      = "${local.log_app} AND jsonPayload.evt=\"override.lost-claim\""
    }
    claude_app_override_creator_removed = {
      description = "override.creator-removed (warn): the admin who created an active boost is no longer an admin. Logged every tick per boost."
      filter      = "${local.log_app} AND jsonPayload.evt=\"override.creator-removed\""
    }
    claude_app_override_superseded = {
      description = "override.superseded: a boost ended without a restore because the cap was changed by hand meanwhile. Dashboard only, no alert."
      filter      = "${local.log_app} AND jsonPayload.evt=\"override.superseded\""
    }
    claude_app_overrides_store_error = {
      description = "overrides.store.error (error): the stored override state could not be read or parsed."
      filter      = "${local.log_app} AND jsonPayload.evt=\"overrides.store.error\""
    }
    claude_app_tick_error = {
      description = "tick.error: the scheduler tick failed inside the app."
      filter      = "${local.log_app} AND jsonPayload.evt=\"tick.error\""
    }
    claude_app_usage_ingest_error = {
      description = "usage.ingest.error: usage ingest from the gateway's logs failed."
      filter      = "${local.log_app} AND jsonPayload.evt=\"usage.ingest.error\""
    }
    claude_app_tick = {
      description = "tick: one authorised scheduler tick was processed by the app (the heartbeat the tick-missing alert watches)."
      filter      = "${local.log_app} AND jsonPayload.evt=\"tick\""
    }
    claude_scheduler_failures = {
      description = "Failed Cloud Scheduler attempts of the budget tick job."
      filter      = "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"${google_cloud_scheduler_job.tick.name}\" AND severity>=ERROR"
    }
  }

  # Only when the gateway can actually scale (max > min): fires when it has been at its ceiling for 10 minutes, which is when
  # Cloud Run starts answering 429.
  at_max_alert = local.gateway_max_instances > local.gateway_min_instances ? {
    gateway-at-max = {
      name      = "Claude gateway: at maximum instances"
      filter    = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\""
      aligner   = "ALIGN_MAX"
      reducer   = "REDUCE_SUM"
      period    = 60
      duration  = 600
      threshold = local.gateway_max_instances - 1
      doc       = "The gateway has run all ${local.gateway_max_instances} allowed instances (gateway_max_instances) for 10 minutes. Cloud Run answers 429 beyond this. Raise gateway_max_instances after checking the Cloud SQL connection budget: instances x gateway_store_max_connections (${var.gateway_store_max_connections}) must fit in the tier's max_connections."
    }
  } : {}

  lm = { for k, _ in local.log_metrics : k => "logging.googleapis.com/user/${k}" }

  # Threshold alerts over a metric. aligner/reducer follow the metric's kind; period and duration are seconds.
  threshold_alerts = {
    gateway-5xx = {
      name      = "Claude gateway: 5xx responses"
      filter    = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\" AND metric.labels.response_code_class=\"5xx\""
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 300
      duration  = 0
      threshold = local.th.gateway_5xx
      doc       = "The gateway returned more than ${local.th.gateway_5xx} 5xx responses in 5 minutes. Check Cloud Run logs for claude-gateway, Cloud SQL health and Vertex quota."
    }
    gateway-429 = {
      name      = "Claude gateway: 429 responses (Cloud Run level)"
      filter    = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\" AND metric.labels.response_code=\"429\""
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 300
      duration  = 0
      threshold = local.th.gateway_429
      doc       = "More than ${local.th.gateway_429} requests were answered with 429 in 5 minutes. This counts every 429 the gateway service returned: Cloud Run shedding load because all ${local.gateway_max_instances} instances are busy (invisible in the gateway's own logs), Vertex quota relayed by the gateway, and spend-cap refusals. Check the \"at maximum instances\" alert, the provider-error and spend-cap alerts, and raise gateway_max_instances if it is capacity (mind the database connection budget)."
    }
    app-5xx = {
      name      = "Claude budget app: 5xx responses"
      filter    = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.app_svc}\" AND metric.labels.response_code_class=\"5xx\""
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 300
      duration  = 0
      threshold = local.th.app_5xx
      doc       = "The budget app returned more than ${local.th.app_5xx} 5xx responses in 5 minutes. Check Cloud Run logs for claude-budget-app; the app talks to the gateway, GCS and Cloud Logging."
    }
    provider-errors = {
      name      = "Claude gateway: provider error burst"
      filter    = "metric.type=\"${local.lm.claude_gateway_upstream_errors}\""
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 300
      duration  = 0
      threshold = local.th.upstream_errors
      doc       = "More than ${local.th.upstream_errors} upstream errors in 5 minutes (counted from both the error text lines and inference events, so roughly double the number of failed requests). Usually Vertex quota (429 RESOURCE_EXHAUSTED) or a regional incident: add an upstream region (docs/DEPLOY.md)."
    }
    spend-cap-blocks = {
      name      = "Claude gateway: spend-cap blocks surge"
      filter    = "metric.type=\"${local.lm.claude_gateway_spend_cap_blocks}\""
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 900
      duration  = 0
      threshold = local.th.spend_cap_blocks
      doc       = "More than ${local.th.spend_cap_blocks} requests were refused in 15 minutes because people hit their spend cap (evt=spend.blocked). Intent: spot a budget that is too tight or someone looping against a cap. Review budgets in the budget app; consider an override for the affected people."
    }
    security-denials = {
      name      = "Claude gateway: auth and admin denials"
      filter    = "metric.type=one_of(\"${local.lm.claude_gateway_auth_denied}\", \"${local.lm.claude_gateway_admin_denied}\", \"${local.lm.claude_app_login_failed}\")"
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 900
      duration  = 0
      threshold = local.th.security_denials
      doc       = "More than ${local.th.security_denials} denied sign-ins (any auth.denied reason except the routine invalid_token of expired sessions), denied admin calls or failed budget-app logins in 15 minutes. Intent: a guessing attempt or a misconfigured client or key. Check evt=auth.denied / admin.denied / admin.login.failed and their reason in the logs."
    }
    sql-cpu = {
      name      = "Claude gateway database: CPU high"
      filter    = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.sql_id}\""
      aligner   = "ALIGN_MEAN"
      reducer   = null
      period    = 300
      duration  = 600
      threshold = local.th.sql_cpu
      doc       = "Cloud SQL CPU above ${local.th.sql_cpu * 100}% for 10 minutes. Move to a larger db_tier."
    }
    sql-disk = {
      name      = "Claude gateway database: disk filling"
      filter    = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.sql_id}\""
      aligner   = "ALIGN_MEAN"
      reducer   = null
      period    = 300
      duration  = 300
      threshold = local.th.sql_disk
      doc       = "Cloud SQL disk above ${local.th.sql_disk * 100}%. The disk grows automatically up to its limit; check what is growing."
    }
    sql-connections = {
      name      = "Claude gateway database: connections high"
      filter    = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.sql_id}\""
      aligner   = "ALIGN_MAX"
      reducer   = null
      period    = 300
      duration  = 300
      threshold = local.th.sql_connections
      doc       = "More than ${local.th.sql_connections} Postgres connections for 5 minutes. Set alert_thresholds.sql_connections to about 80% of your tier's max_connections."
    }
    scheduler-failures = {
      name      = "Claude budget app: scheduler tick failing"
      filter    = "metric.type=\"${local.lm.claude_scheduler_failures}\""
      aligner   = "ALIGN_SUM"
      reducer   = "REDUCE_SUM"
      period    = 600
      duration  = 0
      threshold = local.th.scheduler_failures
      doc       = "The Cloud Scheduler job ${google_cloud_scheduler_job.tick.name} failed more than ${local.th.scheduler_failures} times in 10 minutes, so budget overrides are not being applied or reverted and usage is not being ingested. Check the app's logs and that claude-scheduler still has run.invoker on claude-budget-app."
    }
  }
}

# Budget-boost and tick alerts. "N or more in a window" is a threshold of N - 1 (the alert condition is "greater than"); the
# alert_thresholds keys hold N. Runbook for the boost alerts: docs/DEPLOY.md ("Budget boosts: when an alert fires").
locals {
  boost_runbook = "Runbook: open the budget app, Activity page, and compare each ACTIVE boost's personal cap with its target (the cap it should have been raised to); a boost that is past its end must be cancelled there, which restores the previous limit, or the cap fixed by hand. Logs: claude-budget-app, jsonPayload.evt."
  app_event_alerts = {
    override-overdue = {
      name      = "Claude budget app: boost overdue, cap NOT restored"
      metric    = ["claude_app_override_overdue"]
      period    = 600
      min_count = local.th.override_overdue
      severity  = "CRITICAL"
      doc       = "An active budget boost is past its end time and its spend cap has not been restored (override.overdue, logged every tick while it lasts; ${local.th.override_overdue} or more in 10 minutes). Someone is running above their normal cap unattended. ${local.boost_runbook}"
    }
    override-errors = {
      name      = "Claude budget app: boost steps failing"
      metric    = ["claude_app_override_error"]
      period    = 900
      min_count = local.th.override_errors
      severity  = "ERROR"
      doc       = "${local.th.override_errors} or more override.error events in 15 minutes: gateway or store calls for a boost keep failing (each is retried on the next tick), so starts and restores may be late. Check that the gateway is up and the state bucket is readable. ${local.boost_runbook}"
    }
    override-failed = {
      name      = "Claude budget app: a boost could not start"
      metric    = ["claude_app_override_failed"]
      period    = 1800
      min_count = local.th.override_failed
      severity  = "ERROR"
      doc       = "${local.th.override_failed} or more override.failed events in 30 minutes: a boost could not start. The event's reason says why (for example no cap to extend, or gateway-error after retries). ${local.boost_runbook}"
    }
    override-lost-claim = {
      name      = "Claude budget app: boost claims being lost"
      metric    = ["claude_app_override_lost_claim"]
      period    = 900
      min_count = local.th.override_lost_claim
      severity  = "WARNING"
      doc       = "${local.th.override_lost_claim} or more override.lost-claim events in 15 minutes. A few are normal when two ticks overlap; a flood means two workers fighting over the same items, usually clock trouble or more than one app instance running. Check the app's instance count (should be 1) and the scheduler schedule."
    }
    override-creator-removed = {
      name      = "Claude budget app: boost created by a removed admin"
      metric    = ["claude_app_override_creator_removed"]
      period    = 3600
      min_count = local.th.override_creator_removed
      severity  = "WARNING"
      doc       = "An active boost was created by someone who is no longer in admin_users (override.creator-removed, logged every tick per boost; ${local.th.override_creator_removed} or more in 1 hour). Either an admin left (decide whether the boost should continue; cancel it from the Activity page if not) or the admin list has a typo. ${local.boost_runbook}"
    }
    overrides-store-error = {
      name      = "Claude budget app: override state unreadable"
      metric    = ["claude_app_overrides_store_error"]
      period    = 600
      min_count = local.th.store_errors
      severity  = "CRITICAL"
      doc       = "overrides.store.error: the stored override state cannot be read or parsed (${local.th.store_errors} or more in 10 minutes), so boosts can be neither started nor restored. Check the state bucket (${google_storage_bucket.app_state.name}): permissions, a corrupted object (previous versions are kept: see the restore runbook), and the app's logs. ${local.boost_runbook}"
    }
    tick-errors = {
      name      = "Claude budget app: tick or usage ingest failing"
      metric    = ["claude_app_tick_error", "claude_app_usage_ingest_error"]
      period    = 900
      min_count = local.th.tick_errors
      severity  = "ERROR"
      doc       = "${local.th.tick_errors} or more tick.error or usage.ingest.error events in 15 minutes: the scheduler tick or the usage ingest is failing inside the app, so boosts may not be applied or reverted and usage views go stale. Check the app's logs for the error text, the gateway's availability and the app's access to Cloud Logging."
    }
  }
}

resource "google_monitoring_alert_policy" "app_events" {
  for_each     = var.enable_monitoring ? local.app_event_alerts : {}
  display_name = each.value.name
  combiner     = "OR"
  enabled      = true
  severity     = each.value.severity

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  conditions {
    display_name = each.value.name
    condition_threshold {
      filter          = length(each.value.metric) == 1 ? "metric.type=\"${local.lm[each.value.metric[0]]}\"" : "metric.type=one_of(${join(", ", [for m in each.value.metric : "\"${local.lm[m]}\""])})"
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.min_count - 1
      duration        = "0s"

      aggregations {
        alignment_period     = "${each.value.period}s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = each.value.doc
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.m]
}

# The scheduler ticks every minute and the app logs {"evt":"tick"} for each authorised tick it processes. No tick for 5 minutes means
# boosts are neither applied nor restored. An ABSENCE condition only works once the series has existed (it stays silent until the
# first tick after the deploy) and cannot be exercised offline; it is created only for the default every-minute schedule, because a
# slower tick_schedule would make it fire constantly. Other schedules: see the manual check in docs/DEPLOY.md.
resource "google_monitoring_alert_policy" "tick_missing" {
  count        = var.enable_monitoring && var.tick_schedule == "* * * * *" ? 1 : 0
  display_name = "Claude budget app: scheduler tick missing"
  combiner     = "OR"
  enabled      = true
  severity     = "CRITICAL"

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  conditions {
    display_name = "No tick event for 5 minutes"
    condition_absent {
      filter   = "metric.type=\"${local.lm.claude_app_tick}\""
      duration = "${local.th.tick_missing_minutes * 60}s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = "The budget app has logged no scheduler tick (evt=tick) for ${local.th.tick_missing_minutes} minutes although the job ${google_cloud_scheduler_job.tick.name} runs every minute. Budget boosts are not being applied or restored and usage is not being ingested. Check the scheduler job (paused? failing: see the scheduler-failure alert), that claude-scheduler still has run.invoker on the app, and that the app's SCHEDULER_AUDIENCE matches the job's audience. ${local.boost_runbook}"
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.m]
}

resource "google_monitoring_notification_channel" "email" {
  for_each     = var.enable_monitoring ? toset(local.alert_emails) : toset([])
  display_name = "Claude gateway alerts: ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "m" {
  for_each    = var.enable_monitoring ? local.log_metrics : {}
  name        = each.key
  description = each.value.description
  filter      = each.value.filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "threshold" {
  for_each     = var.enable_monitoring ? merge(local.threshold_alerts, local.at_max_alert) : {}
  display_name = each.value.name
  combiner     = "OR"
  enabled      = true

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  conditions {
    display_name = each.value.name
    condition_threshold {
      filter          = each.value.filter
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      duration        = "${each.value.duration}s"

      aggregations {
        alignment_period     = "${each.value.period}s"
        per_series_aligner   = each.value.aligner
        cross_series_reducer = each.value.reducer
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = each.value.doc
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.m]
}

# The gateway runs with a warm instance (min instances >= 1); no instance for 10 minutes means it is down or stuck
# failing to start. Skipped when the gateway is allowed to scale to zero.
resource "google_monitoring_alert_policy" "gateway_down" {
  count        = var.enable_monitoring && local.gateway_min_instances >= 1 ? 1 : 0
  display_name = "Claude gateway: no running instance"
  combiner     = "OR"
  enabled      = true

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  conditions {
    display_name = "No gateway instance"
    condition_absent {
      filter   = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\""
      duration = "600s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = "No instance of the gateway reported for 10 minutes although min instances is ${local.gateway_min_instances}. Look at the latest revision's logs: a bad image tag, a missing secret or a Cloud SQL connection problem keeps it from starting."
    mime_type = "text/markdown"
  }
}

# ---- dashboard --------------------------------------------------------------------------------------------------------
locals {
  # One tile = title + one or more series. A series is a filter, an aligner, an optional reducer and group-by labels.
  dash_tiles = [
    { title = "Gateway requests / s by status class", series = [{ filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\"", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group = ["metric.labels.response_code_class"] }] },
    { title = "Gateway 429 and 5xx responses (per 5 min, Cloud Run level)", series = [
      { filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\" AND metric.labels.response_code=\"429\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
      { filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\" AND metric.labels.response_code_class=\"5xx\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
    ] },
    { title = "Gateway latency p95 (ms)", series = [{ filter = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\"", aligner = "ALIGN_PERCENTILE_95", reducer = "REDUCE_MAX", group = [] }] },
    { title = "Gateway instances", series = [{ filter = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.gw_svc}\"", aligner = "ALIGN_MAX", reducer = "REDUCE_SUM", group = ["metric.labels.state"] }] },
    { title = "Budget app requests / s by status class", series = [{ filter = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.app_svc}\"", aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group = ["metric.labels.response_code_class"] }] },
    { title = "Budget app latency p95 (ms)", series = [{ filter = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.app_svc}\"", aligner = "ALIGN_PERCENTILE_95", reducer = "REDUCE_MAX", group = [] }] },
    { title = "Cloud SQL CPU utilisation", series = [{ filter = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.sql_id}\"", aligner = "ALIGN_MEAN", reducer = null, group = [] }] },
    { title = "Cloud SQL disk utilisation", series = [{ filter = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.sql_id}\"", aligner = "ALIGN_MEAN", reducer = null, group = [] }] },
    { title = "Cloud SQL connections", series = [{ filter = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${local.sql_id}\"", aligner = "ALIGN_MAX", reducer = null, group = [] }] },
    { title = "Upstream errors and spend-cap blocks (per 5 min)", series = [
      { filter = "metric.type=\"${local.lm.claude_gateway_upstream_errors}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
      { filter = "metric.type=\"${local.lm.claude_gateway_spend_cap_blocks}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
    ] },
    { title = "Denials, failed logins and expired tokens (per 5 min)", series = [
      { filter = "metric.type=\"${local.lm.claude_gateway_auth_denied}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
      { filter = "metric.type=\"${local.lm.claude_gateway_auth_invalid_token}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
      { filter = "metric.type=\"${local.lm.claude_gateway_admin_denied}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
      { filter = "metric.type=\"${local.lm.claude_app_login_failed}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] },
    ] },
    { title = "Budget boosts: problems (per 5 min)", series = [for m in ["claude_app_override_overdue", "claude_app_override_error", "claude_app_override_failed", "claude_app_override_lost_claim", "claude_app_overrides_store_error"] :
    { filter = "metric.type=\"${local.lm[m]}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] }] },
    { title = "Budget boosts: creator removed and superseded (per 5 min)", series = [for m in ["claude_app_override_creator_removed", "claude_app_override_superseded"] :
    { filter = "metric.type=\"${local.lm[m]}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] }] },
    { title = "App ticks, tick errors and usage ingest errors (per 5 min)", series = [for m in ["claude_app_tick", "claude_app_tick_error", "claude_app_usage_ingest_error"] :
    { filter = "metric.type=\"${local.lm[m]}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] }] },
    { title = "Scheduler tick failures (per 5 min)", series = [{ filter = "metric.type=\"${local.lm.claude_scheduler_failures}\"", aligner = "ALIGN_SUM", reducer = "REDUCE_SUM", group = [] }] },
  ]

  dashboard = {
    displayName = "Claude gateway"
    mosaicLayout = {
      columns = 12
      tiles = [for i, t in local.dash_tiles : {
        xPos   = (i % 3) * 4
        yPos   = floor(i / 3) * 4
        width  = 4
        height = 4
        widget = {
          title = t.title
          xyChart = {
            dataSets = [for s in t.series : {
              plotType = "LINE"
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = s.filter
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = s.aligner
                    crossSeriesReducer = s.reducer == null ? "REDUCE_NONE" : s.reducer
                    groupByFields      = s.group
                  }
                }
              }
            }]
            yAxis = { scale = "LINEAR" }
          }
        }
      }]
    }
  }
}

resource "google_monitoring_dashboard" "main" {
  count          = local.mon
  dashboard_json = jsonencode(local.dashboard)
  depends_on     = [google_logging_metric.m]
}
