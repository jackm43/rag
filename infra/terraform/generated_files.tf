locals {
  groups_output = {
    admins = {
      id   = cloudflare_zero_trust_access_group.admins.id
      name = cloudflare_zero_trust_access_group.admins.name
    }
  }

  posture_output = {
    enabled = local.posture_enabled
    ruleId  = cloudflare_zero_trust_device_posture_rule.warp.id
    checks  = [for check in try(local.organization.zero_trust.posture.checks, []) : { type = check.type }]
  }

  provider_config = {
    boundary = {
      provider    = "cloudflare"
      accountId   = var.account_id
      accountName = data.cloudflare_account.current.name
      teamName    = local.team_name
      teamDomain  = local.team_domain
      organization = {
        auth_domain = local.auth_domain
      }
    }
    identityProviders  = local.identity_providers
    groups             = local.groups_output
    emailAllowlist     = var.email_allowlist
    posture            = local.posture_output
    accessOidcClientId = cloudflare_zero_trust_access_application.auth_gateway.saas_app.client_id
    impersonationClients = {
      for name, app in cloudflare_zero_trust_access_application.impersonation : name => app.saas_app.client_id
    }
    trustZoneProvisioned = {
      tier0 = { policyId = cloudflare_zero_trust_access_policy.tier0_root.id }
      tier1 = { policyId = cloudflare_zero_trust_access_policy.tier1_critical.id }
      tier2 = { policyId = cloudflare_zero_trust_access_policy.tier2_internal.id }
      tier3 = {
        policyId    = cloudflare_zero_trust_access_policy.enroll_staff.id
        accessAppId = cloudflare_zero_trust_access_application.enroll.id
        domain      = cloudflare_zero_trust_access_application.enroll.domain
      }
    }
  }

  client_metadata = {
    provider                = "cloudflare"
    cloudflare_account_id   = var.account_id
    cloudflare_account_name = data.cloudflare_account.current.name
    access_team_name        = local.team_name
    access_team_domain      = local.team_domain
    access_oidc_client_id   = cloudflare_zero_trust_access_application.auth_gateway.saas_app.client_id
    email_allowlist         = var.email_allowlist
    identity_providers      = local.identity_providers
    groups                  = local.groups_output
    posture                 = local.posture_output
    wrangler_vars = {
      ACCESS_TEAM_DOMAIN    = local.team_domain
      ACCESS_OIDC_CLIENT_ID = cloudflare_zero_trust_access_application.auth_gateway.saas_app.client_id
    }
  }
}

resource "local_file" "provider_config" {
  filename        = "${path.module}/../applications/provider_config.json"
  content         = jsonencode(local.provider_config)
  file_permission = "0644"
}

resource "local_file" "client_metadata" {
  filename        = "${path.module}/../applications/client_metadata.json"
  content         = jsonencode(local.client_metadata)
  file_permission = "0644"
}
