# Everything sensitive lives in Secret Manager; Cloud Run reads it at start-up. Terraform state also holds these values,
# so keep the state private (see backend.tf.example).

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

# The budget app's own write key (id "system:overrides"): used for automatic actions such as ending a scheduled budget
# boost, so the audit trail shows those as the system and not as a person.
resource "random_password" "system_key" {
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
}

module "gateway_config" {
  source = "./modules/gateway_config"

  catalog_json          = file("${path.module}/../config/models.json")
  upstreams             = local.upstreams
  public_url            = local.public_url
  oidc_issuer           = var.oidc.issuer
  oidc_client_id        = local.oidc_client_id
  extra_auth_params     = local.extra_auth_params
  allowed_email_domains = local.allowed_email_domains
  admins                = [for a in local.admin_accounts : { email = a.email, key = a.writeKey }]
  system_key            = random_password.system_key.result
  store_max_connections = var.gateway_store_max_connections
}

locals {
  catalog      = module.gateway_config.catalog
  gateway_yaml = module.gateway_config.rendered

  secrets = {
    gateway-config       = { value = local.gateway_yaml, readers = [local.gateway_sa] }
    gateway-jwt          = { value = random_password.jwt.result, readers = [local.gateway_sa] }
    gateway-oidc-secret  = { value = local.oidc_secret, readers = [local.gateway_sa] }
    gateway-postgres-url = { value = "postgres://gateway:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/claude_gateway?sslmode=require", readers = [local.gateway_sa] }
    gateway-read-key     = { value = random_password.read_key.result, readers = [local.gateway_sa, local.app_sa] }
    app-admins           = { value = jsonencode(local.admin_accounts), readers = [local.app_sa] }
    app-session          = { value = random_password.session.result, readers = [local.app_sa] }
    app-system-key       = { value = random_password.system_key.result, readers = [local.app_sa] }
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
  for_each   = local.secret_reader_pairs
  secret_id  = google_secret_manager_secret.s[each.value.name].id
  role       = "roles/secretmanager.secretAccessor"
  member     = each.value.member
  depends_on = [google_service_account.gateway, google_service_account.app]
}
