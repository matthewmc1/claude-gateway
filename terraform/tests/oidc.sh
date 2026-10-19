#!/usr/bin/env bash
# Offline tests for the sign-in (OIDC) rules: what must fail at `terraform plan` instead of in the browser, what only warns,
# and what the admin is told to register at Google. Same harness as run.sh (scratch copy, fake token, empty state).
#
#   terraform/tests/oidc.sh          run only these (about 3 minutes)
#   run.sh sources this file at the end, so the full run includes it
#
# These prove what Terraform can prove. They do NOT prove Google's side (redirect URI acceptance, test users, consent
# screen): that is docs/OAUTH.md section "What cannot be checked offline".

if ! declare -F plan >/dev/null; then ONLY_OIDC=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/run.sh"; fi

# warned <plan name> <text>: did the plan log contain this warning text?   (check blocks print "Check block assertion failed")
warned() { flat "$S/out/$1.log" | grep -qF -- "$2"; }
# expect_warn <description> <plan name> <text> <tfvars...>: plan succeeds AND the warning is printed
expect_warn() {
  local d="$1" n="$2" msg="$3"; shift 3
  if ! plan "$n" "$@"; then bad "$d (the plan failed, but a warning was expected)"; sed -n 1,10p "$S/out/$n.log"; return; fi
  if warned "$n" "$msg"; then ok "$d"; else bad "$d (no warning containing: $msg)"; fi
}
# expect_quiet <description> <plan name> <text> <tfvars...>: plan succeeds AND that warning is NOT printed
expect_quiet() {
  local d="$1" n="$2" msg="$3"; shift 3
  if ! plan "$n" "$@"; then bad "$d (the plan failed)"; sed -n 1,10p "$S/out/$n.log"; return; fi
  if warned "$n" "$msg"; then bad "$d (unexpected warning: $msg)"; else ok "$d"; fi
}

W_REDIR="Google will refuse to save the redirect URI"
W_WSGMAIL="sends hd=<domain> to Google"
W_GMAIL="allowed_email_domains contains gmail.com"
W_SHAPE="does not look like a Google client secret"
W_PLACEHOLDER="PLACEHOLDER OAuth client"

# ============================================================================================================================
section "oidc: the live trial shape (gmail.com, Google, localhost proxy) is what we think it is"
plan o_live "$(tfv o_live <<'TFV'
allowed_email_domains = ["gmail.com"]
public_url            = "http://localhost:8891"
oidc_client_secret    = "GOCSPX-abcdefghijklmnopqrstuvwx"
TFV
)" && {
  O="$S/out/o_live.json"
  assert "redirect URI output is public_url + /oauth/callback, exactly" "$O" '.planned_values.outputs.oidc_redirect_uri.value == "http://localhost:8891/oauth/callback"'
  assert "gmail trial: no hd (consumer accounts have none), offline access + consent prompt only" "$O" '.planned_values.outputs.effective_settings.value | (.oidc_extra_auth_params == {"access_type":"offline","prompt":"consent"} and .allowed_email_domains == ["gmail.com"] and .oidc_configured == true)'
  assert "setup steps print the same redirect URI, Test users, and no 7-day-expiry scare" "$O" '.planned_values.outputs.oidc_setup_steps.value | (contains("http://localhost:8891/oauth/callback") and contains("Test users") and contains("exempts") and (contains("expire after 7 days")|not))'
  assert "setup steps tell what to do about a lost secret and point at docs/OAUTH.md" "$O" '.planned_values.outputs.oidc_setup_steps.value | (contains("only once") and contains("docs/OAUTH.md"))'
  if warned o_live "$W_GMAIL"; then ok "gmail.com allowed: warns that publishing the consent screen opens sign-in to every Gmail account"; else bad "no gmail audience warning"; fi
  warned o_live "$W_REDIR" && bad "localhost must not trigger the redirect host warning" || ok "localhost redirect host: no warning (Google accepts http://localhost)"
  warned o_live "$W_SHAPE" && bad "a GOCSPX- secret must not warn" || ok "GOCSPX- secret: no shape warning"
  warned o_live "$W_PLACEHOLDER" && bad "client id + secret present: no placeholder warning expected" || ok "client id + secret present: not a placeholder"
  grep -q "abcdefghijklmnopqrstuvwxyz12" "$S/out/o_live.log" && bad "the client secret appears in the plan log" || ok "the client secret never appears in the plan output"
}

# ============================================================================================================================
section "oidc: redirect URI per topology"
for u in 'http://localhost:9000' 'http://127.0.0.1:8891' 'https://claude.corp.example.com' 'https://claude.corp.example.com:8443'; do
  n="o_ru_$(printf '%s' "$u" | cksum | cut -d' ' -f1)"
  if plan "$n" "$(tfv "$n" <<<"public_url = \"$u\"")"; then
    assert "public_url $u -> redirect URI $u/oauth/callback" "$S/out/$n.json" ".planned_values.outputs.oidc_redirect_uri.value == \"$u/oauth/callback\""
  else bad "public_url $u failed to plan"; sed -n 1,8 "$S/out/$n.log"; fi
done
# a trailing slash would give Google a different string than the gateway sends ("//oauth/callback" or a mismatch): refuse it
expect_fail "public_url with a trailing slash is refused (it would not match the registered URI)" o_slash "public_url must be an origin" "$(tfv o_slash <<<'public_url = "http://localhost:8891/"')"
expect_fail "http:// to a real hostname is refused (Google and Claude Code accept http only for localhost)" o_http_host "http:// only for localhost" "$(tfv o_http_host <<<'public_url = "http://claude.example.com"')"
expect_fail "http:// with a non-loopback IP is refused" o_http_ip "http:// only for localhost" "$(tfv o_http_ip <<<'public_url = "http://10.1.2.3"')"
plan o_ilb "$(tfv o_ilb <<'TFV'
gateway_exposure = "internal_lb"
gateway_hostname = "claude-gateway.corp.example.com"
TFV
)" && {
  assert "enterprise-iap-ilb: redirect URI is https://<gateway_hostname>/oauth/callback" "$S/out/o_ilb.json" '.planned_values.outputs.oidc_redirect_uri.value == "https://claude-gateway.corp.example.com/oauth/callback"'
  warned o_ilb "$W_REDIR" && bad "a hostname under .com must not trigger the redirect host warning" || ok "enterprise hostname under a public TLD: no redirect host warning"
}

# ============================================================================================================================
section "oidc: Google redirect hosts Google will not accept (warning, plan still works)"
for u in 'https://10.1.2.3' 'https://claude.internal' 'https://gw.corp.lan' 'https://gw.mycompany.local' 'https://gateway' 'https://gw.corp'; do
  n="o_host_$(printf '%s' "$u" | cksum | cut -d' ' -f1)"
  expect_warn "Google + public_url $u: warns that Google refuses this redirect host" "$n" "$W_REDIR" "$(tfv "$n" <<<"public_url = \"$u\"")"
done
for u in 'http://localhost:8891' 'http://127.0.0.1:8891' 'http://[::1]:8891' 'https://claude.example.com' 'https://gw.corp.example.co.uk'; do
  n="o_hostok_$(printf '%s' "$u" | cksum | cut -d' ' -f1)"
  expect_quiet "Google + public_url $u: no host warning" "$n" "$W_REDIR" "$(tfv "$n" <<<"public_url = \"$u\"")"
done
expect_quiet "another IdP + https://claude.internal: no Google host warning (their rules differ)" o_host_okta "$W_REDIR" "$(tfv o_host_okta <<'TFV'
oidc       = { issuer = "https://login.example.org", client_id = "anything" }
public_url = "https://claude.internal"
TFV
)"

# ============================================================================================================================
section "oidc: client id and secret shape"
for id in '123456789012'-'abcdef123456.apps.googleusercontent.com' '1-A_b-c'.'apps.googleusercontent.com'; do
  n="o_idok_$(printf '%s' "$id" | cksum | cut -d' ' -f1)"
  if plan "$n" "$(tfv "$n" <<<"oidc = { client_id = \"$id\" }")"; then ok "Google client id accepted: $id"; else bad "Google client id rejected: $id"; sed -n 1,8 "$S/out/$n.log"; fi
done
for id in 'abcdef.apps.googleusercontent.com' '123-abc.apps.googleusercontent.com.evil.com' '123-abc.googleusercontent.com' '123456789012' 'GOCSPX-abcdefghijklmnopqrstuvwx' '123-abc.apps.googleusercontent.com '; do
  n="o_idbad_$(printf '%s' "$id" | cksum | cut -d' ' -f1)"
  printf 'oidc = { client_id = "%s" }\n' "$id" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then bad "Google client id accepted but wrong: '$id'"; else flat "$S/out/$n.log" | grep -qF "oidc.client_id" && ok "Google client id refused: '$id'" || { bad "'$id' failed for another reason"; sed -n 1,8 "$S/out/$n.log"; }; fi
done
printf 'oidc = { issuer = "https://login.example.org", client_id = "my client" }\n' >"$S/o_idsp.tfvars"
if plan o_idsp "$S/o_idsp.tfvars"; then bad "a client id with a space was accepted"; else flat "$S/out/o_idsp.log" | grep -qF "oidc.client_id contains a space" && ok "any issuer: a client id with a space is refused" || bad "client id space: wrong error"; fi

MARK="Zq9marker7Qz"
for sec in "GOCSPX-${MARK} " "GOCSPX-${MARK}\\n" "GOCSPX ${MARK}"; do
  n="o_secbad_$(printf '%s' "$sec" | cksum | cut -d' ' -f1)"
  printf 'oidc_client_secret = "%s"\n' "$sec" >"$S/$n.tfvars"
  if plan "$n" "$S/$n.tfvars"; then bad "secret with whitespace accepted: $(printf '%s' "$sec" | sed "s/$MARK/<secret>/")"
  else
    flat "$S/out/$n.log" | grep -qF "oidc_client_secret contains a space, tab or newline" && ok "secret with whitespace refused ($(printf '%s' "$sec" | sed "s/$MARK/<secret>/"))" || { bad "secret '$n' failed for another reason"; sed -n 1,8 "$S/out/$n.log"; }
    flat "$S/out/$n.log" | grep -qF "$MARK" && bad "the refused secret is echoed in the error" || ok "the error does not echo the secret"
  fi
done
expect_warn "Google + a secret that is not GOCSPX-shaped: warning, plan still succeeds" o_shape "$W_SHAPE" "$(tfv o_shape <<<"oidc_client_secret = \"${MARK}notagoogleshape\"")"
warned o_shape "$MARK" && bad "the shape warning echoes the secret" || ok "the shape warning does not echo the secret"
expect_quiet "Google + GOCSPX- secret: no shape warning" o_shape_ok "$W_SHAPE" "$(tfv o_shape_ok <<<'oidc_client_secret = "GOCSPX-abcdefghijklmnopqrstuvwx"')"
expect_quiet "another issuer + any secret shape: no Google shape warning" o_shape_okta "$W_SHAPE" "$(tfv o_shape_okta <<'TFV'
oidc               = { issuer = "https://login.example.org", client_id = "anything" }
oidc_client_secret = "plain-okta-secret-value"
TFV
)"
expect_warn "no client id at all: the placeholder warning still fires" o_ph "$W_PLACEHOLDER" "$(tfv o_ph <<<'oidc = {}
oidc_client_secret = null')"

# ============================================================================================================================
section "oidc: Workspace domain vs Gmail"
expect_warn "workspace domain + gmail.com allowed: warns that hd hides Gmail accounts" o_ws_gmail "$W_WSGMAIL" "$(tfv o_ws_gmail <<'TFV'
oidc                  = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com", google_workspace_domain = "corp.example.org" }
allowed_email_domains = ["corp.example.org", "gmail.com"]
TFV
)"
expect_warn "workspace domain + googlemail.com allowed: same warning" o_ws_gm2 "$W_WSGMAIL" "$(tfv o_ws_gm2 <<'TFV'
oidc                  = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com", google_workspace_domain = "corp.example.org" }
allowed_email_domains = ["googlemail.com"]
TFV
)"
expect_quiet "workspace domain alone: no warning" o_ws_only "$W_WSGMAIL" "$(tfv o_ws_only <<'TFV'
oidc                  = { client_id = "123456789012-abcdef123456.apps.googleusercontent.com", google_workspace_domain = "corp.example.org" }
allowed_email_domains = ["corp.example.org"]
TFV
)"
expect_quiet "gmail.com without a workspace domain: no hd warning" o_gm_only "$W_WSGMAIL" "$(tfv o_gm_only <<<'allowed_email_domains = ["gmail.com"]')"
expect_quiet "company domain only: no gmail audience warning" o_corp "$W_GMAIL" "$(tfv o_corp <<<'allowed_email_domains = ["corp.example.org"]')"
expect_quiet "another issuer with gmail.com: no Google audience warning (not Google's consent screen)" o_okta_gmail "$W_GMAIL" "$(tfv o_okta_gmail <<'TFV'
oidc                  = { issuer = "https://login.example.org", client_id = "anything" }
allowed_email_domains = ["gmail.com"]
TFV
)"
