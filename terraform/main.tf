# Access acts as the OIDC identity provider for the ragbot admin API. The CLI
# is a public client (PKCE, no client secret) using a loopback redirect; the
# worker validates issued JWTs against this application's JWKS endpoint.
# Discord interaction routes (POST /) stay publicly reachable because nothing
# is enforced at the edge.
resource "cloudflare_zero_trust_access_application" "ragbot_admin" {
  account_id           = var.account_id
  name                 = "Ragbot Admin API"
  type                 = "saas"
  app_launcher_visible = false

  saas_app = {
    auth_type = "oidc"
    redirect_uris = [
      "http://localhost:8976/callback",
      "http://127.0.0.1:8976/callback",
    ]
    grant_types                      = ["authorization_code_with_pkce", "refresh_tokens"]
    scopes                           = ["openid", "email", "profile"]
    allow_pkce_without_client_secret = true
    access_token_lifetime            = "15m"
    refresh_token_options = {
      lifetime = var.refresh_token_lifetime
    }
  }

  policies = [
    {
      name       = "Ragbot admins"
      decision   = "allow"
      precedence = 1
      include = [
        for email in var.allowed_emails : {
          email = {
            email = email
          }
        }
      ]
    }
  ]
}
