package bootstrap

import (
	"context"
	"flag"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/env"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/cli/internal/wrangler"
)

const providerConfigRelative = "infra/applications/provider_config.json"

func ProviderConfigPath(root string) string {
	return filepath.Join(root, filepath.FromSlash(providerConfigRelative))
}

func Run(ctx context.Context, cmdArgs []string) {
	flags := flag.NewFlagSet("bootstrap", flag.ExitOnError)
	providerName := flags.String("provider", env.Or("PLATY_PROVIDER", string(provider.Cloudflare)), "identity proxy provider")
	accountID := flags.String("account-id", env.Or("CLOUDFLARE_ACCOUNT_ID", ""), "cloudflare account id override when the token can access multiple accounts")
	emailAllowlist := flags.String("email-allowlist", env.Or("ALLOWED_EMAILS", "jack@jsmunro.me"), "comma separated emails allowed to authenticate")
	email := flags.String("email", "", "deprecated alias for a single --email-allowlist entry")
	appName := flags.String("app-name", "Auth Gateway", "access application name")
	oauthClientName := flags.String("oauth-client-name", "platy", "cloudflare oauth client name")
	oauthScopes := flags.String("oauth-scopes", "", "comma separated oauth scope ids (default: workers, d1, and access management scopes)")
	skipOauthClient := flags.Bool("skip-oauth-client", false, "skip Cloudflare OAuth client creation (create manually in the dashboard)")
	workersDevSubdomain := flags.String("workers-dev-subdomain", "", "workers.dev account subdomain (default: resolved team name)")
	teamDomain := flags.String("team-domain", env.Or("ACCESS_TEAM_DOMAIN", ""), "Zero Trust team domain (https://<team>.cloudflareaccess.com)")
	teamName := flags.String("team-name", env.Or("ACCESS_TEAM_NAME", ""), "Zero Trust team name (subdomain before .cloudflareaccess.com)")
	teamID := flags.String("team-id", env.Or("ACCESS_TEAM_ID", ""), "Zero Trust organization uuid")
	defaultIdP := flags.String("default-idp", "github", "default identity provider type or name for the auth gateway access app")
	cfAPIToken := flags.String("cf-api-token", env.Or("CLOUDFLARE_API_TOKEN", ""), "cloudflare api token or op:// secret reference")
	if err := flags.Parse(cmdArgs); err != nil {
		output.Fail("%v", err)
	}

	name, err := provider.ParseName(*providerName)
	if err != nil {
		output.Fail("%v", err)
	}

	allowlist := provider.ParseEmailAllowlist(*emailAllowlist)
	if *email != "" {
		allowlist = append(allowlist, strings.TrimSpace(*email))
	}
	if len(allowlist) == 0 {
		output.Fail("--email-allowlist must include at least one email")
	}

	root := platform.RepoRoot()
	organization := provider.LoadOrganization(root)

	apiToken := secrets.ResolveCloudflareAPIToken(ctx, *cfAPIToken, organization.CloudflareAPITokenRef())
	if apiToken == "" {
		output.Fail("--cf-api-token, CLOUDFLARE_API_TOKEN, or organization.secrets.cloudflare_api_token is required")
	}

	proxy, err := provider.Resolve(ctx, name, apiToken)
	if err != nil {
		output.Fail("%v", err)
	}

	boundary, err := proxy.ResolveTrustBoundary(ctx, provider.TrustBoundaryHints{
		Provider:   name,
		AccountID:  *accountID,
		TeamID:     *teamID,
		TeamName:   *teamName,
		TeamDomain: *teamDomain,
	})
	if err != nil {
		output.Fail("%v", err)
	}

	bootstrapResult, err := proxy.Bootstrap(ctx, boundary, provider.BootstrapOptions{
		EmailAllowlist:      allowlist,
		DefaultIdPType:      *defaultIdP,
		AccessAppName:       *appName,
		WorkersDevSubdomain: *workersDevSubdomain,
		OAuthClientName:     *oauthClientName,
		OAuthScopes:         *oauthScopes,
		SkipOAuthClient:     *skipOauthClient,
		PostureEnabled:      organization.NeedsPosture(),
		PostureCheckName:    organization.PrimaryPostureCheckName(),
	})
	if err != nil {
		output.Fail("bootstrap: %v", err)
	}

	organizationGroupSpecs := organization.GroupSpecs()
	if len(organizationGroupSpecs) > 0 {
		mergedGroups, err := proxy.EnsureGroups(ctx, boundary, organizationGroupSpecs)
		if err != nil {
			output.Fail("ensure organization groups: %v", err)
		}
		for name, group := range mergedGroups {
			bootstrapResult.Groups[name] = group
		}
	}

	subdomain := *workersDevSubdomain
	if subdomain == "" {
		subdomain = boundary.TeamName
	}
	organization, err = proxy.EnsureOrganization(ctx, boundary, provider.EnsureOrganizationInput{
		Organization:        organization,
		Groups:              bootstrapResult.Groups,
		IdentityProviders:   bootstrapResult.IdentityProviders,
		EmailAllowlist:      allowlist,
		PostureRuleID:       bootstrapResult.Posture.RuleID,
		WorkersDevSubdomain: subdomain,
	})
	if err != nil {
		output.Fail("ensure organization policies: %v", err)
	}

	providerConfig := provider.ProviderConfigFromBootstrap(bootstrapResult, organization)
	providerConfigPath := ProviderConfigPath(root)
	if err := output.WriteJSONFile(providerConfigPath, providerConfig); err != nil {
		output.Fail("write %s: %v", providerConfigPath, err)
	}
	output.Logger.Info("wrote provider config", "path", providerConfigPath)

	result := map[string]any{
		"provider":                string(name),
		"cloudflare_account_id":   bootstrapResult.Boundary.AccountID,
		"cloudflare_account_name": bootstrapResult.Boundary.AccountName,
		"access_team_id":          bootstrapResult.Boundary.TeamID,
		"access_team_name":        bootstrapResult.Boundary.TeamName,
		"access_team_domain":      bootstrapResult.Boundary.TeamDomain,
		"zero_trust_organization": bootstrapResult.Boundary.Organization,
		"identity_providers":      bootstrapResult.IdentityProviders,
		"groups":                  bootstrapResult.Groups,
		"email_allowlist":         bootstrapResult.EmailAllowlist,
		"posture":                 bootstrapResult.Posture,
		"organization":            organization,
		"access_oidc_client_id":   bootstrapResult.AccessOIDCClientID,
		"wrangler_vars": map[string]string{
			"ACCESS_TEAM_DOMAIN":    bootstrapResult.Boundary.TeamDomain,
			"ACCESS_OIDC_CLIENT_ID": bootstrapResult.AccessOIDCClientID,
		},
	}
	if bootstrapResult.OAuthClientID != "" {
		result["cloudflare_oauth_client"] = map[string]any{
			"client_id": bootstrapResult.OAuthClientID,
			"scopes":    bootstrapResult.OAuthScopes,
		}
		result["environment"] = map[string]string{
			"CF_OAUTH_CLIENT_ID": bootstrapResult.OAuthClientID,
		}
	}
	metadataPath := filepath.Join(root, "infra", "applications", "client_metadata.json")
	if err := output.WriteJSONFile(metadataPath, result); err != nil {
		output.Fail("write %s: %v", metadataPath, err)
	}
	output.Logger.Info("wrote bootstrap metadata", "path", metadataPath)

	wrangler.InjectBootstrapVars(root, manifest.Load(root))
	output.PrintJSON(result)
}
