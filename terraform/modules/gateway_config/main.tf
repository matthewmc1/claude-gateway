# Pure function: model catalog + upstreams + admins in, rendered gateway.yaml out. No resources, so the tests can
# render it with fake inputs (terraform/tests/run.sh). The checks below fail the plan with a readable message.

locals {
  catalog = jsondecode(var.catalog_json)
  models  = local.catalog.models

  # Claude Code understands exactly these three aliases. An entry belongs to a family (its "family", else its alias when that is one
  # of these) and PINS it (sets ANTHROPIC_DEFAULT_<FAMILY>_MODEL for everyone) when "pin" is true, or by default when alias == family.
  families = ["sonnet", "opus", "haiku"]
  raw_info = [for m in local.models : {
    alias        = m.alias
    id           = m.id
    enabled      = try(m.enabled, true)
    family       = try(m.family, contains(local.families, lower(m.alias)) ? lower(m.alias) : null)
    explicit_pin = try(m.pin, null)
  }]
  info = [for m in local.raw_info : merge(m, {
    pinned = m.enabled == true && m.family != null && (m.explicit_pin != null ? m.explicit_pin == true : m.family == lower(m.alias))
  })]

  enabled       = [for m in local.info : m if m.enabled == true]
  default_ref   = try(local.catalog.default, try(local.enabled[0].alias, null))
  default_match = local.default_ref == null ? [] : [for m in local.info : m if lower(m.alias) == lower(local.default_ref) || m.id == local.default_ref]
  default_pick  = [for m in local.default_match : m if m.enabled == true]
  others        = [for m in local.enabled : m if length(local.default_pick) == 0 ? true : m.id != local.default_pick[0].id]

  # Default first: the first entry of availableModels is the default model for engineers.
  ordered_enabled = concat(local.default_pick, local.others)
  available_ids   = [for m in local.ordered_enabled : m.id]

  # One pinned entry per family (validated below); pin_groups lists aliases for the error message, pin_ids the ids to pin.
  pin_groups = { for m in local.enabled : "ANTHROPIC_DEFAULT_${upper(m.family)}_MODEL" => m.alias... if m.pinned }
  pin_ids    = { for m in local.enabled : "ANTHROPIC_DEFAULT_${upper(m.family)}_MODEL" => m.id... if m.pinned }
  env_pins   = { for k, v in local.pin_ids : k => v[0] }

  all_ids     = [for m in local.info : m.id]
  all_aliases = [for m in local.info : lower(m.alias)]

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
    trusted_proxies       = var.trusted_proxies
    allow_cidrs           = var.allow_cidrs
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
    error_message = "config/models.json: model aliases must be unique (compared case-insensitively)."
  }
  precondition {
    condition     = alltrue([for m in local.models : !can(m.enabled) || try(m.enabled, null) == true || try(m.enabled, null) == false])
    error_message = "config/models.json: \"enabled\" must be true or false."
  }
  precondition {
    condition     = alltrue([for m in local.models : !can(m.family) || try(contains(local.families, m.family), false)])
    error_message = "config/models.json: \"family\" must be one of sonnet, opus, haiku."
  }
  precondition {
    condition     = alltrue([for m in local.models : !can(m.pin) || try(m.pin, null) == true || try(m.pin, null) == false])
    error_message = "config/models.json: \"pin\" must be true or false."
  }
  precondition {
    condition     = alltrue([for m in local.info : m.explicit_pin != true || m.family != null])
    error_message = "config/models.json: a model with \"pin\": true needs a \"family\" (sonnet, opus or haiku), for example the entry ${join(", ", [for m in local.info : m.alias if m.explicit_pin == true && m.family == null])}."
  }
  precondition {
    condition     = alltrue([for m in local.info : m.explicit_pin != true || m.enabled == true])
    error_message = "config/models.json: a model with \"pin\": true must have \"enabled\": true (${join(", ", [for m in local.info : m.alias if m.explicit_pin == true && m.enabled != true])})."
  }
  precondition {
    condition     = alltrue([for k, v in local.pin_groups : length(v) == 1])
    error_message = "config/models.json: more than one model pins the same family (${join("; ", [for k, v in local.pin_groups : "${k}: ${join(", ", v)}" if length(v) > 1])}). Only one may; set \"pin\": false on the others (to make a newer or older version the default, give it \"pin\": true and the current one \"pin\": false)."
  }
  precondition {
    condition     = length(local.models) == 0 || length(local.enabled) > 0
    error_message = "config/models.json: every model is disabled (\"enabled\": false). Enable at least one and make it the \"default\"."
  }
  precondition {
    condition     = length(local.default_match) > 0 || length(local.enabled) == 0
    error_message = "config/models.json: \"default\" must be the alias or id of a model in the list (got \"${local.default_ref == null ? "" : local.default_ref}\")."
  }
  precondition {
    condition     = length(local.default_match) == 0 || length(local.default_pick) == 1
    error_message = "config/models.json: the default model \"${local.default_ref == null ? "" : local.default_ref}\" must have \"enabled\": true (and must name exactly one model)."
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
  description = "ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL pins pushed to every engineer (only entries that pin their family)."
  value       = local.env_pins
}

output "default_model_id" {
  value = try(local.default_pick[0].id, null)
}

output "default_alias" {
  value = try(local.default_pick[0].alias, null)
}
