# 1) The KV namespace: the "database" for tasks.
resource "cloudflare_workers_kv_namespace" "tasks" {
  account_id = var.cloudflare_account_id
  title      = var.kv_namespace_title
}

# 2) The Worker. dist/worker.js is created by `npm run build` and contains the
#    REST API AND the frontend files (HTML, CSS, JS) in one file.
resource "cloudflare_workers_script" "app" {
  account_id         = var.cloudflare_account_id
  script_name        = var.worker_name
  content            = file("${path.module}/../dist/worker.js")
  main_module        = "worker.js"
  compatibility_date = var.compatibility_date

  # 3) The binding: inside the Worker code the namespace is available as env.TASKS_KV.
  bindings = [
    {
      name         = "TASKS_KV"
      type         = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.tasks.id
    }
  ]
}

# 4) Publish the Worker on <worker_name>.<your-subdomain>.workers.dev.
resource "cloudflare_workers_script_subdomain" "app" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.app.script_name
  enabled     = true
}
