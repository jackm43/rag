output "oidc_client_id" {
  description = "Set this as ACCESS_OIDC_CLIENT_ID in wrangler.jsonc vars"
  value       = cloudflare_zero_trust_access_application.ragbot_admin.saas_app.client_id
}

output "access_application_id" {
  value = cloudflare_zero_trust_access_application.ragbot_admin.id
}
