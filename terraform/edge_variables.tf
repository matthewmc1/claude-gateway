# Topology switches. The defaults reproduce the original trial topology exactly (private Cloud Run behind Google IAM, a local
# authenticating proxy, password sign-in to the budget app). Setting them gives the enterprise edge:
#
#   app_access = "iap"                 budget app behind Identity-Aware Proxy (browser, no proxy, no password)
#   gateway_exposure = "internal_lb"   gateway behind a regional INTERNAL Application Load Balancer (private IP, private DNS, TLS)
#
# Claude Code refuses a gateway whose name resolves to a public address and cannot present Google credentials, so the gateway can
# be neither public nor behind IAP: it gets a private address and protects itself (network + ingress + its own sign-in).
# Examples: terraform/examples/.  Steps that need the console: `terraform output edge_next_steps`.

# ---- budget app access ----------------------------------------------------------------------------------------------
variable "app_access" {
  description = <<-EOT
    How people reach the budget app.
    "iam" (default, today): private Cloud Run, Google IAM run.invoker for every admin, reached through the local proxy
      (deploy/proxy.sh) and a password sign-in.
    "iap": Identity-Aware Proxy in front of the app. People open the app URL in a browser, sign in with their Google account
      and the app trusts the signed IAP header (APP_AUTH_MODE=iap). No proxy, no password. Needs a one-time console step for the
      OAuth consent screen in a project without an organization (see `terraform output edge_next_steps`).
      app_domain = null: IAP directly on the Cloud Run URL (no load balancer, no extra cost).
      app_domain set: a custom domain through a global external Application Load Balancer with IAP on the backend service.
  EOT
  type        = string
  default     = "iam"

  validation {
    condition     = contains(["iam", "iap"], var.app_access)
    error_message = "app_access must be \"iam\" (private Cloud Run + proxy, the trial default) or \"iap\" (Identity-Aware Proxy)."
  }
}

variable "app_domain" {
  description = <<-EOT
    OPTIONAL, only with app_access = "iap". A custom domain for the budget app, for example claude-budget.example.com.
    It creates a global external Application Load Balancer (static IP, Google-managed certificate) with IAP on its backend
    service, and the app accepts only that host. Point an A record for the domain at the output app_lb_ip. Null (default): IAP
    directly on the *.run.app URL, which needs no load balancer.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.app_domain == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.app_domain))
    error_message = "app_domain must be a lower-case DNS name such as claude-budget.example.com (no scheme, no path, no port)."
  }
}

variable "app_viewers" {
  description = <<-EOT
    Who may open the budget app through IAP besides the admin_users (who always may): members such as user:a@example.com,
    group:eng@example.com or domain:example.com. Everyone who passes IAP and is not an admin is a read-only viewer (subject to
    view_access). Default: only the admins. Used only with app_access = "iap".
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([for m in var.app_viewers : (
      can(regex("^(user|group|serviceAccount):[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", m)) ||
      can(regex("^domain:([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", m))
    )])
    error_message = "app_viewers entries must look like user:a@example.com, group:eng@example.com, serviceAccount:x@p.iam.gserviceaccount.com or domain:example.com. allUsers, allAuthenticatedUsers, wildcards and bare emails are not accepted."
  }
  validation {
    condition     = alltrue([for m in var.app_viewers : !can(regex("(?i)allusers|allauthenticatedusers", m))])
    error_message = "app_viewers must not contain allUsers or allAuthenticatedUsers: that would let anyone through IAP."
  }
}

variable "iap_allowed_domains" {
  description = "OPTIONAL extra check inside the app (IAP_ALLOWED_DOMAINS): the verified IAP email's domain (and Google's hd claim) must be one of these. IAM members above remain the real access control. Empty = no extra check."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for d in var.iap_allowed_domains : can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", d))])
    error_message = "iap_allowed_domains takes bare domains such as example.com."
  }
}

variable "iap_oauth_client_id" {
  description = <<-EOT
    OPTIONAL, only with app_domain. OAuth client ID IAP uses for the load balancer's backend service. Google cannot create such a
    client through Terraform in a project without an organization: create it in the console (`terraform output edge_next_steps`)
    and put the id here and the secret in iap_oauth_client_secret. Null = let IAP use its Google-managed client (what the
    provider and API allow; NOT verified until you apply, see edge_next_steps).
  EOT
  type        = string
  default     = null
}

variable "iap_oauth_client_secret" {
  description = "OPTIONAL, with iap_oauth_client_id. Prefer TF_VAR_iap_oauth_client_secret or a git-ignored secrets.auto.tfvars."
  type        = string
  sensitive   = true
  default     = null
}

variable "iap_launch_stage" {
  description = "Cloud Run launch stage requested for the app when IAP is enabled directly on it. \"GA\" (default; the field is left unset) because Google's Cloud Run release notes list direct IAP as generally available since 2026-03-13. Asking for \"BETA\" on a feature that is now GA makes Cloud Run report GA back, so every plan would show a launch_stage change: use \"BETA\" only if your project/provider still needs the preview flag."
  type        = string
  default     = "GA"

  validation {
    condition     = contains(["BETA", "GA"], var.iap_launch_stage)
    error_message = "iap_launch_stage must be BETA or GA."
  }
}

variable "project_number" {
  description = "OPTIONAL. The numeric project number, used for IAP_AUDIENCE and the IAP service agent. Null = looked up with the google_project data source (needs resourcemanager.projects.get; read during apply on a first run). Set it to skip the lookup, for example in offline tests."
  type        = string
  default     = null

  validation {
    condition     = var.project_number == null || can(regex("^[0-9]{6,20}$", var.project_number))
    error_message = "project_number is the numeric project NUMBER (digits only), not the project id."
  }
}

# ---- gateway exposure -----------------------------------------------------------------------------------------------
variable "gateway_exposure" {
  description = <<-EOT
    How Claude Code reaches the gateway.
    "run_app" (default, today): private Cloud Run URL guarded by Google IAM; engineers use the local proxy
      (http://localhost:8891).
    "internal_lb": a regional INTERNAL Application Load Balancer with a private IP, a private DNS name (gateway_hostname) and
      TLS, in front of Cloud Run with ingress "internal and load balancing". Claude Code accepts only private addresses and
      cannot send a Google token, so Cloud Run's invoker check is switched off for the gateway (invoker_iam_disabled): what
      protects it is the private network, the ingress setting and the gateway's own sign-in. The URL engineers use is
      https://<gateway_hostname> (public_url is derived from it).
  EOT
  type        = string
  default     = "run_app"

  validation {
    condition     = contains(["run_app", "internal_lb"], var.gateway_exposure)
    error_message = "gateway_exposure must be \"run_app\" (private Cloud Run + local proxy, the trial default) or \"internal_lb\" (internal Application Load Balancer)."
  }
}

variable "gateway_hostname" {
  description = "Required with gateway_exposure = \"internal_lb\": the private DNS name engineers connect to, for example claude-gateway.corp.example.com. It must be a name you control (DNS) and may not be an IP address."
  type        = string
  default     = null

  validation {
    condition     = var.gateway_hostname == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.gateway_hostname))
    error_message = "gateway_hostname must be a lower-case DNS name with at least one dot, such as claude-gateway.corp.example.com (no scheme, port or path; not an IP address)."
  }
}

variable "gateway_dns_zone" {
  description = "Name of the Cloud DNS PRIVATE zone that holds the gateway_hostname record. With gateway_dns_zone_create = true (default) the zone is created for exactly gateway_hostname (so it cannot shadow other names in your domain) and attached to the VPC."
  type        = string
  default     = "claude-gateway-internal"

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$", var.gateway_dns_zone))
    error_message = "gateway_dns_zone is a Cloud DNS zone name: lower-case letters, digits and hyphens, starting with a letter."
  }
}

variable "gateway_dns_zone_create" {
  description = "true: create the private zone. false: reuse an existing private zone named gateway_dns_zone (it must contain gateway_hostname and be visible to this VPC); only the A record is created."
  type        = bool
  default     = true
}

variable "lb_subnet_cidr" {
  description = "Subnet (in the gateway VPC) that holds the internal load balancer's IP address, /29 to /24 (default 10.0.1.0/24). It must lie in a private block (10/8, 172.16/12, 192.168/16, 100.64/10), must not overlap cc-gateway-subnet (10.0.0.0/24), the proxy-only subnet, the Service Networking range Google allocates for Cloud SQL (a /16, chosen by Google) or ranges you route to from your network. The load balancer's address in this range is trusted for X-Forwarded-For (listen.trusted_proxies): put nothing else in it."
  type        = string
  default     = "10.0.1.0/24"

  validation {
    condition     = can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/(3[0-2]|[12]?[0-9])$", var.lb_subnet_cidr)) && try(cidrhost(var.lb_subnet_cidr, 0) == split("/", var.lb_subnet_cidr)[0], false)
    error_message = "lb_subnet_cidr must be an IPv4 CIDR with valid octets (0-255) whose host bits are zero, such as 10.0.1.0/24."
  }
  validation {
    condition     = try(tonumber(split("/", var.lb_subnet_cidr)[1]) >= 24 && tonumber(split("/", var.lb_subnet_cidr)[1]) <= 29, false)
    error_message = "lb_subnet_cidr must be between /24 and /29 (a /24 is plenty; the whole range is trusted for X-Forwarded-For)."
  }
}

variable "proxy_only_subnet_cidr" {
  description = "Regional proxy-only subnet that Google's Envoy proxies use for the internal load balancer (one active per region and VPC). /26 to /22 (Google: /26 minimum, /23 recommended), inside a private block, not overlapping cc-gateway-subnet (10.0.0.0/24), lb_subnet_cidr or the Service Networking range. The gateway trusts X-Forwarded-For from this range, so keep it small."
  type        = string
  default     = "10.0.2.0/23"

  validation {
    condition     = can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/(3[0-2]|[12]?[0-9])$", var.proxy_only_subnet_cidr)) && try(cidrhost(var.proxy_only_subnet_cidr, 0) == split("/", var.proxy_only_subnet_cidr)[0], false)
    error_message = "proxy_only_subnet_cidr must be an IPv4 CIDR with valid octets (0-255) whose host bits are zero, such as 10.0.2.0/23."
  }
  validation {
    condition     = try(tonumber(split("/", var.proxy_only_subnet_cidr)[1]) <= 26 && tonumber(split("/", var.proxy_only_subnet_cidr)[1]) >= 22, false)
    error_message = "proxy_only_subnet_cidr must be between /22 and /26 (Google needs /26 or larger, /23 is recommended; anything wider than /22 would make a huge range a trusted X-Forwarded-For source)."
  }
}

variable "lb_ip" {
  description = "OPTIONAL static IP for the internal load balancer, inside lb_subnet_cidr (not its first two or last two addresses, which Google reserves). Null = Google picks a free address and Terraform reserves it. When set, only this address (/32) is trusted for X-Forwarded-For instead of the whole lb_subnet_cidr."
  type        = string
  default     = null

  validation {
    condition     = var.lb_ip == null || can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$", var.lb_ip))
    error_message = "lb_ip must be an IPv4 address with valid octets (0-255), such as 10.0.1.10."
  }
}

variable "lb_allow_global_access" {
  description = "Let clients in OTHER regions of the VPC (or a VPN/Interconnect attached in another region) reach the internal load balancer. Default false: same region only."
  type        = bool
  default     = false
}

variable "gateway_tls" {
  description = <<-EOT
    TLS certificate of the internal load balancer.
      mode = "provided" (RECOMMENDED for production): your certificate chain from your corporate PKI (cert_pem = leaf then
        intermediates; the private key goes in the SEPARATE sensitive variable gateway_tls_key_pem). Engineers' machines
        already trust that CA, and no CA private key ever exists in Terraform state. ca_pem (optional) is the CA the BUDGET APP
        must trust for its calls to the gateway (GATEWAY_CA_PEM); without it the app only trusts Node's built-in CAs.
      mode = "self_signed" (default, for trials): Terraform creates a private CA (valid 5 years, may not sign intermediates) and a
        leaf certificate for gateway_hostname (valid 1 year) with hashicorp/tls. Engineers' machines must trust that CA (output
        gateway_ca_pem, distribute it with your device management). THE CA PRIVATE KEY LIVES IN THE TERRAFORM STATE, and the CA
        cannot be restricted to one name (the tls provider has no name constraints): whoever can read the state can issue a
        certificate for ANY site that the enrolled machines then trust, so install the CA only where that risk is accepted and
        keep the state tightly private. Claude Code pins the leaf's fingerprint on first connect, so replacing the leaf means a re-pin.
  EOT
  type = object({
    mode     = optional(string, "self_signed")
    cert_pem = optional(string)
    ca_pem   = optional(string)
  })
  default = {}

  validation {
    condition     = contains(["self_signed", "provided"], var.gateway_tls.mode)
    error_message = "gateway_tls.mode must be \"self_signed\" or \"provided\"."
  }
  validation {
    condition     = var.gateway_tls.mode != "provided" || try(length(trimspace(var.gateway_tls.cert_pem)) > 0, false)
    error_message = "gateway_tls.mode = \"provided\" needs cert_pem (PEM text) and the private key in gateway_tls_key_pem. (The key used to be gateway_tls.key_pem; it moved to its own sensitive variable so it never appears in a saved plan.)"
  }
  validation {
    condition     = var.gateway_tls.mode != "provided" || try(can(regex("-----BEGIN CERTIFICATE-----", var.gateway_tls.cert_pem)), false)
    error_message = "gateway_tls.cert_pem must be a PEM certificate (-----BEGIN CERTIFICATE-----)."
  }
}

variable "gateway_tls_key_pem" {
  description = "Private key (PEM) of gateway_tls.cert_pem, only with gateway_tls.mode = \"provided\". Sensitive: put it in a git-ignored *.auto.tfvars or TF_VAR_gateway_tls_key_pem, never in a committed file."
  type        = string
  sensitive   = true
  default     = null
}

variable "gateway_tls_early_renewal_hours" {
  description = "Self-signed mode only. 0 (default): the gateway's leaf certificate (valid 1 year) is replaced only after it has EXPIRED, so an unrelated apply never silently changes it; rotate on purpose with `terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]'` after announcing the new fingerprint (Claude Code re-pins). A value such as 720 renews it automatically on any apply within 720 hours of expiry (engineers then re-pin without notice)."
  type        = number
  default     = 0

  validation {
    condition     = var.gateway_tls_early_renewal_hours >= 0 && var.gateway_tls_early_renewal_hours <= 4320 && floor(var.gateway_tls_early_renewal_hours) == var.gateway_tls_early_renewal_hours
    error_message = "gateway_tls_early_renewal_hours is a whole number of hours between 0 and 4320."
  }
}

variable "gateway_internal_networks" {
  description = "OPTIONAL CIDRs for Claude Code's managed setting gatewayInternalNetworks (Claude Code 2.1.268+): networks it should treat as internal even though they are not RFC1918/CGNAT/link-local. Only used to print the MDM text in edge_next_steps; your internal load balancer address normally needs nothing."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.gateway_internal_networks : can(cidrhost(c, 0))])
    error_message = "gateway_internal_networks entries must be CIDRs such as 10.20.0.0/16."
  }
}

variable "gateway_allow_cidrs" {
  description = <<-EOT
    OPTIONAL client address ranges for gateway.yaml access_control.allow_cidrs (IPv4 CIDRs; only with gateway_exposure =
    "internal_lb"). Empty (default) renders nothing. The gateway judges the CLIENT address it resolves from X-Forwarded-For (it
    trusts the load balancer's address and proxy-only subnet for that, see listen.trusted_proxies in edge_locals.tf), so list your
    engineers' networks (VPN / office ranges), not the load balancer's. cc-gateway-subnet (10.0.0.0/24, where the budget app and the tick
    job call from) is added automatically. A wrong list locks everyone out (403 ip_not_allowlisted; only /healthz and /readyz are
    exempt): check the client_ip the gateway logs first, and watch the access.public_client alert.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.gateway_allow_cidrs : can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/(3[0-2]|[12]?[0-9])$", c)) && try(cidrhost(c, 0) == split("/", c)[0], false)])
    error_message = "gateway_allow_cidrs entries must be IPv4 CIDRs with valid octets and zero host bits, such as 10.0.0.0/8."
  }
  validation {
    condition     = alltrue([for c in var.gateway_allow_cidrs : try(tonumber(split("/", c)[1]) >= 1, false)])
    error_message = "gateway_allow_cidrs must not contain /0 (0.0.0.0/0 allows the whole Internet, which defeats the list)."
  }
}

# ---- analytics ------------------------------------------------------------------------------------------------------
variable "analytics" {
  description = <<-EOT
    "logging" (default): usage lives in Cloud Logging, which the budget app reads. "bigquery": additionally route the gateway's
    logs to a BigQuery dataset (claude_gateway_logs) through a log sink, for analysts and Looker Studio. The app itself keeps
    reading Cloud Logging. The analyst view v_gateway_requests can only be created after the first gateway request has produced a
    BigQuery table: set analytics_view = true and apply again (see `terraform output analytics_next_steps`).
    The raw log tables stay in claude_gateway_logs (every gateway log field, including client addresses and e-mails, readable only by
    project owners/editors and the log sink); the view lives in a SECOND dataset, claude_gateway_analytics, which is an authorized view
    on the first. Analysts get access to that second dataset only, through analytics_readers.
    Cost: BigQuery storage about 0.02 USD per GB-month, streaming inserts about 0.05 USD per GB, queries are billed to whoever runs them.
  EOT
  type        = string
  default     = "logging"

  validation {
    condition     = contains(["logging", "bigquery"], var.analytics)
    error_message = "analytics must be \"logging\" (default) or \"bigquery\"."
  }
}

variable "analytics_view" {
  description = "With analytics = \"bigquery\": create the v_gateway_requests view. Set true only after the first request went through the gateway (BigQuery creates the log table lazily, and a view over a missing table fails)."
  type        = bool
  default     = false
}

variable "analytics_readers" {
  description = "With analytics = \"bigquery\": who may query the analyst view v_gateway_requests (user:, group:, serviceAccount: or domain: members, as in app_viewers). They get roles/bigquery.dataViewer on the analytics dataset ONLY and roles/bigquery.jobUser on the project (needed to run queries; query cost is billed to this project). Empty (default): nobody but project owners/editors."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([for m in var.analytics_readers : (
      can(regex("^(user|group|serviceAccount):[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", m)) ||
      can(regex("^domain:([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", m))
    )])
    error_message = "analytics_readers entries must look like user:a@example.com, group:analysts@example.com, serviceAccount:x@p.iam.gserviceaccount.com or domain:example.com. allUsers, allAuthenticatedUsers, wildcards and bare emails are not accepted."
  }
  validation {
    condition     = alltrue([for m in var.analytics_readers : !can(regex("(?i)allusers|allauthenticatedusers", m))])
    error_message = "analytics_readers must not contain allUsers or allAuthenticatedUsers."
  }
}

variable "analytics_retention_days" {
  description = "With analytics = \"bigquery\": how many days of raw log data the claude_gateway_logs dataset keeps (partition expiration). Null (default) = log_retention_days of the profile (30 for trial, 400 for production), the same as Cloud Logging."
  type        = number
  default     = null

  validation {
    condition     = var.analytics_retention_days == null ? true : (var.analytics_retention_days >= 1 && var.analytics_retention_days <= 3650 && floor(var.analytics_retention_days) == var.analytics_retention_days)
    error_message = "analytics_retention_days is a whole number of days between 1 and 3650."
  }
}

variable "analytics_include_emails" {
  description = "With analytics = \"bigquery\": include the e-mail column (personal data) in the analyst view. Default false: analysts see only the opaque subject id `sub`."
  type        = bool
  default     = false
}

variable "app_security_policy" {
  description = "OPTIONAL, only with app_domain. Name or self link of an existing Cloud Armor security policy (for example one that allows only your office / VPN ranges) to attach to the budget app's backend service. Null (default): none; IAP alone protects the load balancer's public address."
  type        = string
  default     = null
}

variable "iap_create_agent_with_gcloud" {
  description = "app_access = \"iap\": the GA Google provider cannot create IAP's service agent, so Terraform runs `gcloud services identity create --service=iap.googleapis.com` (falling back to `gcloud beta ...`; local-exec, on the machine that applies; a failure is ignored and the later grant tells you what to do) before it grants the agent run.invoker on the app. false: skip that and create the agent yourself (edge_next_steps)."
  type        = bool
  default     = true
}
