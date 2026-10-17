# Default (trial) topology: both services are private and Google IAM guards them (no allUsers). Admins reach them through a local
# authenticating proxy (deploy/proxy.sh) and the gateway session token travels in the normal Authorization header.
# Enterprise edge (edge_variables.tf): app_access = "iap" puts Identity-Aware Proxy in front of the budget app (edge_iap.tf), and
# gateway_exposure = "internal_lb" puts the gateway behind a private internal load balancer (edge_gateway_lb.tf). In that mode the
# gateway's invoker IAM check is off and ONLY the ingress setting (internal load balancer) keeps the Internet out: the one place
# where "private" is not enforced by IAM. No allUsers on the budget app, ever.

locals {
  secret_env = {
    gateway = {
      GATEWAY_JWT_SECRET     = "gateway-jwt"
      OIDC_CLIENT_SECRET     = "gateway-oidc-secret"
      GATEWAY_POSTGRES_URL   = "gateway-postgres-url"
      GATEWAY_ADMIN_READ_KEY = "gateway-read-key"
    }
    app = {
      GATEWAY_ADMIN_READ_KEY   = "gateway-read-key"
      GATEWAY_SYSTEM_WRITE_KEY = "app-system-key"
      APP_ADMINS               = "app-admins"
      APP_SESSION_SECRET       = "app-session"
    }
  }

  # A hash of the VALUES of every secret a service consumes. Cloud Run only picks up a rotated secret when a new revision starts,
  # and the secret references say "latest", so without this a rotated JWT/read/system key, DB password or a late-filled OIDC
  # client secret would change Secret Manager but leave the running revision on the old value. The digest of a high-entropy
  # secret reveals nothing usable; nonsensitive() only unwraps that digest.
  gateway_secret_names   = sort(distinct(concat(values(local.secret_env.gateway), ["gateway-config"])))
  app_secret_names       = sort(distinct(values(local.secret_env.app)))
  gateway_secrets_digest = sha256(join(",", [for n in local.gateway_secret_names : "${n}=${sha256(local.secrets[n].value)}"]))
  app_secrets_digest     = sha256(join(",", [for n in local.app_secret_names : "${n}=${sha256(local.secrets[n].value)}"]))
  gateway_secrets_hash   = try(nonsensitive(local.gateway_secrets_digest), local.gateway_secrets_digest)
  app_secrets_hash       = try(nonsensitive(local.app_secrets_digest), local.app_secrets_digest)

  # internal_lb: the app reaches the gateway at its private hostname and attaches NO Google token (GATEWAY_AUDIENCE empty; the load
  # balancer is the only way in). Browser origin == Host the app sees == its allow-list (custom domain), or the run.app host (suffix).
  app_env = {
    GATEWAY_URL               = local.gateway_lb ? local.gateway_lb_url : google_cloud_run_v2_service.gateway.uri
    GATEWAY_AUDIENCE          = local.gateway_lb ? "" : google_cloud_run_v2_service.gateway.uri
    GATEWAY_SERVICE_NAME      = "claude-gateway"
    APP_ALLOWED_HOST_SUFFIXES = local.app_iap ? "" : ".run.app"
    APP_ALLOWED_ORIGINS       = local.app_iap ? (local.app_lb_url == null ? "" : local.app_lb_url) : "http://localhost:8892"
    APP_VIEW_ACCESS           = var.view_access
    APP_STATE_BUCKET          = google_storage_bucket.app_state.name
    USAGE_SOURCE              = "logs"
    GOOGLE_CLOUD_PROJECT      = var.project_id
    MODELS_JSON               = jsonencode(local.catalog)
  }
  # only when scope_app_log_access is on
  app_env_optional = var.scope_app_log_access ? { USAGE_LOGS_VIEW = local.gateway_log_view } : {}
  # Cloud Scheduler calls the app's tick route with an OIDC token: password-session mode only. With IAP the tick is a Cloud Run job.
  app_env_session = local.app_iap ? {} : {
    SCHEDULER_SA       = local.scheduler_sa_email
    SCHEDULER_AUDIENCE = local.scheduler_audience
  }
  # IAP: the app trusts the signed x-goog-iap-jwt-assertion header (audience below), admins are the verified emails in APP_ADMINS.
  app_env_iap = local.app_iap ? merge(
    { APP_AUTH_MODE = "iap", IAP_AUDIENCE = local.iap_audience },
    length(var.iap_allowed_domains) > 0 ? { IAP_ALLOWED_DOMAINS = join(",", var.iap_allowed_domains) } : {},
    # The exact host the browser uses: the custom domain, or Cloud Run's deterministic URL <service>-<project number>.<region>.run.app
    # (computed, so no reference to the service itself; app_url shows the same host). No suffix wildcard in IAP mode.
    { APP_ALLOWED_HOSTS = local.app_iap_lb ? var.app_domain : local.app_run_host },
  ) : {}
  # The gateway's certificate chains to a private CA: the app must trust it (keys depend on variables only, so for_each stays known).
  app_env_ca = local.gateway_lb && (var.gateway_tls.mode == "self_signed" || var.gateway_tls.ca_pem != null) ? { GATEWAY_CA_PEM = local.gateway_ca_pem } : {}
  # everything the app (and the tick job) gets as plain environment variables
  app_env_all = merge(local.app_env, local.app_env_optional, local.app_env_session, local.app_env_iap, local.app_env_ca)
}

resource "google_cloud_run_v2_service" "gateway" {
  name                = "claude-gateway"
  location            = var.region
  ingress             = local.gateway_lb ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  # internal_lb: Claude Code cannot present a Google token, so the invoker check is off; ingress (internal load balancer only) is the gate.
  invoker_iam_disabled = local.gateway_lb ? true : null
  # internal_lb: also switch off the run.app URL. Ingress "internal and load balancing" still lets the VPC / Private Google Access
  # (and on-prem hosts resolving *.run.app to private.googleapis.com) reach that URL, and with the invoker check off nothing there
  # asks for a token. The load balancer's serverless NEG does not use the URL, and the app calls https://<gateway_hostname>.
  default_uri_disabled = local.gateway_lb ? true : null

  # Cloud Run reports an empty service-level scaling block that this config never sets; ignore it to keep plans clean.
  lifecycle {
    ignore_changes = [scaling]
  }

  template {
    service_account = google_service_account.gateway.email
    timeout         = "3600s"

    scaling {
      min_instance_count = local.gateway_min_instances
      max_instance_count = local.gateway_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.subnet.id
      }
    }

    volumes {
      name = "config"
      secret {
        secret = google_secret_manager_secret.s["gateway-config"].secret_id
        items {
          version = "latest"
          path    = "gateway.yaml"
        }
      }
    }

    containers {
      image = "${local.registry}/gateway:${var.gateway_image_tag}"
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = var.gateway_cpu
          memory = var.gateway_memory
        }
        startup_cpu_boost = true
      }
      # /readyz asks the gateway whether Postgres answers; /healthz is a plain "process is up" (no database), so a database
      # blip never makes Cloud Run restart healthy instances.
      startup_probe {
        http_get {
          path = "/readyz"
          port = 8080
        }
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 24
      }
      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        timeout_seconds   = 3
        period_seconds    = 30
        failure_threshold = 3
      }
      volume_mounts {
        name       = "config"
        mount_path = "/etc/claude"
      }
      dynamic "env" {
        for_each = local.secret_env.gateway
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
      # Changing the rendered config rolls a new revision, so edits to admins, models or OIDC take effect.
      env {
        name  = "CONFIG_HASH"
        value = sha256(local.gateway_yaml)
      }
      # Rolls a new revision when any consumed secret changes (rotation, or the OIDC client secret filled in later).
      env {
        name  = "SECRETS_HASH"
        value = local.gateway_secrets_hash
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.read,
    google_project_iam_member.gateway_vertex,
    google_project_iam_member.gateway_vertex_upstream,
    google_sql_database.gateway,
    google_sql_user.gateway,
  ]
}

resource "google_cloud_run_v2_service" "app" {
  name = "claude-budget-app"
  # IAP directly on the run.app URL needs public ingress (IAP is the gate); behind the custom-domain load balancer only that
  # load balancer may reach it.
  location            = var.region
  ingress             = local.app_iap_lb ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  iap_enabled         = local.app_iap_direct ? true : null
  launch_stage        = local.app_iap_direct && var.iap_launch_stage == "BETA" ? "BETA" : null
  # Custom domain: people come through the load balancer (IAP on its backend service), so the run.app URL is switched off and cannot
  # be used to reach the app any other way. Direct IAP needs the run.app URL (IAP is attached to it).
  default_uri_disabled = local.app_iap_lb ? true : null

  lifecycle {
    ignore_changes = [scaling]
  }

  # The Cloud Scheduler token is minted for this audience (see locals.tf); the app checks signature and aud itself.
  # Not used with IAP: the tick is a Cloud Run job started through the Run API (tick_job.tf).
  custom_audiences = local.app_iap ? null : [local.scheduler_audience]

  template {
    service_account = google_service_account.app.email

    # One instance: the app serialises its own state writes. It scales to zero between scheduler ticks.
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    # internal_lb: the app calls the gateway at its private hostname, so it needs a route into the VPC (same subnet as the gateway).
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
      image = "${local.registry}/budget-app:${local.app_image_tag}"
      ports {
        container_port = 8080
      }
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

  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.read,
    google_storage_bucket_iam_member.app_state,
    google_project_iam_member.app_logs,
    google_project_iam_member.app_log_view,
  ]
}

# ---- who may reach the private services -----------------------------------------------------------------------------
resource "google_cloud_run_v2_service_iam_member" "gateway_invokers" {
  for_each = toset(local.invokers)
  location = var.region
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = each.value
}

# With IAP nobody holds run.invoker on the app directly: IAP's service agent does (edge_iap.tf).
resource "google_cloud_run_v2_service_iam_member" "app_invokers" {
  for_each = local.app_iap ? toset([]) : toset(local.invokers)
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = each.value
}

# The budget app calls the gateway's admin API with its own service identity.
resource "google_cloud_run_v2_service_iam_member" "app_to_gateway" {
  location   = var.region
  name       = google_cloud_run_v2_service.gateway.name
  role       = "roles/run.invoker"
  member     = local.app_sa
  depends_on = [google_service_account.app]
}

moved {
  from = google_cloud_run_v2_service_iam_member.app_scheduler
  to   = google_cloud_run_v2_service_iam_member.app_scheduler[0]
}

# Cloud Scheduler calls the app's tick endpoint with an OIDC token for this identity (not with IAP: the tick is a job then).
resource "google_cloud_run_v2_service_iam_member" "app_scheduler" {
  count      = local.app_iap ? 0 : 1
  location   = var.region
  name       = google_cloud_run_v2_service.app.name
  role       = "roles/run.invoker"
  member     = local.scheduler_sa
  depends_on = [google_service_account.scheduler]
}
