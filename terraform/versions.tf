terraform {
  required_version = ">= 1.5"

  required_providers {
    # >= 7.30: google_cloud_run_v2_service.iap_enabled (IAP directly on Cloud Run, used by app_access = "iap") exists in the
    # GA provider only from about 7.30 on (6.50 has it in google-beta only). If you already have a state from 6.x, run
    # `terraform init -upgrade` once and read the plan before applying (docs/DEPLOY.md).
    google = {
      source  = "hashicorp/google"
      version = "~> 8.8"
    }
    # Self-signed CA and leaf certificate for the internal load balancer (gateway_tls.mode = "self_signed").
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # The state holds generated passwords and keys. For anything beyond a trial keep it in a private GCS bucket:
  # copy backend.tf.example to backend.tf and fill in the bucket (docs/DEPLOY.md, "State").
}

provider "google" {
  project = var.project_id
  region  = var.region

  # With user (ADC) credentials, bill API quota to this project instead of a shared default that rate-limits.
  # Not possible while the project itself is being created (create_project).
  user_project_override = !var.create_project
  billing_project       = var.create_project ? null : var.project_id
}
