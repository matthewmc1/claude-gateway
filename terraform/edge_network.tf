# Network pieces of the gateway's internal Application Load Balancer (gateway_exposure = "internal_lb"): the subnet holding the
# load balancer's private address, the regional proxy-only subnet Google's Envoy proxies run in, the reserved address, and the
# private Cloud DNS name. Nothing here exists with the default variables.
#
# No firewall rules are created: the load balancer's backend is a serverless NEG (Cloud Run), which needs none, and the VPC has no
# inbound rule that would let anything but the load balancer's own address in.

resource "google_compute_subnetwork" "lb" {
  count         = local.gateway_lb ? 1 : 0
  name          = "cc-gateway-lb-subnet"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = var.lb_subnet_cidr
  description   = "Holds the internal load balancer's address for the Claude gateway."
  # After the Service Networking range: Google picks that /16 itself, so creating the subnets first could race with it. Afterwards
  # Google rejects an overlap with a clear error instead of leaving the choice to timing.
  depends_on = [google_compute_global_address.private_services]
}

# One ACTIVE proxy-only subnet per region and VPC. If the VPC already has one (another load balancer), reuse it: import it here
# or set proxy_only_subnet_cidr to its range.
resource "google_compute_subnetwork" "proxy_only" {
  count         = local.gateway_lb ? 1 : 0
  name          = "cc-gateway-proxy-only"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = var.proxy_only_subnet_cidr
  purpose       = "REGIONAL_MANAGED_PROXY"
  role          = "ACTIVE"
  description   = "Proxy-only subnet for the Claude gateway's internal Application Load Balancer."
  depends_on    = [google_compute_global_address.private_services]
}

resource "google_compute_address" "gateway_lb" {
  count        = local.gateway_lb ? 1 : 0
  name         = "claude-gateway-lb-ip"
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = google_compute_subnetwork.lb[0].id
  address      = var.lb_ip
  description  = "Private address engineers' gateway hostname resolves to."
}

# Private DNS: a zone for exactly the gateway's hostname (so it can never shadow other names in your domain), visible to this VPC.
# Clients OUTSIDE the VPC (laptops on a VPN) do not see a Cloud DNS private zone: see `terraform output edge_next_steps`.
resource "google_dns_managed_zone" "gateway" {
  count       = local.gateway_lb && var.gateway_dns_zone_create ? 1 : 0
  name        = var.gateway_dns_zone
  dns_name    = "${var.gateway_hostname}."
  description = "Private zone for the Claude gateway's internal hostname."
  visibility  = "private"

  private_visibility_config {
    networks {
      network_url = google_compute_network.vpc.id
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_dns_record_set" "gateway" {
  count        = local.gateway_lb ? 1 : 0
  managed_zone = var.gateway_dns_zone_create ? google_dns_managed_zone.gateway[0].name : var.gateway_dns_zone
  name         = "${var.gateway_hostname}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.gateway_lb[0].address]
}
