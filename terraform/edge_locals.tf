# Values the enterprise-edge files share: which topology is on, the derived URLs, the IAP audience and the cross-variable checks.
# With the default variables every flag below is false and none of the edge resources exist.

locals {
  gateway_lb = var.gateway_exposure == "internal_lb"
  app_iap    = var.app_access == "iap"
  # IAP straight on the Cloud Run URL (no load balancer) or, with app_domain, through a global external load balancer
  app_iap_lb     = local.app_iap && var.app_domain != null
  app_iap_direct = local.app_iap && var.app_domain == null
  analytics_bq   = var.analytics == "bigquery"

  # Literal names: the serverless NEG of the custom-domain variant must not depend on the app service, because the app's
  # IAP_AUDIENCE depends on the NEG's backend service (a reference to the service would be a dependency cycle).
  gateway_service_name = "claude-gateway"
  app_service_name     = "claude-budget-app"
  tick_job_name        = "claude-budget-tick"

  gateway_lb_url = var.gateway_hostname == null ? null : "https://${var.gateway_hostname}"
  app_lb_url     = var.app_domain == null ? null : "https://${var.app_domain}"

  edge_apis = concat(
    local.gateway_lb ? ["dns.googleapis.com"] : [],
    local.app_iap ? ["iap.googleapis.com"] : [],
    local.analytics_bq ? ["bigquery.googleapis.com"] : [],
  )

  # ---- IAP ----
  # IAP_AUDIENCE needs the project NUMBER (not the id). The data source is read during apply on a first run (it waits for the APIs).
  project_number = var.project_number != null ? var.project_number : try(data.google_project.this[0].number, null)
  # Cloud Run direct IAP: /projects/<NUMBER>/locations/<REGION>/services/<NAME>. Load balancer: /projects/<NUMBER>/global/backendServices/<ID>.
  iap_audience = !local.app_iap ? null : (local.app_iap_lb ?
    "/projects/${local.project_number}/global/backendServices/${google_compute_backend_service.app[0].generated_id}" :
    "/projects/${local.project_number}/locations/${var.region}/services/${local.app_service_name}"
  )
  # Cloud Run's deterministic URL host (direct IAP): the one app_url shows and APP_ALLOWED_HOSTS admits. The older hash-style
  # run.app URL of the same service is NOT admitted by the app in IAP mode.
  app_run_host = local.app_iap_direct ? "${local.app_service_name}-${local.project_number}.${var.region}.run.app" : null
  iap_agent    = local.project_number == null ? null : "serviceAccount:service-${local.project_number}@gcp-sa-iap.iam.gserviceaccount.com"
  # Admins always may open the app; app_viewers adds more people. Everyone but an admin is a read-only viewer inside the app.
  app_iap_members = local.app_iap ? toset(concat([for a in local.admins : "user:${a.email}"], var.app_viewers)) : toset([])

  # ---- gateway TLS ----
  tls_self_signed  = local.gateway_lb && var.gateway_tls.mode == "self_signed"
  gateway_cert_pem = local.gateway_lb ? (local.tls_self_signed ? "${tls_locally_signed_cert.gateway_leaf[0].cert_pem}${tls_self_signed_cert.gateway_ca[0].cert_pem}" : var.gateway_tls.cert_pem) : null
  gateway_key_pem  = local.gateway_lb ? (local.tls_self_signed ? tls_private_key.gateway_leaf[0].private_key_pem : var.gateway_tls_key_pem) : null
  # What the budget app and the engineers' machines must trust. Null with a provided certificate and no ca_pem.
  gateway_ca_pem = local.gateway_lb ? (local.tls_self_signed ? tls_self_signed_cert.gateway_ca[0].cert_pem : var.gateway_tls.ca_pem) : null

  # The gateway only trusts forwarded client addresses from these hops. The gateway resolves the client by walking X-Forwarded-For
  # from the RIGHT and returning the first hop that is not trusted, provided the TCP peer is trusted. Behind the internal load
  # balancer the header ends "...,<client>,<load balancer forwarding-rule address>" (Google documents that layout), so the
  # forwarding-rule address (in lb_subnet_cidr, or exactly lb_ip when you pinned it) must be trusted, or the gateway would resolve
  # EVERY client to the load balancer itself. The proxy-only subnet (Google's Envoy proxies, the load balancer's source addresses
  # towards Cloud Run) is trusted too, in case Cloud Run's front end records that hop. Both ranges are Google-controlled and are
  # validated to be small private ranges; keep lb_subnet_cidr for the load balancer only. A client cannot spoof its way in: a
  # client-supplied prefix is to the LEFT of the first untrusted hop and is ignored.
  gateway_lb_trust        = var.lb_ip != null ? "${var.lb_ip}/32" : var.lb_subnet_cidr
  gateway_trusted_proxies = concat(["169.254.0.0/16"], local.gateway_lb ? [local.gateway_lb_trust, var.proxy_only_subnet_cidr] : [])

  # access_control.allow_cidrs, judged on the resolved client address. The budget app and the tick job call the gateway through the
  # same load balancer from cc-gateway-subnet, so that range is always added when a list is set (otherwise the app would lock
  # itself out with a 403 ip_not_allowlisted). Empty list = no access_control section at all.
  gateway_allow_cidrs = length(var.gateway_allow_cidrs) == 0 ? [] : distinct(concat(var.gateway_allow_cidrs, [google_compute_subnetwork.subnet.ip_cidr_range]))

  # ---- CIDR arithmetic (cidrcontains needs Terraform 1.8; this module supports 1.5) ----
  # [start, start + size) as numbers, for the ranges the module creates or must not collide with.
  cidr_inputs = {
    app   = google_compute_subnetwork.subnet.ip_cidr_range
    lb    = var.lb_subnet_cidr
    proxy = var.proxy_only_subnet_cidr
  }
  cidr_span = { for k, c in local.cidr_inputs : k => {
    start = sum([for i, o in split(".", cidrhost(c, 0)) : tonumber(o) * pow(256, 3 - i)])
    size  = pow(2, 32 - tonumber(split("/", c)[1]))
  } }
  private_blocks = [for c in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"] : {
    start = sum([for i, o in split(".", cidrhost(c, 0)) : tonumber(o) * pow(256, 3 - i)])
    end   = sum([for i, o in split(".", cidrhost(c, 0)) : tonumber(o) * pow(256, 3 - i)]) + pow(2, 32 - tonumber(split("/", c)[1])) - 1
  }]
  cidr_overlap = {
    lb_proxy = local.cidr_span.lb.start < local.cidr_span.proxy.start + local.cidr_span.proxy.size && local.cidr_span.proxy.start < local.cidr_span.lb.start + local.cidr_span.lb.size
    lb_app   = local.cidr_span.lb.start < local.cidr_span.app.start + local.cidr_span.app.size && local.cidr_span.app.start < local.cidr_span.lb.start + local.cidr_span.lb.size
    pr_app   = local.cidr_span.proxy.start < local.cidr_span.app.start + local.cidr_span.app.size && local.cidr_span.app.start < local.cidr_span.proxy.start + local.cidr_span.proxy.size
  }
  cidr_private = { for k in ["lb", "proxy"] : k => anytrue([for b in local.private_blocks : local.cidr_span[k].start >= b.start && local.cidr_span[k].start + local.cidr_span[k].size - 1 <= b.end]) }
  # the Service Networking range, once Google has allocated it (null before)
  psa_start = try(sum([for i, o in split(".", google_compute_global_address.private_services.address) : tonumber(o) * pow(256, 3 - i)]), null)
  # lb_ip as a number; Google reserves the first two and last two addresses of every subnet.
  lb_ip_num = var.lb_ip == null ? null : sum([for i, o in split(".", var.lb_ip) : tonumber(o) * pow(256, 3 - i)])

  # ---- engineer-facing text ----
  mdm_settings = merge(
    { forceLoginGatewayUrl = local.public_url },
    length(var.gateway_internal_networks) > 0 ? { gatewayInternalNetworks = var.gateway_internal_networks } : {},
  )
}

# Cross-variable checks (variable validation cannot see other variables in Terraform 1.5).
resource "terraform_data" "edge_checks" {
  lifecycle {
    precondition {
      condition     = !local.gateway_lb || var.gateway_hostname != null
      error_message = "gateway_exposure = \"internal_lb\" needs gateway_hostname (for example claude-gateway.corp.example.com): the private DNS name engineers connect to."
    }
    precondition {
      condition     = local.gateway_lb || var.gateway_hostname == null
      error_message = "gateway_hostname is only used with gateway_exposure = \"internal_lb\". Remove it, or set gateway_exposure = \"internal_lb\"."
    }
    precondition {
      condition     = !local.gateway_lb ? true : (var.public_url == null ? true : trimsuffix(var.public_url, "/") == local.gateway_lb_url)
      error_message = "With gateway_exposure = \"internal_lb\", public_url is derived as https://<gateway_hostname> (${local.gateway_lb_url == null ? "unset" : local.gateway_lb_url}). Remove public_url, or make it exactly that."
    }
    precondition {
      condition     = !local.gateway_lb || var.gateway_tls.mode == "self_signed" || var.gateway_tls_key_pem != null
      error_message = "gateway_tls.mode = \"provided\" needs the private key in gateway_tls_key_pem (sensitive; a git-ignored *.auto.tfvars or TF_VAR_gateway_tls_key_pem)."
    }
    precondition {
      condition     = !local.gateway_lb || var.gateway_tls.mode == "self_signed" || var.gateway_tls.ca_pem == null || can(regex("-----BEGIN CERTIFICATE-----", var.gateway_tls.ca_pem))
      error_message = "gateway_tls.ca_pem must be a PEM certificate (-----BEGIN CERTIFICATE-----)."
    }
    precondition {
      condition     = !local.gateway_lb || !local.cidr_overlap.lb_proxy
      error_message = "lb_subnet_cidr (${var.lb_subnet_cidr}) and proxy_only_subnet_cidr (${var.proxy_only_subnet_cidr}) must be different ranges and must not overlap."
    }
    precondition {
      condition     = !local.gateway_lb || (!local.cidr_overlap.lb_app && !local.cidr_overlap.pr_app)
      error_message = "lb_subnet_cidr and proxy_only_subnet_cidr must not overlap cc-gateway-subnet (${google_compute_subnetwork.subnet.ip_cidr_range}, the subnet of the gateway, the app and the tick job). Google would refuse the subnet after other resources were already changed."
    }
    precondition {
      condition     = !local.gateway_lb || (local.cidr_private.lb && local.cidr_private.proxy)
      error_message = "lb_subnet_cidr and proxy_only_subnet_cidr must each lie entirely inside one private block: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 100.64.0.0/10. (The proxy-only range is also trusted for X-Forwarded-For.)"
    }
    precondition {
      condition     = (!local.gateway_lb || var.lb_ip == null) ? true : (local.lb_ip_num >= local.cidr_span.lb.start + 2 && local.lb_ip_num <= local.cidr_span.lb.start + local.cidr_span.lb.size - 3)
      error_message = "lb_ip (${var.lb_ip == null ? "unset" : var.lb_ip}) must lie inside lb_subnet_cidr (${var.lb_subnet_cidr}), excluding the first two and last two addresses of the subnet, which Google reserves."
    }
    precondition {
      condition     = var.lb_ip == null || local.gateway_lb
      error_message = "lb_ip is only used with gateway_exposure = \"internal_lb\". Remove it, or set gateway_exposure = \"internal_lb\"."
    }
    precondition {
      condition     = var.app_domain == null || var.gateway_hostname == null || var.app_domain != var.gateway_hostname
      error_message = "gateway_hostname and app_domain must be different names (the gateway is private, the budget app is behind IAP)."
    }
    precondition {
      condition     = length(var.gateway_allow_cidrs) == 0 || local.gateway_lb
      error_message = "gateway_allow_cidrs is only meaningful with gateway_exposure = \"internal_lb\": without the internal load balancer the gateway sees Google front-end addresses and the local proxy, not your clients, and a list would lock everyone out."
    }
    precondition {
      condition     = var.app_domain == null || local.app_iap
      error_message = "app_domain needs app_access = \"iap\" (the custom domain is the load balancer in front of IAP)."
    }
    precondition {
      condition     = (var.iap_oauth_client_id == null) == (var.iap_oauth_client_secret == null)
      error_message = "Set iap_oauth_client_id and iap_oauth_client_secret together, or neither."
    }
    precondition {
      condition     = var.iap_oauth_client_id == null || var.app_domain != null
      error_message = "iap_oauth_client_id / iap_oauth_client_secret apply to the custom-domain load balancer (app_domain). Direct IAP on Cloud Run takes no client from Terraform."
    }
    precondition {
      condition     = !local.app_iap || length(local.admins) > 0
      error_message = "app_access = \"iap\" needs at least one admin_users entry (admins are the IAP-verified emails the app treats as administrators)."
    }
    precondition {
      condition     = length(var.analytics_readers) == 0 || local.analytics_bq
      error_message = "analytics_readers needs analytics = \"bigquery\"."
    }
    precondition {
      condition     = var.app_security_policy == null || local.app_iap_lb
      error_message = "app_security_policy attaches a Cloud Armor policy to the custom-domain load balancer: it needs app_access = \"iap\" and app_domain."
    }
    precondition {
      condition     = var.analytics_view ? local.analytics_bq : true
      error_message = "analytics_view = true needs analytics = \"bigquery\"."
    }
  }
}

# Warnings (not errors): things that work but that the person applying should look at.
check "gateway_tls_ca_for_app" {
  assert {
    condition     = !local.gateway_lb || var.gateway_tls.mode == "self_signed" || var.gateway_tls.ca_pem != null
    error_message = "gateway_tls.mode = \"provided\" without ca_pem: the budget app then trusts only Node's built-in certificate authorities for its calls to https://<gateway_hostname>. If your certificate comes from a private or corporate CA, set gateway_tls.ca_pem, otherwise the app cannot read usage and budgets."
  }
}

# Self-signed leaf certificate: valid 1 year and NOT renewed automatically (see gateway_tls_early_renewal_hours), so say so before it
# expires. A TLS failure never reaches Cloud Run's request metrics, so the 5xx alerts stay quiet when it lapses. The check is skipped
# while the expiry date is not known yet (first plan). plantimestamp() needs Terraform 1.5.
check "gateway_leaf_expiry" {
  assert {
    condition     = !local.tls_self_signed ? true : timecmp(tls_locally_signed_cert.gateway_leaf[0].validity_end_time, timeadd(plantimestamp(), "1440h")) > 0
    error_message = "The self-signed gateway certificate expires within 60 days (terraform output gateway_cert_expires). When it lapses Claude Code can no longer connect to the gateway. Replace it on purpose and tell engineers it will re-pin: terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]'. (Better: gateway_tls.mode = \"provided\" with your corporate PKI.)"
  }
}

# The Service Networking range for Cloud SQL is a /16 that Google picks; the subnets above are created after it so Google rejects an
# overlap itself, but a pre-existing state can hold a range chosen earlier. Compared after the first apply (the address is unknown before).
check "lb_subnets_vs_service_networking" {
  assert {
    condition = !local.gateway_lb ? true : (
      !(local.psa_start < local.cidr_span.lb.start + local.cidr_span.lb.size && local.cidr_span.lb.start < local.psa_start + pow(2, 32 - google_compute_global_address.private_services.prefix_length)) &&
      !(local.psa_start < local.cidr_span.proxy.start + local.cidr_span.proxy.size && local.cidr_span.proxy.start < local.psa_start + pow(2, 32 - google_compute_global_address.private_services.prefix_length))
    )
    error_message = "lb_subnet_cidr or proxy_only_subnet_cidr overlaps the private-services range ${google_compute_global_address.private_services.address}/${google_compute_global_address.private_services.prefix_length} that Cloud SQL uses. Choose other ranges."
  }
}
