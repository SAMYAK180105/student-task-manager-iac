variable "cloudflare_account_id" {
  description = "Your Cloudflare account ID (Workers & Pages overview page in the dashboard)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex string."
  }
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker. It becomes part of the workers.dev URL."
  type        = string
  default     = "student-task-manager"
}

variable "kv_namespace_title" {
  description = "Display name of the Workers KV namespace that stores the tasks."
  type        = string
  default     = "student-task-manager-tasks"
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date (YYYY-MM-DD)."
  type        = string
  default     = "2025-09-01"
}

variable "workers_subdomain" {
  description = "Your account's workers.dev subdomain (the part before .workers.dev). Optional: only used to print the full URL in the outputs."
  type        = string
  default     = ""
}
