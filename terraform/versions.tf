terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # The state holds generated passwords and keys. For anything beyond a trial, keep it in a private GCS bucket:
  #   backend "gcs" { bucket = "<your-tfstate-bucket>", prefix = "claude-gateway" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
