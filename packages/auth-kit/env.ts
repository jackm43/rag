// The env slice the auth-kit guards read: Cloudflare Access verification,
// the Better Auth session module, and the operator control token.
export type AuthEnv = {
  // Inbound-webhook signing secrets, resolved per provider by verifyWebhook.
  GITHUB_WEBHOOK_SECRET?: string;
  // OAuth2 client-credentials registry: JSON map of clientId -> shared secret
  // (or token) for machine clients using the oauth2 client kind.
  OAUTH2_CLIENTS?: string;
  // Discord interaction-webhook signature verification (ed25519 public key).
  // Required, matching Cloudflare.Env — the interaction guard fails closed
  // without it.
  DISCORD_PUBLIC_KEY: string;
  GATEWAY_CONTROL_TOKEN?: string;
  // Cloudflare Access verification (the `web` client's machine-grant path). Read
  // via env so nothing about the deployment's Access team or audience is baked
  // into code.
  //   CF_ACCESS_TEAM_DOMAIN — e.g. "myteam.cloudflareaccess.com"; its
  //     /cdn-cgi/access/certs JWKS verifies the Access application token.
  //   CF_ACCESS_AUD — the Access application AUD tag (audience) the token must
  //     carry; a token minted for another Access app is refused.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  // The web client's application-identity layer: Better Auth with Discord OAuth,
  // resolving which Discord user is acting so that Discord id becomes the
  // request's subject. Better Auth is authN only.
  //   AUTH_DB — the standalone `ragbot-auth` D1 database holding Better Auth's
  //     user/session/account/verification tables (kept apart from the gateway's
  //     operational DB). Passed to Better Auth directly (native D1 adapter).
  //   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET — the Discord OAuth application
  //     credentials (secret, provisioned via `wrangler secret put`).
  //   BETTER_AUTH_SECRET — session/cookie signing secret (secret).
  //   BETTER_AUTH_URL — the public origin Access fronts, from which Better Auth
  //     derives its OAuth callback and cookie domain.
  AUTH_DB?: D1Database;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};
