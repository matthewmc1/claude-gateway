# Outputs of the enterprise edge: what to click (the console-only steps), the audience the app verifies, the CA to distribute.

locals {
  console_iap_url   = "https://console.cloud.google.com/security/iap?project=${var.project_id}"
  console_dns_url   = "https://console.cloud.google.com/net-services/dns/zones?project=${var.project_id}"
  console_edge_cred = "https://console.cloud.google.com/apis/credentials?project=${var.project_id}"
  app_iap_people    = join(", ", sort(tolist(local.app_iap_members)))
  # OAuth "Test users" must be individual Google accounts: group:, domain: and serviceAccount: members cannot be added there.
  app_iap_test_users   = join(", ", sort([for m in local.app_iap_members : trimprefix(m, "user:") if startswith(m, "user:")]))
  app_iap_non_users    = length([for m in local.app_iap_members : m if !startswith(m, "user:")]) > 0
  app_viewers_broad    = length([for m in var.app_viewers : m if startswith(m, "domain:") || startswith(m, "group:")]) > 0
  app_lb_ip            = local.app_iap_lb ? google_compute_global_address.app_lb[0].address : null
  gateway_lb_ip        = local.gateway_lb ? google_compute_address.gateway_lb[0].address : null
  gateway_ca_pem_value = try(nonsensitive(local.gateway_ca_pem), local.gateway_ca_pem)

  edge_steps_app = !local.app_iap ? [] : concat([
    "BUDGET APP BEHIND IAP (app_access = iap${local.app_iap_lb ? ", custom domain ${var.app_domain}" : ", directly on the Cloud Run URL"})",
    "",
    "A1. OAuth consent screen (console only: Terraform and the Google APIs cannot create it in a project without an organization):",
    "      ${local.console_consent_url}",
    "      - Project inside a Google Workspace / Cloud Identity organization: Audience = Internal. Done.",
    "      - Project WITHOUT an organization (for example a personal Gmail account): Audience = External, publishing status = Testing,",
    "        then add each person who should open the app under Test users (individual Google accounts only: ${local.app_iap_test_users}). Up to 100.",
    "        ${local.app_iap_non_users ? "group:/domain:/serviceAccount: members in app_viewers (${local.app_iap_people}) pass IAP's IAM check, but each PERSON in them must still be added as a test user; in an External app in Testing nobody else can sign in." : "All members are individual accounts."}",
    "      If you skip this: IAP cannot complete Google sign-in, so opening the app shows a Google OAuth/consent error instead of the",
    "      app (expected behaviour, not tested here). Nothing else is harmed; do the step and reload.",
    "",
    ],
    local.app_iap_direct ? tolist([
      "A2. Custom OAuth client for the service (needed when anyone OUTSIDE your Google organisation signs in, or when the project has no organisation: Google's docs say the",
      "      Google-managed client serves internal users only; unverified until applied, and Terraform does not set it for direct IAP):",
      "      ${local.console_edge_cred}  ->  Create credentials  ->  OAuth client ID  ->  Web application; edit it and add the authorized redirect URI",
      "        https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect",
      "      then bind it to the service (file with the client id and secret, deleted afterwards; never commit it):",
      "        printf 'accessSettings:\\n  oauthSettings:\\n    clientId: <CLIENT_ID>\\n    clientSecret: <CLIENT_SECRET>\\n' > iap-oauth.yaml",
      "        gcloud iap settings set iap-oauth.yaml --project=${var.project_id} --resource-type=cloud-run --region=${var.region} --service=${local.app_service_name}; rm iap-oauth.yaml",
      "      (Console alternative: ${local.console_iap_url}, the service, More options, Settings, Custom OAuth.) Skipped for an external user: IAP's Google sign-in fails with an OAuth error.",
      "A3. Check IAP is on for the service: ${local.console_iap_url}",
      "      Terraform set iap_enabled on claude-budget-app (Cloud Run launch stage ${var.iap_launch_stage == "BETA" ? "BETA" : "GA"}) and granted roles/iap.httpsResourceAccessor to: ${local.app_iap_people}.",
      "      The IAP service agent got roles/run.invoker on the service. If the page still lists the service with IAP off, enable it there.",
      "      If terraform apply stopped at google_cloud_run_v2_service_iam_member.app_iap_agent with 'service account ... does not exist', create the agent once and apply again:",
      "        gcloud services identity create --service=iap.googleapis.com --project=${var.project_id}",
      "A4. Open the app URL (terraform output app_url) in a browser and sign in with one of those Google accounts. No proxy, no password: admins are the",
      "      emails in admin_users; everyone else who passes IAP is a read-only viewer (view_access = ${var.view_access}).",
      "      Use exactly that URL (Cloud Run's deterministic https://${local.app_service_name}-<project number>.${var.region}.run.app): the app admits only that host, not the older hash-style run.app URL.",
      ]) : tolist([
      "A1b. First apply ordering (unverified): the load balancer's serverless NEG is created before the Cloud Run service it names (a reference would be a cycle). If apply stops at",
      "      google_compute_region_network_endpoint_group.app, set app_domain = null, apply (this creates the service with direct IAP), then set app_domain again and apply.",
      "A2. DNS: create an A record  ${var.app_domain}  ->  the address in terraform output app_lb_ip  at your DNS provider.",
      "      The Google-managed certificate only becomes ACTIVE after the record resolves (minutes up to about an hour):",
      "        gcloud compute ssl-certificates describe claude-budget-app-cert --global --format='value(managed.status)'",
      "A3. OAuth client for IAP (console only):",
      "      ${local.console_edge_cred}  ->  Create credentials  ->  OAuth client ID  ->  Web application. Create it, copy the Client ID,",
      "      then edit the client and add the authorized redirect URI  https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect",
      "      Put the id in iap_oauth_client_id and the secret in iap_oauth_client_secret (TF_VAR_iap_oauth_client_secret), apply again.",
      "      ${var.iap_oauth_client_id == null ? "Not set yet: Terraform enabled IAP on the backend service WITHOUT a client, so it relies on IAP's Google-managed client. Whether your project accepts that is not verified; if sign-in fails, do this step." : "Set: IAP uses client ${var.iap_oauth_client_id}."}",
      "      If apply stopped at app_iap_agent with 'service account ... does not exist': gcloud services identity create --service=iap.googleapis.com --project=${var.project_id}, then apply again.",
      "A4. Open ${local.app_lb_url} and sign in with one of: ${local.app_iap_people}. IAP is on the backend service claude-budget-app-backend; the run.app URL no longer answers from the Internet (ingress: internal load balancer).",
    ]),
    [
      "Who can see what: every person who passes IAP and is not an admin is a read-only viewer and can read ALL per-person usage and e-mails while view_access = ${var.view_access}.",
      local.app_viewers_broad ? "NOTE: app_viewers contains a group: or domain: member, so everyone in it gets that access. Use specific user: members, or view_access = \"admin\", if that is too broad." : "app_viewers lists only specific accounts.",
      "",
    ],
  )

  edge_steps_gateway = !local.gateway_lb ? [] : [
    "GATEWAY BEHIND A PRIVATE INTERNAL LOAD BALANCER (gateway_exposure = internal_lb)",
    "",
    "B1. Name and route (your network, not Terraform): ${var.gateway_hostname} must resolve to the load balancer's private IP (terraform output gateway_lb_ip) from every engineer machine,",
    "    and that address (subnet ${var.lb_subnet_cidr}) must be reachable from there (VPN / Interconnect / peering routes).",
    "      - Terraform created the private Cloud DNS zone '${var.gateway_dns_zone}' for exactly ${var.gateway_hostname} and attached it to the VPC cc-gateway-vpc.",
    "        Only machines that use that VPC's DNS (Cloud Run, VMs) see it.",
    "      - Laptops on a VPN: add the same A record in your corporate DNS, or forward queries for ${var.gateway_hostname} to Cloud DNS",
    "        (inbound server policy; console: ${local.console_dns_url}).",
    "      - Clients in another region of the VPC need lb_allow_global_access = true.",
    "    If skipped: /login in Claude Code fails to connect to ${local.public_url}, and Claude Code refuses a name that resolves to a PUBLIC address.",
    "B2. Test from a machine on that network (expect HTTP 200):  curl --cacert claude-gateway-ca.pem https://${var.gateway_hostname}/healthz",
    "B3. Trust the certificate. ${local.tls_self_signed ? "Mode self_signed: save the CA and distribute it (device management / MDM) to every engineer's OS trust store:\n        terraform output -raw gateway_ca_pem > claude-gateway-ca.pem\n      Claude Code also pins the gateway's leaf fingerprint on first connect: a NEW leaf (certificate renewal, or changing the certificate) means a re-pin.\n      !! SECURITY: this CA's PRIVATE KEY is in the Terraform state (and any saved plan), and the CA cannot be limited to one hostname. Anyone who can read the state can mint\n      !! a certificate for ANY site that every machine trusting this CA will accept. Self-signed is for trials; for production use gateway_tls = { mode = \"provided\" } with your\n      !! corporate PKI (then no CA key exists here), and keep the state in a private bucket either way. The CA is valid 5 years, the leaf 1 year (terraform output gateway_cert_expires);\n      !! the leaf is NOT renewed automatically (a renewal makes Claude Code re-pin): replace it on purpose before it expires with terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]'." : "Mode provided: your certificate must chain to a CA the engineers' machines already trust (recommended for production)."}",
    "B4. Sign-in client (console only): the Google OAuth client's authorized redirect URI must be exactly",
    "      ${local.redirect_uri}",
    "    Google only accepts redirect hosts under a public top-level domain (a real domain you own, such as corp.example.com; not .internal or .local).",
    "    The steps are in: terraform output oidc_setup_steps",
    "B5. Managed settings for engineers' Claude Code. client/claude-gateway-setup.sh install --gateway-url '${local.public_url}' writes forceLoginMethod=gateway and forceLoginGatewayUrl itself; if you deploy managed settings with MDM instead, include:",
    "      ${jsonencode(local.mdm_settings)}",
    length(var.gateway_internal_networks) > 0 ? "    gatewayInternalNetworks (Claude Code 2.1.268 or newer) declares ranges it should treat as internal beyond RFC1918, link-local, CGNAT, ULA." : "    gatewayInternalNetworks is not needed for an RFC1918 address; set gateway_internal_networks only if your load balancer address is outside RFC1918/CGNAT/link-local.",
    "B6. Protection of this gateway: private address + Cloud Run ingress 'internal load balancer' + the gateway's own sign-in and keys. Cloud Run's invoker IAM check is",
    "    OFF for this service (invoker_iam_disabled): Claude Code cannot send a Google token. Do not change the ingress setting.",
    "    If Cloud Run refuses invoker_iam_disabled in your project (an organization policy), this configuration has no fallback: Terraform never grants public access. Ask your administrator to allow it.",
    "    Also: the run.app URL of the gateway is switched off (default_uri_disabled), and an alert fires on the gateway's access.public_client event (a request from a non-private address).",
    "    Client addresses: the gateway trusts X-Forwarded-For from the load balancer (${join(", ", local.gateway_trusted_proxies)}), so its logs and audit events show each engineer's own address.",
    "    Optional hardening: gateway_allow_cidrs (access_control.allow_cidrs) with your engineers' networks, judged on that client address${length(var.gateway_allow_cidrs) > 0 ? "; now: ${join(", ", local.gateway_allow_cidrs)} (cc-gateway-subnet is added for the budget app)" : ""}. Check the client_ip in the gateway's audit events first; a wrong list locks everyone out.",
    "",
  ]

  edge_steps_none = !local.app_iap && !local.gateway_lb ? [
    "No enterprise-edge steps: app_access = iam and gateway_exposure = run_app (the trial topology). Use terraform output next_steps.",
    "To switch: see terraform/examples/enterprise-iap-ilb and terraform/examples/enterprise-iap-custom-domain.",
  ] : []

  edge_steps_end = !local.app_iap && !local.gateway_lb ? [] : [
    "ESTIMATED extra monthly cost (an estimate from list prices; check the Google Cloud pricing page): ${local.edge_cost_text}",
  ]

  edge_cost_text = join("; ", concat(
    local.gateway_lb ? ["internal load balancer: forwarding rule about 18 USD + about 0.008 USD per GB processed; proxy-only subnet, internal address and no NAT: 0; private DNS zone about 0.2 USD + about 0.40 USD per million queries"] : [],
    local.app_iap_lb ? ["custom domain: global load balancer forwarding rule about 18 USD + traffic; managed certificate and IAP: 0"] : [],
    local.app_iap_direct ? ["IAP directly on Cloud Run: 0"] : [],
    local.app_iap ? ["tick as a Cloud Run job once a minute: about 1 vCPU-second x 1440 a day, roughly 0 to 5 USD"] : [],
    local.analytics_bq ? ["BigQuery log sink: storage about 0.02 USD per GB-month, streaming inserts about 0.05 USD per GB, queries are billed to whoever runs them"] : [],
  ))
}

output "edge_next_steps" {
  description = "Plain steps for the enterprise edge, including the ones only the console can do (OAuth consent screen / client, DNS reachability, MDM text), what happens if you skip them, and an estimated cost."
  value       = join("\n", concat(local.edge_steps_none, local.edge_steps_app, local.edge_steps_gateway, local.edge_steps_end))
}

output "iap_audience" {
  description = "IAP_AUDIENCE the budget app verifies (null without app_access = iap). Unknown until apply when the project number or backend service id is not known yet."
  value       = local.iap_audience
}

output "gateway_ca_pem" {
  description = "CA certificate (PEM) that signed the internal load balancer's certificate: distribute it to engineers' machines (MDM). Null unless gateway_exposure = internal_lb with a self-signed certificate or gateway_tls.ca_pem."
  value       = local.gateway_ca_pem_value
}

output "gateway_cert_expires" {
  description = "When the self-signed gateway certificate (leaf) expires (RFC 3339); null with a provided certificate. It is not renewed automatically: rotate it on purpose (terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]') and tell engineers, Claude Code re-pins."
  value       = local.tls_self_signed ? tls_locally_signed_cert.gateway_leaf[0].validity_end_time : null
}

output "gateway_lb_ip" {
  description = "Private IP of the gateway's internal load balancer (gateway_hostname must resolve to it)."
  value       = local.gateway_lb_ip
}

output "app_lb_ip" {
  description = "Public IP of the budget app's load balancer (app_domain): create the DNS A record for app_domain pointing here."
  value       = local.app_lb_ip
}

output "analytics_next_steps" {
  description = "What to do after analytics = bigquery."
  value = !local.analytics_bq ? null : join("\n", [
    "BigQuery dataset ${var.project_id}:${local.bq_dataset_id} (raw, sensitive: client addresses, e-mails) receives the gateway's Cloud Run logs through the sink claude-gateway-to-bigquery; partitions expire after ${local.bq_retention_days} days.",
    "Analysts use ${var.project_id}:${local.bq_analytics_dataset_id}.${local.bq_view_id} only (authorized view${var.analytics_include_emails ? ", WITH the e-mail column (analytics_include_emails)" : ", no e-mail column"}). analytics_readers: ${length(var.analytics_readers) == 0 ? "none yet, so only project owners/editors can query it; add user:/group: members to analytics_readers" : join(", ", var.analytics_readers)}.",
    var.analytics_view ? "The view ${local.bq_view_id} exists: query it, or add it to Looker Studio (BigQuery connector)." : "1. Send one request through the gateway (any Claude Code message). BigQuery creates the table run_googleapis_com_stdout when the first entry arrives (usually within a minute or two).\n2. Set analytics_view = true and run terraform apply: that creates the view v_gateway_requests (it cannot be created before the table exists).",
    "The budget app does not read this dataset; it keeps using Cloud Logging.",
  ])
}
