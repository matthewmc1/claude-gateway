# TLS for the gateway's internal load balancer, mode "self_signed": a private CA and a leaf certificate for gateway_hostname.
# Claude Code needs https for a non-loopback gateway, pins the leaf's fingerprint on first connect and will not accept a name it
# cannot verify, so the CA (output gateway_ca_pem) has to be distributed to engineers' machines.
#
# SECURITY: the CA's private key lives in the Terraform state/plan files, and the tls provider cannot constrain a CA to one name.
# Whoever can read the state can issue a certificate for any site that the machines trusting this CA accept. Hence: CA valid 5 years
# (not 10), max_path_length 0 (it can sign leaf certificates only, no sub-CAs), leaf valid 1 year, and a loud note in edge_next_steps.
# For production use gateway_tls.mode = "provided" (your corporate PKI): then none of this exists and no CA key is in the state.

resource "tls_private_key" "gateway_ca" {
  count       = local.tls_self_signed ? 1 : 0
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "gateway_ca" {
  count                 = local.tls_self_signed ? 1 : 0
  private_key_pem       = tls_private_key.gateway_ca[0].private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 43800 # 5 years; when it lapses a new CA is made and every machine must trust it again
  max_path_length       = 0     # signs leaf certificates only
  set_subject_key_id    = true
  set_authority_key_id  = true
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name  = "Claude gateway internal CA (${var.project_id})"
    organization = "Claude gateway"
  }
}

resource "tls_private_key" "gateway_leaf" {
  count       = local.tls_self_signed ? 1 : 0
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "gateway_leaf" {
  count           = local.tls_self_signed ? 1 : 0
  private_key_pem = tls_private_key.gateway_leaf[0].private_key_pem
  dns_names       = [var.gateway_hostname]

  subject {
    common_name  = var.gateway_hostname
    organization = "Claude gateway"
  }
}

# One year. Renewal creates a NEW leaf, which Claude Code re-pins, so it is not automatic by default: early_renewal_hours = 0 means the
# leaf is replaced only after it has expired. Rotate on purpose with `terraform apply -replace='tls_locally_signed_cert.gateway_leaf[0]'`
# after announcing it; a `check` (edge_locals.tf) warns in every plan during the last 60 days; output gateway_cert_expires has the date.
resource "tls_locally_signed_cert" "gateway_leaf" {
  count                 = local.tls_self_signed ? 1 : 0
  cert_request_pem      = tls_cert_request.gateway_leaf[0].cert_request_pem
  ca_private_key_pem    = tls_private_key.gateway_ca[0].private_key_pem
  ca_cert_pem           = tls_self_signed_cert.gateway_ca[0].cert_pem
  validity_period_hours = 8760
  early_renewal_hours   = var.gateway_tls_early_renewal_hours
  set_subject_key_id    = true
  allowed_uses          = ["digital_signature", "server_auth"]
}
