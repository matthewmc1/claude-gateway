# Both services are private: Google IAM guards them (no allUsers). Admins reach them through a local authenticating
# proxy (deploy/gcp/proxy.mjs) and the gateway session token travels in the normal Authorization header.

locals {
  secret_env = {
    gateway = {
      GATEWAY_JWT_SECRET     = "gateway-jwt"
      OIDC_CLIENT_SECRET     = "gateway-oidc-secret"
      GATEWAY_POSTGRES_URL   = "gateway-postgres-url"
      GATEWAY_ADMIN_READ_KEY = "gateway-read-key"
    }
    app = {
      GATEWAY_ADMIN_READ_KEY = "gateway-read-key"
      APP_ADMINS             = "app-admins"
      APP_SESSION_SECRET     = "app-session"
    }
  }
}

resource "google_cloud_run_v2_service" "gateway" {
  name                = "claude-gateway"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.gateway.email
    timeout         = "3600s"

    scaling {
      min_instance_count = var.gateway_min_instances
      max_instance_count = 2
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
    }
  }

  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.read,
    google_project_iam_member.gateway_vertex,
    google_sql_database.gateway,
    google_sql_user.gateway,
  ]
}

resource "google_cloud_run_v2_service" "app" {
  name                = "claude-budget-app"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.app.email

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = "${local.registry}/budget-app:${var.app_image_tag}"
      ports {
        container_port = 8080
      }
      env {
        name  = "GATEWAY_URL"
        value = google_cloud_run_v2_service.gateway.uri
      }
      env {
        name  = "GATEWAY_AUDIENCE"
        value = google_cloud_run_v2_service.gateway.uri
      }
      env {
        name  = "APP_ALLOWED_HOST_SUFFIXES"
        value = ".run.app"
      }
      env {
        name  = "APP_ALLOWED_ORIGINS"
        value = "http://localhost:8892"
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
    }
  }

  depends_on = [
    google_secret_manager_secret_version.s,
    google_secret_manager_secret_iam_member.read,
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
  location = var.region
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = local.app_sa
}
