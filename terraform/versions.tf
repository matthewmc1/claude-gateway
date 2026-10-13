terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
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
