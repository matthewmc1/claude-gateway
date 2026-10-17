# Where Claude 4.6 is served on Vertex AI. A model that is enabled in config/models.json but not served at an upstream's
# location fails at request time (404 from Vertex), so say so at plan time. This is a warning, not an error: Google's list
# can change, and the other models are unaffected. vertex_region keeps its default ("global").
locals {
  claude_4_6_ids     = ["claude-sonnet-4-6", "claude-opus-4-6"]
  claude_4_6_regions = ["global", "us-east5", "europe-west1", "asia-southeast1"]

  claude_4_6_enabled           = [for id in module.gateway_config.available_models : id if contains(local.claude_4_6_ids, id)]
  upstream_regions_without_4_6 = distinct([for u in local.upstreams : u.region if !contains(local.claude_4_6_regions, u.region)])
}

check "claude_4_6_served_in_upstream_regions" {
  assert {
    condition     = length(local.claude_4_6_enabled) == 0 || length(local.upstream_regions_without_4_6) == 0
    error_message = "config/models.json enables ${join(", ", local.claude_4_6_enabled)}, which Vertex AI serves only from ${join(", ", local.claude_4_6_regions)} (not, for example, europe-west2), but an upstream uses ${join(", ", local.upstream_regions_without_4_6)}. Requests for those models through that upstream will fail. Use vertex_region = \"global\" (the default), or add an upstream in a supported region, or set \"enabled\": false on the 4.6 entries."
  }
}
