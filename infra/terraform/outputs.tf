output "access_oidc_client_id" {
  value = cloudflare_zero_trust_access_application.auth_gateway.saas_app.client_id
}

output "impersonation_clients" {
  value = {
    for name, app in cloudflare_zero_trust_access_application.impersonation : name => app.saas_app.client_id
  }
}

output "d1_databases" {
  value = {
    ragbot           = cloudflare_d1_database.ragbot.uuid
    rag_auth_gateway = cloudflare_d1_database.rag_auth_gateway.uuid
    discovery        = cloudflare_d1_database.discovery.uuid
  }
}

output "queues" {
  value = {
    ai_jobs     = cloudflare_queue.ai_jobs.queue_id
    ai_jobs_dlq = cloudflare_queue.ai_jobs_dlq.queue_id
  }
}

output "secrets_store" {
  value = {
    id   = cloudflare_secrets_store.platy.id
    name = cloudflare_secrets_store.platy.name
  }
}
