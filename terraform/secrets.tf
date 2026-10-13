# Everything sensitive lives in Secret Manager; Cloud Run reads it at start-up. Terraform state also holds these values,
# so keep the state private (see versions.tf).

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "random_password" "read_key" {
  length  = 48
  special = false
}

resource "random_password" "session" {
  length  = 48
  special = false
}

# One password and one gateway write key per admin.
resource "random_password" "admin_password" {
  for_each = local.admins
  length   = 20
  special  = false
}

resource "random_password" "admin_key" {
  for_each = local.admins
  length   = 48
  special  = false
}

locals {
  admin_accounts = [for k, a in local.admins : {
    email    = a.email
    name     = a.name
    password = random_password.admin_password[k].result
    writeKey = random_password.admin_key[k].result
  }]

  gateway_yaml = templatefile("${path.module}/templates/gateway.yaml.tftpl", {
    public_url            = var.public_url
    oidc_issuer           = var.oidc_issuer
    oidc_client_id        = var.oidc_client_id
    allowed_email_domains = var.allowed_email_domains
    vertex_region         = var.vertex_region
    project_id            = var.project_id
    allowed_models        = var.allowed_models
    admins                = [for a in local.admin_accounts : { email = a.email, key = a.writeKey }]
  })

  secrets = {
    gateway-config       = { value = local.gateway_yaml, readers = [local.gateway_sa] }
    gateway-jwt          = { value = random_password.jwt.result, readers = [local.gateway_sa] }
    gateway-oidc-secret  = { value = var.oidc_client_secret, readers = [local.gateway_sa] }
    gateway-postgres-url = { value = "postgres://gateway:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/claude_gateway?sslmode=require", readers = [local.gateway_sa] }
    gateway-read-key     = { value = random_password.read_key.result, readers = [local.gateway_sa, local.app_sa] }
    app-admins           = { value = jsonencode(local.admin_accounts), readers = [local.app_sa] }
    app-session          = { value = random_password.session.result, readers = [local.app_sa] }
  }

  secret_reader_pairs = merge([for name, s in local.secrets : { for r in s.readers : "${name}|${r}" => { name = name, member = r } }]...)
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = "claude-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "s" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = each.value.value
}

resource "google_secret_manager_secret_iam_member" "read" {
  for_each  = local.secret_reader_pairs
  secret_id = google_secret_manager_secret.s[each.value.name].id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}
