resource "cloudflare_zero_trust_access_group" "admins" {
  account_id = var.account_id
  name       = "admins"
  include    = local.email_includes
}

resource "cloudflare_zero_trust_device_posture_rule" "warp" {
  account_id = var.account_id
  name       = "Platform WARP connected"
  type       = "warp"
}

resource "cloudflare_zero_trust_access_policy" "platform_admins" {
  account_id = var.account_id
  name       = "Platform admins"
  decision   = "allow"
  include = concat(local.email_includes, [
    { group = { id = cloudflare_zero_trust_access_group.admins.id } },
  ])
}

resource "cloudflare_zero_trust_access_policy" "device_posture" {
  account_id = var.account_id
  name       = "Platform device posture"
  decision   = "allow"
  include    = [{ everyone = {} }]
  require = [
    { device_posture = { integration_uid = cloudflare_zero_trust_device_posture_rule.warp.id } },
  ]
}

resource "cloudflare_zero_trust_access_policy" "workers_dev_bypass" {
  account_id = var.account_id
  name       = "bypass-discord-bot"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_policy" "tier0_root" {
  account_id = var.account_id
  name       = "tier0-root"
  decision   = "allow"
  include = [
    { group = { id = cloudflare_zero_trust_access_group.admins.id } },
  ]
  require = [
    { device_posture = { integration_uid = cloudflare_zero_trust_device_posture_rule.warp.id } },
  ]
  session_duration               = local.trust_zones.tier0.access_policy.session_duration
  approval_required              = true
  purpose_justification_required = true
  isolation_required             = true
  approval_groups = [{
    approvals_needed = 1
    email_addresses  = var.email_allowlist
  }]
  mfa_config = {
    mfa_disabled = false
    allowed_authenticators = [
      "totp",
      "biometrics",
      "security_key",
    ]
    session_duration = local.trust_zones.tier0.access_policy.mfa_config.session_duration
  }
}

resource "cloudflare_zero_trust_access_policy" "tier1_critical" {
  account_id = var.account_id
  name       = "tier1-critical"
  decision   = "allow"
  include = [
    { group = { id = cloudflare_zero_trust_access_group.admins.id } },
  ]
  require = [
    { device_posture = { integration_uid = cloudflare_zero_trust_device_posture_rule.warp.id } },
  ]
  session_duration   = local.trust_zones.tier1.access_policy.session_duration
  isolation_required = true
}

resource "cloudflare_zero_trust_access_policy" "tier2_internal" {
  account_id = var.account_id
  name       = "tier2-internal"
  decision   = "allow"
  include = [
    { group = { id = cloudflare_zero_trust_access_group.admins.id } },
  ]
  session_duration = local.trust_zones.tier2.access_policy.session_duration
}

resource "cloudflare_zero_trust_access_policy" "enroll_staff" {
  account_id = var.account_id
  name       = "enroll-staff"
  decision   = "allow"
  include    = [{ everyone = {} }]
  require = [
    { device_posture = { integration_uid = cloudflare_zero_trust_device_posture_rule.warp.id } },
  ]
}

resource "cloudflare_zero_trust_access_policy" "enroll_contractor_rbi" {
  account_id         = var.account_id
  name               = "enroll-contractor-rbi"
  decision           = "allow"
  include            = [{ everyone = {} }]
  isolation_required = true
}

resource "cloudflare_zero_trust_access_policy" "enroll_contractor_warp" {
  account_id = var.account_id
  name       = "enroll-contractor-warp"
  decision   = "allow"
  include    = [{ everyone = {} }]
  require = [
    { device_posture = { integration_uid = cloudflare_zero_trust_device_posture_rule.warp.id } },
  ]
}

resource "cloudflare_zero_trust_organization" "this" {
  account_id                  = var.account_id
  name                        = local.auth_domain
  auth_domain                 = local.auth_domain
  allow_authenticate_via_warp = false
  deny_unmatched_requests     = false
  mfa_config = {
    allowed_authenticators = [
      "totp",
      "biometrics",
      "security_key",
    ]
    session_duration = local.trust_zones.tier0.access_policy.mfa_config.session_duration
  }
}

resource "cloudflare_zero_trust_gateway_settings" "this" {
  account_id = var.account_id
  settings = {
    tls_decrypt        = { enabled = try(local.organization.zero_trust.gateway.tls_decrypt, false) }
    inspection         = { mode = "static" }
    protocol_detection = { enabled = false }
    activity_log       = { enabled = false }
    browser_isolation = {
      url_browser_isolation_enabled = true
      non_identity_enabled          = false
    }
    fips                    = { tls = false }
    certificate             = { id = "ff21940d-5f4e-4537-8232-e3e08c8b822c" }
    extended_email_matching = { enabled = false }
  }
}

resource "cloudflare_zero_trust_device_settings" "this" {
  account_id                            = var.account_id
  disable_for_time                      = 0
  gateway_proxy_enabled                 = try(local.organization.zero_trust.devices.gateway_proxy_enabled, false)
  gateway_udp_proxy_enabled             = try(local.organization.zero_trust.devices.gateway_udp_proxy_enabled, false)
  root_certificate_installation_enabled = false
  use_zt_virtual_ip                     = true
}
