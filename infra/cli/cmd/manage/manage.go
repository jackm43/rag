package manage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/cli/cmd/bootstrap"
	"jsmunro.me/platy/cli/internal/env"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
)

type boundaryOptions struct {
	providerName string
	teamName     string
	teamDomain   string
	teamID       string
	accountID    string
	apiToken     string
}

func addBoundaryFlags(cmd *cobra.Command, opts *boundaryOptions) {
	flags := cmd.Flags()
	flags.StringVar(&opts.providerName, "provider", env.Or("PLATY_PROVIDER", string(provider.Cloudflare)), "identity proxy provider")
	flags.StringVar(&opts.teamName, "team-name", env.Or("ACCESS_TEAM_NAME", ""), "Zero Trust team name")
	flags.StringVar(&opts.teamDomain, "team-domain", env.Or("ACCESS_TEAM_DOMAIN", ""), "Zero Trust team domain")
	flags.StringVar(&opts.teamID, "team-id", env.Or("ACCESS_TEAM_ID", ""), "Zero Trust organization uuid")
	flags.StringVar(&opts.accountID, "account-id", env.Or("CLOUDFLARE_ACCOUNT_ID", ""), "cloudflare account id")
	flags.StringVar(&opts.apiToken, "api-key", env.Or("CLOUDFLARE_API_TOKEN", ""), "provider api token or op:// secret reference")
}

func Command() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "manage",
		Short: "Manage organization posture, provider config, and trust tier policies",
	}
	cmd.AddCommand(postureCommand(), providerCommand(), organizationCommand())
	return cmd
}

func postureCommand() *cobra.Command {
	opts := boundaryOptions{}
	enabled := ""
	cmd := &cobra.Command{
		Use:   "posture",
		Short: "Enable or disable device posture requirements for a trust boundary",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if enabled == "" {
				return fmt.Errorf("--enabled is required (true or false)")
			}
			return runPosture(cmd.Context(), opts, strings.EqualFold(strings.TrimSpace(enabled), "true"))
		},
	}
	addBoundaryFlags(cmd, &opts)
	cmd.Flags().StringVar(&enabled, "enabled", "", "enable or disable device posture checks (true/false)")
	return cmd
}

func providerCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "provider",
		Short: "Manage the identity proxy provider configuration",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "sync",
		Short: "Upload local provider config to the gateway registry",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			root := platform.RepoRoot()
			config, err := loadProviderConfig(root)
			if err != nil {
				return err
			}
			if err := provider.SyncToGateway(cmd.Context(), config); err != nil {
				return fmt.Errorf("sync provider config: %w", err)
			}
			output.PrintJSON(config)
			return nil
		},
	})
	return cmd
}

func organizationCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "organization",
		Short: "Manage organization trust tier policies",
	}
	opts := boundaryOptions{}
	workersDevSubdomain := ""
	sync := &cobra.Command{
		Use:   "sync",
		Short: "Provision trust tier policies and enroll app in Cloudflare",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runOrganizationSync(cmd.Context(), opts, workersDevSubdomain)
		},
	}
	addBoundaryFlags(sync, &opts)
	sync.Flags().StringVar(&workersDevSubdomain, "workers-dev-subdomain", "", "workers.dev account subdomain")
	cmd.AddCommand(sync)
	return cmd
}

func loadProviderConfig(root string) (provider.ProviderConfig, error) {
	path := bootstrap.ProviderConfigPath(root)
	data, err := os.ReadFile(path)
	if err != nil {
		return provider.ProviderConfig{}, fmt.Errorf("read %s: run platy bootstrap first", path)
	}
	config := provider.ProviderConfig{}
	if err := json.Unmarshal(data, &config); err != nil {
		return provider.ProviderConfig{}, fmt.Errorf("decode %s: %w", path, err)
	}
	if len(config.Organization.TrustZones) == 0 {
		config.Organization = provider.LoadOrganization(root)
	}
	return config, nil
}

func resolveProxy(ctx context.Context, providerName, apiToken string) (provider.IdentityProxy, provider.Name, error) {
	name, err := provider.ParseName(providerName)
	if err != nil {
		return nil, name, err
	}
	organization := provider.LoadOrganization(platform.RepoRoot())
	token := secrets.ResolveCloudflareAPIToken(ctx, apiToken, organization.CloudflareAPITokenRef())
	if token == "" {
		return nil, name, fmt.Errorf("api token is required; set --api-key, CLOUDFLARE_API_TOKEN, or organization.secrets.cloudflare_api_token")
	}
	proxy, err := provider.Resolve(ctx, name, token)
	if err != nil {
		return nil, name, err
	}
	return proxy, name, nil
}

func runPosture(ctx context.Context, opts boundaryOptions, enable bool) error {
	proxy, name, err := resolveProxy(ctx, opts.providerName, opts.apiToken)
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

	root := platform.RepoRoot()
	organization := provider.LoadOrganization(root)
	posture, err := proxy.SetPostureEnabled(ctx, boundary, enable, organization.PrimaryPostureCheckName())
	if err != nil {
		return fmt.Errorf("set posture: %w", err)
	}

	config, err := loadProviderConfig(root)
	if err != nil {
		return err
	}
	config.Boundary = boundary
	config.Posture = posture
	if err := output.WriteJSONFile(bootstrap.ProviderConfigPath(root), config); err != nil {
		return fmt.Errorf("write provider config: %w", err)
	}

	if err := provider.SyncToGateway(ctx, config); err != nil {
		output.Logger.Info("provider config not synced to gateway", "error", err)
	}
	output.PrintJSON(map[string]any{"posture": posture, "boundary": boundary})
	return nil
}

func runOrganizationSync(ctx context.Context, opts boundaryOptions, workersDevSubdomain string) error {
	proxy, name, err := resolveProxy(ctx, opts.providerName, opts.apiToken)
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

	root := platform.RepoRoot()
	config, err := loadProviderConfig(root)
	if err != nil {
		return err
	}
	organization := config.Organization
	if len(organization.TrustZones) == 0 {
		organization = provider.LoadOrganization(root)
	}

	subdomain := workersDevSubdomain
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
		return fmt.Errorf("sync organization: %w", err)
	}

	config.Boundary = boundary
	config.Organization = organization
	if err := output.WriteJSONFile(bootstrap.ProviderConfigPath(root), config); err != nil {
		return fmt.Errorf("write provider config: %w", err)
	}
	if err := provider.SyncToGateway(ctx, config); err != nil {
		output.Logger.Info("provider config not synced to gateway", "error", err)
	}
	output.PrintJSON(organization)
	return nil
}
