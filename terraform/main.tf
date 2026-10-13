locals {
  admins     = { for a in var.admin_users : lower(a.email) => { email = lower(a.email), name = coalesce(a.name, split("@", a.email)[0]) } }
  registry   = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  invokers   = concat([for a in local.admins : "user:${a.email}"], var.extra_invokers)
  apis       = ["run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "aiplatform.googleapis.com", "compute.googleapis.com", "servicenetworking.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "logging.googleapis.com"]
  gateway_sa = "serviceAccount:${google_service_account.gateway.email}"
  app_sa     = "serviceAccount:${google_service_account.app.email}"
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
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

# The gateway reaches Claude on Vertex AI with this identity (Application Default Credentials). No key files exist.
resource "google_project_iam_member" "gateway_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = local.gateway_sa
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
  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled    = false # private IP only
      private_network = google_compute_network.vpc.id
    }
    backup_configuration {
      enabled = true
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
