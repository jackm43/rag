locals {
  manifest     = yamldecode(file("${path.module}/../applications/applications.yaml"))
  organization = yamldecode(file("${path.module}/../applications/organization.yaml"))
  applications = local.manifest.applications
  trust_zones  = local.organization.trust_zones

  team_name             = local.organization.organization.name
  team_domain           = "https://${local.team_name}.cloudflareaccess.com"
  auth_domain           = "${local.team_name}.cloudflareaccess.com"
  workers_dev_subdomain = var.workers_dev_subdomain != "" ? var.workers_dev_subdomain : local.team_name

  cli_redirect_uris = [
    "http://127.0.0.1:8976/callback",
    "http://localhost:8976/callback",
  ]

  registered_applications = {
    for name, app in local.applications : name => app if !try(app.internal, false)
  }

  impersonatable_applications = {
    for name, app in local.registered_applications : name => app if try(app.impersonatable, true)
  }

  web_client_applications = {
    for name, app in local.registered_applications : name => app
    if !try(app.impersonatable, true) && length(fileset("${path.module}/../proto/${name}", "**")) == 0 && try(app.endpoint, "") != ""
  }

  web_client_callback_uris = sort([
    for name, app in local.web_client_applications : "${trimsuffix(app.endpoint, "/")}/callback"
  ])

  auth_gateway_redirect_uris = concat(local.cli_redirect_uris, local.web_client_callback_uris)

  workers_dev_bypass_workers = ["auth-gateway", "deploy", "cloudflare"]

  posture_enabled = length(try(local.organization.zero_trust.posture.checks, [])) > 0

  github_idp_id = [
    for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : idp.id
    if idp.type == var.default_idp_type
  ][0]

  identity_providers = [
    for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : {
      id   = idp.id
      name = idp.name
      type = idp.type
    }
  ]

  email_includes = [for email in var.email_allowlist : { email = { email = email } }]

  oidc_saas_app = {
    auth_type = "oidc"
    grant_types = [
      "authorization_code_with_pkce",
      "refresh_tokens",
    ]
    scopes = [
      "openid",
      "email",
      "profile",
    ]
    allow_pkce_without_client_secret = true
    access_token_lifetime            = "5m"
    refresh_token_options            = { lifetime = "30d" }
  }
}

data "cloudflare_account" "current" {
  account_id = var.account_id
}

data "cloudflare_zero_trust_access_identity_providers" "all" {
  account_id = var.account_id
}
