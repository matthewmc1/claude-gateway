variable "catalog_json" {
  description = "Contents of config/models.json (the model catalog)."
  type        = string
}

variable "upstreams" {
  description = "Resolved upstreams (every field set)."
  type = list(object({
    provider   = string
    region     = string
    project_id = string
  }))
}

variable "public_url" {
  type = string
}

variable "oidc_issuer" {
  type = string
}

variable "oidc_client_id" {
  type = string
}

variable "extra_auth_params" {
  description = "Extra query parameters for the authorization request (for Google: access_type, prompt, hd)."
  type        = map(string)
  default     = {}
}

variable "allowed_email_domains" {
  type = list(string)
}

variable "admins" {
  description = "One gateway write key per admin: the audit trail records the admin's email."
  type        = list(object({ email = string, key = string }))
}

variable "system_key" {
  description = "Write key the budget app uses for automatic actions (scheduled budget overrides)."
  type        = string
}

variable "blocked_message" {
  type    = string
  default = "Spend cap reached. Ask the platform team for an increase."
}

variable "store_max_connections" {
  description = "store.max_connections: Postgres connections each gateway instance may open (the gateway's own default is 5)."
  type        = number
  default     = 5
}

variable "trusted_proxies" {
  description = "listen.trusted_proxies: hops whose X-Forwarded-For the gateway believes. Cloud Run's front end; with the internal load balancer also its proxy-only subnet."
  type        = list(string)
  default     = ["169.254.0.0/16"]
}

variable "allow_cidrs" {
  description = "access_control.allow_cidrs: client address ranges the gateway accepts. Empty renders no access_control section."
  type        = list(string)
  default     = []
}
