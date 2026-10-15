terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.17"
    }
  }
}

# The provider reads your API token from the CLOUDFLARE_API_TOKEN environment
# variable. Keeping the token out of .tf and .tfvars files means it cannot be
# committed to GitHub by accident.
provider "cloudflare" {}
