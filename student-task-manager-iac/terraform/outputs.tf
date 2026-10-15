output "worker_name" {
  description = "Name of the deployed Worker."
  value       = cloudflare_workers_script.app.script_name
}

output "kv_namespace_id" {
  description = "ID of the KV namespace that stores tasks."
  value       = cloudflare_workers_kv_namespace.tasks.id
}

output "kv_binding_name" {
  description = "Name of the KV binding inside the Worker code."
  value       = "TASKS_KV"
}

output "worker_url" {
  description = "Public URL of the app (needs the workers_subdomain variable)."
  value       = var.workers_subdomain != "" ? "https://${cloudflare_workers_script.app.script_name}.${var.workers_subdomain}.workers.dev" : "Set workers_subdomain to see the full URL (see README, Step 6)."
}
