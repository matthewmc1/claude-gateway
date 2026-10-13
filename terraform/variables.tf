variable "project_id" {
  description = "Google Cloud project that will host the gateway and budget app."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and the image registry."
  type        = string
  default     = "europe-west2"
}

variable "vertex_region" {
  description = "Vertex AI location the gateway sends model traffic to. Claude models are served from \"global\"."
  type        = string
  default     = "global"
}

# ---- who administers budgets ----------------------------------------------------------------------------------------
variable "admin_users" {
  description = <<-EOT
    People who can sign in to the budget app and change budgets. Each gets a generated password and their own gateway
    admin key, so the gateway's audit trail names the person who made a change. They are also granted permission to
    reach the private Cloud Run services (run.invoker). Read the credentials with:
      terraform output -json admin_credentials
  EOT
  type = list(object({
    email = string
    name  = optional(string)
  }))

  validation {
    condition     = length(var.admin_users) > 0
    error_message = "Define at least one admin user."
  }
  validation {
    condition     = alltrue([for a in var.admin_users : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", a.email))])
    error_message = "Every admin needs a valid email address."
  }
}

# ---- sign-in (OIDC) -------------------------------------------------------------------------------------------------
variable "oidc_issuer" {
  description = "OIDC issuer engineers sign in with. Google accounts by default; use your Okta/Entra issuer for a company IdP."
  type        = string
  default     = "https://accounts.google.com"
}

variable "oidc_client_id" {
  description = "OAuth client ID. For Google: a \"Web application\" client whose redirect URI is <public_url>/oauth/callback."
  type        = string
  default     = "REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com"
}

variable "oidc_client_secret" {
  description = "OAuth client secret. Pass it with TF_VAR_oidc_client_secret rather than writing it to a file."
  type        = string
  sensitive   = true
  default     = "placeholder-set-me"
}

variable "allowed_email_domains" {
  description = "Only people with an email in these domains can sign in to the gateway."
  type        = list(string)
}

variable "public_url" {
  description = <<-EOT
    The address engineers' Claude Code connects to; the OIDC redirect is built from it. Claude Code only accepts a
    private or localhost gateway: use http://localhost:8891 with deploy/gcp/proxy.mjs, or the https:// hostname of an
    internal load balancer for a team.
  EOT
  type        = string
  default     = "http://localhost:8891"
}

# ---- models ---------------------------------------------------------------------------------------------------------
variable "allowed_models" {
  description = "Models engineers may use. The first entry is the default (Sonnet 5.5)."
  type        = list(string)
  default     = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]
}

# ---- sizing and images ----------------------------------------------------------------------------------------------
variable "db_tier" {
  description = "Cloud SQL machine tier. db-f1-micro is about $10 a month."
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Block terraform destroy from deleting the database. Turn off only to tear a trial down."
  type        = bool
  default     = true
}

variable "gateway_image_tag" {
  description = "Tag of the gateway image in Artifact Registry (the pinned Claude Code release, e.g. 2.1.296). Built by deploy/build-push.sh."
  type        = string
  default     = "2.1.296"
}

variable "app_image_tag" {
  description = "Tag of the budget-app image in Artifact Registry."
  type        = string
  default     = "latest"
}

variable "gateway_min_instances" {
  description = "Keep this many gateway instances warm (avoids a cold OIDC discovery on first sign-in)."
  type        = number
  default     = 1
}

variable "extra_invokers" {
  description = "Additional people or groups allowed to reach the private services, e.g. [\"group:platform@example.com\"]."
  type        = list(string)
  default     = []
}
