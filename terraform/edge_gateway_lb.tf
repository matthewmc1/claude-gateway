# Regional INTERNAL Application Load Balancer in front of the gateway (gateway_exposure = "internal_lb"):
#   client -> private IP (forwarding rule, TLS) -> target HTTPS proxy -> URL map -> backend service -> serverless NEG -> Cloud Run
# The gateway's Cloud Run ingress is "internal and load balancing", so nothing outside the VPC can reach it, and its invoker IAM
# check is off (invoker_iam_disabled in run.tf): Claude Code cannot send a Google token. Network + ingress + the gateway's own
# sign-in and keys are what protect it.

resource "google_compute_region_network_endpoint_group" "gateway" {
  count                 = local.gateway_lb ? 1 : 0
  name                  = "claude-gateway-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.gateway.name
  }
}

resource "google_compute_region_backend_service" "gateway" {
  count                 = local.gateway_lb ? 1 : 0
  name                  = "claude-gateway-backend"
  region                = var.region
  load_balancing_scheme = "INTERNAL_MANAGED"
  # HTTP is the value Google's own internal-ALB + Cloud Run guide uses for a serverless NEG backend ("ignored but required": the
  # default would be TCP); the hop to Cloud Run is https regardless. (The app's external backend service keeps HTTPS, as Google's IAP
  # example does.) Rule encoded in terraform/tests/run.sh.
  protocol = "HTTP"
  # Matches the gateway's long streaming responses (Cloud Run request timeout is 3600 s too).
  timeout_sec = 3600

  backend {
    group = google_compute_region_network_endpoint_group.gateway[0].id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_region_url_map" "gateway" {
  count           = local.gateway_lb ? 1 : 0
  name            = "claude-gateway-url-map"
  region          = var.region
  default_service = google_compute_region_backend_service.gateway[0].id
}

# Certificates cannot be edited in place: a changed certificate gets a new name and the proxy switches over first.
resource "google_compute_region_ssl_certificate" "gateway" {
  count       = local.gateway_lb ? 1 : 0
  name_prefix = "claude-gateway-"
  region      = var.region
  certificate = local.gateway_cert_pem
  private_key = local.gateway_key_pem

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_region_ssl_policy" "gateway" {
  count           = local.gateway_lb ? 1 : 0
  name            = "claude-gateway-tls"
  region          = var.region
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_region_target_https_proxy" "gateway" {
  count            = local.gateway_lb ? 1 : 0
  name             = "claude-gateway-https-proxy"
  region           = var.region
  url_map          = google_compute_region_url_map.gateway[0].id
  ssl_certificates = [google_compute_region_ssl_certificate.gateway[0].id]
  ssl_policy       = google_compute_region_ssl_policy.gateway[0].id
}

resource "google_compute_forwarding_rule" "gateway" {
  count                 = local.gateway_lb ? 1 : 0
  name                  = "claude-gateway-lb"
  region                = var.region
  load_balancing_scheme = "INTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_region_target_https_proxy.gateway[0].id
  network               = google_compute_network.vpc.id
  subnetwork            = google_compute_subnetwork.lb[0].id
  ip_address            = google_compute_address.gateway_lb[0].id
  allow_global_access   = var.lb_allow_global_access

  # An ACTIVE proxy-only subnet must exist in the region before the rule can be created.
  depends_on = [google_compute_subnetwork.proxy_only]
}
