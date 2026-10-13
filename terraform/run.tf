# Both services are private: Google IAM guards them (no allUsers). Admins reach them through a local authenticating
# proxy (deploy/proxy.sh) and the gateway session token travels in the normal Authorization header.

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

  app_env = {
    GATEWAY_URL               = google_cloud_run_v2_service.gateway.uri
    GATEWAY_AUDIENCE          = google_cloud_run_v2_service.gateway.uri
    GATEWAY_SERVICE_NAME      = "claude-gateway"
    APP_ALLOWED_HOST_SUFFIXES = ".run.app"
    APP_ALLOWED_ORIGINS       = "http://localhost:8892"
    APP_VIEW_ACCESS           = var.view_access
    APP_STATE_BUCKET          = google_storage_bucket.app_state.name
    USAGE_SOURCE              = "logs"
    SCHEDULER_SA              = local.scheduler_sa_email
    SCHEDULER_AUDIENCE        = local.scheduler_audience
    GOOGLE_CLOUD_PROJECT      = var.project_id
    MODELS_JSON               = jsonencode(local.catalog)
  }
  # only when scope_app_log_access is on
  app_env_optional = var.scope_app_log_access ? { USAGE_LOGS_VIEW = local.gateway_log_view } : {}
}

resource "google_cloud_run_v2_service" "gateway" {
  name                = "claude-gateway"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

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
  name                = "claude-budget-app"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  lifecycle {
    ignore_changes = [scaling]
  }

  # The Cloud Scheduler token is minted for this audience (see locals.tf); the app checks signature and aud itself.
  custom_audiences = [local.scheduler_audience]

  template {
    service_account = google_service_account.app.email

    # One instance: the app serialises its own state writes. It scales to zero between scheduler ticks.
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = "${local.registry}/budget-app:${local.app_image_tag}"
      ports {
        container_port = 8080
      }
      dynamic "env" {
        for_each = merge(local.app_env, local.app_env_optional)
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

resource "google_cloud_run_v2_service_iam_member" "app_invokers" {
  for_each = toset(local.invokers)
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

# Cloud Scheduler calls the app's tick endpoint with an OIDC token for this identity.
resource "google_cloud_run_v2_service_iam_member" "app_scheduler" {
  location   = var.region
  name       = google_cloud_run_v2_service.app.name
  role       = "roles/run.invoker"
  member     = local.scheduler_sa
  depends_on = [google_service_account.scheduler]
}
