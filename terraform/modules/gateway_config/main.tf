# Pure function: model catalog + upstreams + admins in, rendered gateway.yaml out. No resources, so the tests can
# render it with fake inputs (terraform/tests/run.sh). The checks below fail the plan with a readable message.

locals {
  catalog = jsondecode(var.catalog_json)
  models  = local.catalog.models

  enabled      = [for m in local.models : m if try(m.enabled, true)]
  default_pick = [for m in local.enabled : m if m.alias == local.catalog.default]
  others       = [for m in local.enabled : m if m.alias != local.catalog.default]

  # Default first: the first entry of availableModels is the default model for engineers.
  ordered_enabled = concat(local.default_pick, local.others)
  available_ids   = [for m in local.ordered_enabled : m.id]

  # Claude Code understands exactly these three aliases.
  pin_aliases = ["SONNET", "OPUS", "HAIKU"]
  pin_groups  = { for m in local.enabled : "ANTHROPIC_DEFAULT_${upper(m.alias)}_MODEL" => m.id... if contains(local.pin_aliases, upper(m.alias)) }
  env_pins    = { for k, v in local.pin_groups : k => v[0] }

  all_ids     = [for m in local.models : m.id]
  all_aliases = [for m in local.models : m.alias]

  rendered = templatefile("${path.module}/gateway.yaml.tftpl", {
    public_url            = var.public_url
    oidc_issuer           = var.oidc_issuer
    oidc_client_id        = var.oidc_client_id
    extra_auth_params     = var.extra_auth_params
    allowed_email_domains = var.allowed_email_domains
    upstreams             = var.upstreams
    available_models      = local.available_ids
    env_pins              = local.env_pins
    admins                = var.admins
    system_key            = var.system_key
    blocked_message       = var.blocked_message
    store_max_connections = var.store_max_connections
  })
}

output "rendered" {
  description = "The gateway.yaml to store in Secret Manager."
  value       = local.rendered

  precondition {
    condition     = length(local.models) > 0 && alltrue([for m in local.models : can(m.id) && can(m.alias)])
    error_message = "config/models.json: every entry in \"models\" needs an \"id\" and an \"alias\"."
  }
  precondition {
    condition     = length(distinct(local.all_ids)) == length(local.all_ids)
    error_message = "config/models.json: model ids must be unique."
  }
  precondition {
    condition     = length(distinct(local.all_aliases)) == length(local.all_aliases)
    error_message = "config/models.json: model aliases must be unique."
  }
  precondition {
    condition     = contains([for m in local.models : m.alias], local.catalog.default)
    error_message = "config/models.json: \"default\" must be the alias of a model in the list (got \"${local.catalog.default}\")."
  }
  precondition {
    condition     = length(local.default_pick) == 1
    error_message = "config/models.json: the default model \"${local.catalog.default}\" must have \"enabled\": true."
  }
  precondition {
    condition     = length(var.admins) > 0 && alltrue([for a in var.admins : length(a.key) >= 32]) && length(var.system_key) >= 32
    error_message = "Gateway admin keys must be at least 32 characters, and at least one admin is required."
  }
}

output "catalog" {
  description = "The decoded model catalog."
  value       = local.catalog
}

output "available_models" {
  description = "Enabled model ids, default first."
  value       = local.available_ids
}

output "env_pins" {
  description = "ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL pins pushed to every engineer."
  value       = local.env_pins
}

output "default_model_id" {
  value = try(local.default_pick[0].id, null)
}

output "default_alias" {
  value = local.catalog.default
}
