output "gateway_url" {
  description = "Cloud Run URL of the gateway (private; reach it through the local proxy)."
  value       = google_cloud_run_v2_service.gateway.uri
}

output "app_url" {
  description = "Cloud Run URL of the budget app (private)."
  value       = google_cloud_run_v2_service.app.uri
}

output "admin_credentials" {
  description = "Initial sign-in for each admin: terraform output -json admin_credentials"
  sensitive   = true
  value       = { for a in local.admin_accounts : a.email => { name = a.name, password = a.password } }
}

output "registry" {
  description = "Artifact Registry path for the images."
  value       = local.registry
}

output "next_steps" {
  value = <<-EOT
    1. Build and push the images (first apply only creates the registry; see terraform/README.md):
         PROJECT_ID=${var.project_id} REGION=${var.region} ../deploy/gcp/02-build-push.sh
    2. Open the private services on localhost (uses your Google login):
         PROJECT_ID=${var.project_id} REGION=${var.region} ../deploy/gcp/05-proxy.sh
         gateway http://localhost:8891    budget app http://localhost:8892
    3. Admin passwords:  terraform output -json admin_credentials
    4. Engineers install with:
         client/claude-gateway-setup.sh install --gateway-url ${var.public_url}
  EOT
}
