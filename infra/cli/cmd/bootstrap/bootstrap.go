package bootstrap

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

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

type options struct {
	providerName        string
	accountID           string
	emailAllowlist      string
	email               string
	appName             string
	workersDevSubdomain string
	teamDomain          string
	teamName            string
	teamID              string
	defaultIdP          string
	cfAPIToken          string
}

func Command() *cobra.Command {
	opts := options{}
	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "Bootstrap the identity proxy provider and platform access policies",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return run(cmd.Context(), opts)
		},
	}
	flags := cmd.Flags()
	flags.StringVar(&opts.providerName, "provider", env.Or("PLATY_PROVIDER", string(provider.Cloudflare)), "identity proxy provider")
	flags.StringVar(&opts.accountID, "account-id", env.Or("CLOUDFLARE_ACCOUNT_ID", ""), "cloudflare account id override when the token can access multiple accounts")
	flags.StringVar(&opts.emailAllowlist, "email-allowlist", env.Or("ALLOWED_EMAILS", "jack@jsmunro.me"), "comma separated emails allowed to authenticate")
	flags.StringVar(&opts.email, "email", "", "deprecated alias for a single --email-allowlist entry")
	flags.StringVar(&opts.appName, "app-name", "Auth Gateway", "access application name")
	flags.StringVar(&opts.workersDevSubdomain, "workers-dev-subdomain", "", "workers.dev account subdomain (default: resolved team name)")
	flags.StringVar(&opts.teamDomain, "team-domain", env.Or("ACCESS_TEAM_DOMAIN", ""), "Zero Trust team domain (https://<team>.cloudflareaccess.com)")
	flags.StringVar(&opts.teamName, "team-name", env.Or("ACCESS_TEAM_NAME", ""), "Zero Trust team name (subdomain before .cloudflareaccess.com)")
	flags.StringVar(&opts.teamID, "team-id", env.Or("ACCESS_TEAM_ID", ""), "Zero Trust organization uuid")
	flags.StringVar(&opts.defaultIdP, "default-idp", "github", "default identity provider type or name for the auth gateway access app")
	flags.StringVar(&opts.cfAPIToken, "cf-api-token", env.Or("CLOUDFLARE_API_TOKEN", ""), "cloudflare api token or op:// secret reference")
	return cmd
}

func run(ctx context.Context, opts options) error {
	name, err := provider.ParseName(opts.providerName)
	if err != nil {
		return err
	}

	allowlist := provider.ParseEmailAllowlist(opts.emailAllowlist)
	if opts.email != "" {
		allowlist = append(allowlist, strings.TrimSpace(opts.email))
	}
	if len(allowlist) == 0 {
		return fmt.Errorf("--email-allowlist must include at least one email")
	}

	root := platform.RepoRoot()
	organization := provider.LoadOrganization(root)

	apiToken := secrets.ResolveCloudflareAPIToken(ctx, opts.cfAPIToken, organization.CloudflareAPITokenRef())
	if apiToken == "" {
		return fmt.Errorf("--cf-api-token, CLOUDFLARE_API_TOKEN, or organization.secrets.cloudflare_api_token is required")
	}

	proxy, err := provider.Resolve(ctx, name, apiToken)
	if err != nil {
		return err
	}

	boundary, err := proxy.ResolveTrustBoundary(ctx, provider.TrustBoundaryHints{
		Provider:   name,
		AccountID:  opts.accountID,
		TeamID:     opts.teamID,
		TeamName:   opts.teamName,
		TeamDomain: opts.teamDomain,
	})
	if err != nil {
		return err
	}

	bootstrapResult, err := proxy.Bootstrap(ctx, boundary, provider.BootstrapOptions{
		EmailAllowlist:      allowlist,
		DefaultIdPType:      opts.defaultIdP,
		AccessAppName:       opts.appName,
		WorkersDevSubdomain: opts.workersDevSubdomain,
		PostureEnabled:      organization.NeedsPosture(),
		PostureCheckName:    organization.PrimaryPostureCheckName(),
	})
	if err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}

	organizationGroupSpecs := organization.GroupSpecs()
	if len(organizationGroupSpecs) > 0 {
		mergedGroups, err := proxy.EnsureGroups(ctx, boundary, organizationGroupSpecs)
		if err != nil {
			return fmt.Errorf("ensure organization groups: %w", err)
		}
		for name, group := range mergedGroups {
			bootstrapResult.Groups[name] = group
		}
	}

	subdomain := opts.workersDevSubdomain
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
		return fmt.Errorf("ensure organization policies: %w", err)
	}

	providerConfig := provider.ProviderConfigFromBootstrap(bootstrapResult, organization)
	providerConfigPath := ProviderConfigPath(root)
	if err := output.WriteJSONFile(providerConfigPath, providerConfig); err != nil {
		return fmt.Errorf("write %s: %w", providerConfigPath, err)
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
	metadataPath := filepath.Join(root, "infra", "applications", "client_metadata.json")
	if err := output.WriteJSONFile(metadataPath, result); err != nil {
		return fmt.Errorf("write %s: %w", metadataPath, err)
	}
	output.Logger.Info("wrote bootstrap metadata", "path", metadataPath)

	wrangler.InjectBootstrapVars(root, manifest.Load(root))
	output.PrintJSON(result)
	return nil
}
