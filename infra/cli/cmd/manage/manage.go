package manage

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"strings"

	"jsmunro.me/platy/cli/cmd/bootstrap"
	"jsmunro.me/platy/cli/internal/env"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
)

func Run(ctx context.Context, cmdArgs []string) {
	if len(cmdArgs) == 0 {
		output.UsageExit()
	}
	switch cmdArgs[0] {
	case "posture":
		Posture(ctx, cmdArgs[1:])
	case "provider":
		Provider(ctx, cmdArgs[1:])
	case "organization":
		Organization(ctx, cmdArgs[1:])
	default:
		output.UsageExit()
	}
}

func loadProviderConfig(root string) provider.ProviderConfig {
	path := bootstrap.ProviderConfigPath(root)
	data, err := os.ReadFile(path)
	if err != nil {
		output.Fail("read %s: run platy bootstrap first", path)
	}
	config := provider.ProviderConfig{}
	if err := json.Unmarshal(data, &config); err != nil {
		output.Fail("decode %s: %v", path, err)
	}
	if len(config.Organization.TrustZones) == 0 {
		config.Organization = provider.LoadOrganization(root)
	}
	return config
}

func resolveProxy(ctx context.Context, providerName, apiToken string) (provider.IdentityProxy, provider.Name) {
	name, err := provider.ParseName(providerName)
	if err != nil {
		output.Fail("%v", err)
	}
	organization := provider.LoadOrganization(platform.RepoRoot())
	token := secrets.ResolveCloudflareAPIToken(ctx, apiToken, organization.CloudflareAPITokenRef())
	if token == "" {
		output.Fail("api token is required; set --api-key, CLOUDFLARE_API_TOKEN, or organization.secrets.cloudflare_api_token")
	}
	proxy, err := provider.Resolve(ctx, name, token)
	if err != nil {
		output.Fail("%v", err)
	}
	return proxy, name
}

func Posture(ctx context.Context, cmdArgs []string) {
	flags := flag.NewFlagSet("manage posture", flag.ExitOnError)
	providerName := flags.String("provider", env.Or("PLATY_PROVIDER", string(provider.Cloudflare)), "identity proxy provider")
	teamName := flags.String("team-name", env.Or("ACCESS_TEAM_NAME", ""), "Zero Trust team name")
	teamDomain := flags.String("team-domain", env.Or("ACCESS_TEAM_DOMAIN", ""), "Zero Trust team domain")
	teamID := flags.String("team-id", env.Or("ACCESS_TEAM_ID", ""), "Zero Trust organization uuid")
	accountID := flags.String("account-id", env.Or("CLOUDFLARE_ACCOUNT_ID", ""), "cloudflare account id")
	enabled := flags.String("enabled", "", "enable or disable device posture checks (true/false)")
	apiToken := flags.String("api-key", env.Or("CLOUDFLARE_API_TOKEN", ""), "provider api token or op:// secret reference")
	if err := flags.Parse(cmdArgs); err != nil {
		output.Fail("%v", err)
	}
	if *enabled == "" {
		output.Fail("--enabled is required (true or false)")
	}
	enable := strings.EqualFold(strings.TrimSpace(*enabled), "true")

	proxy, name := resolveProxy(ctx, *providerName, *apiToken)
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

	root := platform.RepoRoot()
	organization := provider.LoadOrganization(root)
	posture, err := proxy.SetPostureEnabled(ctx, boundary, enable, organization.PrimaryPostureCheckName())
	if err != nil {
		output.Fail("set posture: %v", err)
	}

	config := loadProviderConfig(root)
	config.Boundary = boundary
	config.Posture = posture
	if err := output.WriteJSONFile(bootstrap.ProviderConfigPath(root), config); err != nil {
		output.Fail("write provider config: %v", err)
	}

	if err := provider.SyncToGateway(ctx, config); err != nil {
		output.Logger.Info("provider config not synced to gateway", "error", err)
	}
	output.PrintJSON(map[string]any{"posture": posture, "boundary": boundary})
}

func Provider(ctx context.Context, cmdArgs []string) {
	if len(cmdArgs) == 0 || cmdArgs[0] != "sync" {
		output.UsageExit()
	}
	root := platform.RepoRoot()
	config := loadProviderConfig(root)
	if err := provider.SyncToGateway(ctx, config); err != nil {
		output.Fail("sync provider config: %v", err)
	}
	output.PrintJSON(config)
}

func Organization(ctx context.Context, cmdArgs []string) {
	if len(cmdArgs) == 0 || cmdArgs[0] != "sync" {
		output.UsageExit()
	}
	flags := flag.NewFlagSet("manage organization sync", flag.ExitOnError)
	providerName := flags.String("provider", env.Or("PLATY_PROVIDER", string(provider.Cloudflare)), "identity proxy provider")
	teamName := flags.String("team-name", env.Or("ACCESS_TEAM_NAME", ""), "Zero Trust team name")
	teamDomain := flags.String("team-domain", env.Or("ACCESS_TEAM_DOMAIN", ""), "Zero Trust team domain")
	teamID := flags.String("team-id", env.Or("ACCESS_TEAM_ID", ""), "Zero Trust organization uuid")
	accountID := flags.String("account-id", env.Or("CLOUDFLARE_ACCOUNT_ID", ""), "cloudflare account id")
	workersDevSubdomain := flags.String("workers-dev-subdomain", "", "workers.dev account subdomain")
	apiToken := flags.String("api-key", env.Or("CLOUDFLARE_API_TOKEN", ""), "provider api token or op:// secret reference")
	if err := flags.Parse(cmdArgs[1:]); err != nil {
		output.Fail("%v", err)
	}

	proxy, name := resolveProxy(ctx, *providerName, *apiToken)
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

	root := platform.RepoRoot()
	config := loadProviderConfig(root)
	organization := config.Organization
	if len(organization.TrustZones) == 0 {
		organization = provider.LoadOrganization(root)
	}

	subdomain := *workersDevSubdomain
	if subdomain == "" {
		subdomain = boundary.TeamName
	}
	organization, err = proxy.EnsureOrganization(ctx, boundary, provider.EnsureOrganizationInput{
		Organization:        organization,
		Groups:              config.Groups,
		IdentityProviders:   config.IdentityProviders,
		EmailAllowlist:      config.EmailAllowlist,
		PostureRuleID:       config.Posture.RuleID,
		WorkersDevSubdomain: subdomain,
	})
	if err != nil {
		output.Fail("sync organization: %v", err)
	}

	config.Boundary = boundary
	config.Organization = organization
	if err := output.WriteJSONFile(bootstrap.ProviderConfigPath(root), config); err != nil {
		output.Fail("write provider config: %v", err)
	}
	if err := provider.SyncToGateway(ctx, config); err != nil {
		output.Logger.Info("provider config not synced to gateway", "error", err)
	}
	output.PrintJSON(organization)
}
