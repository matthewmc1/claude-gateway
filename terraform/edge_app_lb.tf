# Custom domain for the budget app (app_access = "iap" and app_domain set): a global EXTERNAL Application Load Balancer with a
# Google-managed certificate and IAP on its backend service. The app's Cloud Run ingress is then "internal and load balancing", so the
# run.app URL is no longer reachable from the Internet. The load balancer's address is public, IAP is the gate.
# Without app_domain none of this exists (IAP sits directly on the Cloud Run URL).
#
# Cost reminder (estimate): a forwarding rule is about 18 USD a month plus traffic; the managed certificate and IAP are free.

resource "google_compute_global_address" "app_lb" {
  count        = local.app_iap_lb ? 1 : 0
  name         = "claude-budget-app-ip"
  address_type = "EXTERNAL"
  depends_on   = [google_project_service.apis]
}

# The service is referenced by its literal name (see edge_locals.tf): the app's IAP_AUDIENCE contains this backend service's id.
# ORDERING (unverified until a first apply): this NEG is created BEFORE the Cloud Run service it points to, because a reference to the
# service would be a dependency cycle (service env IAP_AUDIENCE -> backend service id -> NEG -> service). If Google refuses a NEG whose
# service does not exist yet, the first apply fails at this resource. Recovery: set app_domain = null, apply (direct IAP creates the
# service), then set app_domain and apply again; nothing else needs to change (docs/DEPLOY.md).
resource "google_compute_region_network_endpoint_group" "app" {
  count                 = local.app_iap_lb ? 1 : 0
  name                  = "claude-budget-app-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = local.app_service_name
  }
}

resource "google_compute_backend_service" "app" {
  count                 = local.app_iap_lb ? 1 : 0
  name                  = "claude-budget-app-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  # Optional Cloud Armor policy (for example allow only your office / VPN ranges). IAP is the gate either way.
  security_policy = var.app_security_policy

  backend {
    group = google_compute_region_network_endpoint_group.app[0].id
  }

  # With a custom client: the id and secret from the console (edge_next_steps). Without: IAP's Google-managed client, if your
  # project allows it (not verified until applied).
  iap {
    enabled              = true
    oauth2_client_id     = var.iap_oauth_client_id
    oauth2_client_secret = var.iap_oauth_client_secret
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_url_map" "app" {
  count           = local.app_iap_lb ? 1 : 0
  name            = "claude-budget-app-url-map"
  default_service = google_compute_backend_service.app[0].id
}

# Provisioning needs the domain's A record to point at app_lb_ip first, then takes from several minutes to about an hour.
resource "google_compute_managed_ssl_certificate" "app" {
  count = local.app_iap_lb ? 1 : 0
  name  = "claude-budget-app-cert"

  managed {
    domains = [var.app_domain]
  }
}

resource "google_compute_ssl_policy" "app" {
  count           = local.app_iap_lb ? 1 : 0
  name            = "claude-budget-app-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "app" {
  count            = local.app_iap_lb ? 1 : 0
  name             = "claude-budget-app-https-proxy"
  url_map          = google_compute_url_map.app[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.app[0].id]
  ssl_policy       = google_compute_ssl_policy.app[0].id
}

resource "google_compute_global_forwarding_rule" "app" {
  count                 = local.app_iap_lb ? 1 : 0
  name                  = "claude-budget-app-lb"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_target_https_proxy.app[0].id
  ip_address            = google_compute_global_address.app_lb[0].id
}
