resource "cloudflare_zero_trust_access_application" "auth_gateway" {
  account_id = var.account_id
  type       = "saas"
  name       = "Auth Gateway"
  policies = [
    { id = cloudflare_zero_trust_access_policy.platform_admins.id, precedence = 1 },
  ]
  saas_app = merge(local.oidc_saas_app, {
    redirect_uris = local.auth_gateway_redirect_uris
  })
}

resource "cloudflare_zero_trust_access_application" "impersonation" {
  for_each = local.impersonatable_applications

  account_id                = var.account_id
  type                      = "saas"
  name                      = "platy-impersonate-${each.key}"
  app_launcher_visible      = false
  auto_redirect_to_identity = true
  allowed_idps              = [local.github_idp_id]
  policies = [
    { id = cloudflare_zero_trust_access_policy.platform_admins.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.device_posture.id, precedence = 2 },
  ]
  saas_app = merge(local.oidc_saas_app, {
    redirect_uris = local.cli_redirect_uris
  })
}

resource "cloudflare_zero_trust_access_application" "workers_dev_bypass" {
  for_each = toset(local.workers_dev_bypass_workers)

  account_id = var.account_id
  type       = "self_hosted"
  name       = each.value
  domain     = "${each.value}.${local.workers_dev_subdomain}.workers.dev"
  policies = [
    { id = cloudflare_zero_trust_access_policy.workers_dev_bypass.id, precedence = 1 },
  ]
}

resource "cloudflare_zero_trust_access_application" "web_client_bypass" {
  for_each = local.web_client_applications

  account_id = var.account_id
  type       = "self_hosted"
  name       = "${each.key} web client"
  domain     = regex("^https?://([^/]+)", each.value.endpoint)[0]
  policies = [
    { id = cloudflare_zero_trust_access_policy.workers_dev_bypass.id, precedence = 1 },
  ]
}

resource "cloudflare_zero_trust_access_application" "enroll" {
  account_id   = var.account_id
  type         = "self_hosted"
  name         = "Platy Enroll"
  domain       = "enroll.${local.workers_dev_subdomain}.workers.dev"
  allowed_idps = [local.github_idp_id]
  policies = [
    { id = cloudflare_zero_trust_access_policy.enroll_staff.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.enroll_contractor_rbi.id, precedence = 2 },
    { id = cloudflare_zero_trust_access_policy.enroll_contractor_warp.id, precedence = 3 },
  ]
}
