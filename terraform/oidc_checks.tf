# Sign-in sanity checks. Warnings (check blocks), not errors: each one describes a setup Google or the gateway will accept
# at apply time but that fails or surprises in the browser. Hard errors live next to the variables (variables.tf: client id
# shape, whitespace in the secret, public_url must be an origin and http:// only for localhost). Rules and sources: docs/OAUTH.md.
locals {
  # Host part of public_url, without port: "localhost", "claude.example.com", "10.1.2.3" or "[::1]".
  public_host = regex("^https?://(\\[[^\\]]+\\]|[^:/]+)", local.public_url)[0]

  public_host_is_loopback = contains(["localhost", "127.0.0.1", "[::1]"], local.public_host)
  public_host_is_raw_ip   = can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", local.public_host)) || startswith(local.public_host, "[")

  # Google only accepts a redirect host that is localhost or a name under a public-suffix-list TLD. We cannot ship the list,
  # so this only recognises the private suffixes people actually use and single-label names.
  public_host_private_suffix = (
    !strcontains(local.public_host, ".") ||
    can(regex("\\.(internal|local|lan|localdomain|localhost|corp|home|intranet|private|test|invalid|example)$", local.public_host))
  )

  gmail_domains         = ["gmail.com", "googlemail.com"]
  allows_consumer_gmail = length(setintersection(toset(local.allowed_email_domains), toset(local.gmail_domains))) > 0
}

check "oidc_google_redirect_host" {
  assert {
    condition     = !local.oidc_is_google || local.public_host_is_loopback || !(local.public_host_is_raw_ip || local.public_host_private_suffix)
    error_message = "Google will refuse to save the redirect URI ${local.redirect_uri}: for a Web application client the host must be localhost or a name under a public top-level domain (no raw IP address, no .internal/.local/.lan/.corp or single-label name). Use a hostname such as claude-gateway.corp.example.com (a private DNS zone is fine, the name just has to end in a real TLD), or use a company IdP (oidc.issuer) that accepts private hosts."
  }
}

check "oidc_workspace_domain_vs_gmail" {
  assert {
    condition     = !local.oidc_is_google || var.oidc.google_workspace_domain == null || !local.allows_consumer_gmail
    error_message = "oidc.google_workspace_domain (${coalesce(var.oidc.google_workspace_domain, "-")}) sends hd=<domain> to Google, which steers the account chooser to that Workspace domain (a UI hint; the gateway enforces allowed_email_domains, not hd), but allowed_email_domains also lists gmail.com/googlemail.com. Personal Gmail accounts have no hd claim, so the chooser is the wrong place for them. For a Gmail trial remove oidc.google_workspace_domain (and use an External consent screen with Test users); for a Workspace organization remove gmail.com from allowed_email_domains."
  }
}

check "oidc_gmail_audience" {
  assert {
    condition     = !local.oidc_is_google || !local.allows_consumer_gmail
    error_message = "allowed_email_domains contains gmail.com: personal Google accounts are accepted. That is right for a trial where the consent screen is External + Testing (only the listed Test users, up to 100, can sign in). If you ever PUBLISH that consent screen, every person with a Gmail account can sign in and spend against your Vertex budget up to the per-person default cap. Keep the app in Testing, or restrict to your own domain."
  }
}

# Google client secrets are GOCSPX- followed by 28 characters. Clients created before 2021 have a 24-character secret without that
# prefix and still work, and other issuers differ completely, hence a warning and only for Google.
check "oidc_secret_shape" {
  assert {
    condition     = !local.oidc_is_google || !local.has_secret || can(regex("^GOCSPX-[A-Za-z0-9_-]{20,}$", var.oidc_client_secret))
    error_message = "oidc_client_secret does not look like a Google client secret (GOCSPX- followed by about 28 letters, digits, - or _). If you copied the Client ID, the client's name or the 'Created' date by mistake, sign-in will fail with invalid_client. Ignore this only for a legacy client created before 2021."
  }
}

# A yes/no derived from the secret, so an error can name the problem without printing the secret.
locals {
  oidc_secret_has_whitespace = var.oidc_client_secret == null ? false : try(nonsensitive(can(regex("\\s", var.oidc_client_secret))), can(regex("\\s", var.oidc_client_secret)))
}
