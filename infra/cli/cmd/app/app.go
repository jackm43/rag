package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/cli/internal/applications"
	"jsmunro.me/platy/cli/internal/bffgen"
	"jsmunro.me/platy/cli/internal/display"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/gateway"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func Command() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "app",
		Short: "Manage application registrations in the gateway registry",
	}
	cmd.AddCommand(
		registerCommand(),
		planCommand(),
		syncCommand(),
		listCommand(),
		getCommand(),
		deleteCommand(),
		rotateClientCommand(),
		rotateProviderOAuthCommand(),
	)
	return cmd
}

func registerCommand() *cobra.Command {
	endpoint := ""
	description := ""
	skipCodegen := false
	cmd := &cobra.Command{
		Use:   "register <name>",
		Short: "Register an application from applications.yaml and generate code",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			Register(cmd.Context(), args[0], endpoint, description, skipCodegen)
			return nil
		},
	}
	cmd.Flags().StringVar(&endpoint, "endpoint", "", "endpoint override for the registered application")
	cmd.Flags().StringVar(&description, "description", "", "description override for the registered application")
	cmd.Flags().BoolVar(&skipCodegen, "skip-codegen", false, "skip platform codegen after registration")
	return cmd
}

func planCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "plan",
		Short: "Diff applications.yaml against the registry (exits 1 when drift exists)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if Plan(cmd.Context()) > 0 {
				os.Exit(1)
			}
			return nil
		},
	}
}

func syncCommand() *cobra.Command {
	prune := false
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Reconcile applications.yaml with the gateway, applying only what changed",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			Sync(cmd.Context(), prune)
			return nil
		},
	}
	cmd.Flags().BoolVar(&prune, "prune", false, "delete gateway applications that are no longer in the manifest")
	return cmd
}

func listCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List registered applications",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			List(cmd.Context())
			return nil
		},
	}
}

func getCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "get <name>",
		Short: "Show one application document",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			Get(cmd.Context(), args[0])
			return nil
		},
	}
}

func deleteCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <name>",
		Short: "Remove an application from the registry",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			Delete(cmd.Context(), args[0])
			return nil
		},
	}
}

func rotateClientCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-client <name>",
		Short: "Issue a new service credential for an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			RotateClient(cmd.Context(), args[0])
			return nil
		},
	}
}

func rotateProviderOAuthCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "rotate-provider-oauth <name>",
		Short: "Rotate the confidential provider OAuth client secret for an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			RotateProviderOAuth(cmd.Context(), args[0])
			return nil
		},
	}
}

func generatePlatform(root string) {
	script := filepath.Join(root, "infra", "scripts", "generate-platform.ts")
	command := exec.Command("npx", "tsx", script)
	command.Dir = root
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		output.Fail("platform codegen: %v", err)
	}
	output.Logger.Info("generated platform catalog and bindings")
}

func manifestDelegations(app *manifest.Application) []gateway.DelegationInput {
	delegations := []gateway.DelegationInput{}
	for _, delegation := range app.Delegations {
		delegations = append(delegations, gateway.DelegationInput{
			Audience: delegation.Audience,
			Scopes:   delegation.Scopes,
		})
	}
	return delegations
}

func manifestTrustBoundary(app *manifest.Application, config provider.ProviderConfig) *gateway.TrustBoundaryInput {
	boundary := config.Boundary
	if app.TrustBoundary.AccountID != "" {
		boundary.AccountID = app.TrustBoundary.AccountID
	}
	if app.TrustBoundary.TeamID != "" {
		boundary.TeamID = app.TrustBoundary.TeamID
	}
	if app.TrustBoundary.TeamName != "" {
		boundary.TeamName = app.TrustBoundary.TeamName
	}
	if app.TrustBoundary.TeamDomain != "" {
		boundary.TeamDomain = app.TrustBoundary.TeamDomain
	}
	return &gateway.TrustBoundaryInput{
		Provider:   string(boundary.Provider),
		AccountID:  boundary.AccountID,
		TeamID:     boundary.TeamID,
		TeamName:   boundary.TeamName,
		TeamDomain: boundary.TeamDomain,
	}
}

func manifestAccess(app *manifest.Application, config provider.ProviderConfig) *gateway.AccessInput {
	postureRequired := config.Posture.Enabled
	if app.Access.PostureRequired != nil {
		postureRequired = *app.Access.PostureRequired
	} else if config.Organization.PostureRequiredForZone(app.ResolvedTrustZone()) {
		postureRequired = true
	}
	return &gateway.AccessInput{
		AllowedGroups:   app.Access.AllowedGroups,
		AllowedIdPs:     app.Access.AllowedIdPs,
		PostureRequired: postureRequired,
	}
}

func Register(ctx context.Context, name, endpoint, description string, skipCodegen bool) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	result := registerApplication(ctx, root, loaded, name, endpoint, description, skipCodegen)
	platform.SyncDiscovery(ctx)
	output.PrintJSON(result)
}

func registerApplication(
	ctx context.Context,
	root string,
	loaded *manifest.Manifest,
	name, endpointOverride, descriptionOverride string,
	skipCodegen bool,
) map[string]any {
	app := loaded.Application(name)
	if app.Internal {
		output.Fail("application %s is internal and is not registered through the registry", name)
	}
	endpoint := app.Endpoint
	if endpointOverride != "" {
		endpoint = endpointOverride
	}
	description := app.Description
	if descriptionOverride != "" {
		description = descriptionOverride
	}

	resources, hasResources := applicationResources(root, name)
	if !hasResources {
		output.Logger.Info("no HTTP resources; registering client-only application", "application", name)
	}
	providerConfig := provider.LoadConfig(root)
	impersonationClientID := ""
	if app.AllowsImpersonation() {
		impersonationClientID = impersonationAccessClientID(name, providerConfig)
	} else {
		output.Logger.Info("skipping impersonation access app (impersonatable: false)", "application", name)
	}
	providerOAuthClientID, providerOAuth := provisionProviderOAuth(ctx, name, app, providerConfig)
	s := platform.Session(ctx)
	response, err := s.RegisterApplicationHTTP(ctx, gateway.RegisterApplicationInput{
		Name:                        name,
		Endpoint:                    endpoint,
		Description:                 description,
		Resources:                   resources,
		Delegations:                 manifestDelegations(app),
		Provider:                    app.ProxyProvider(),
		TrustBoundary:               manifestTrustBoundary(app, providerConfig),
		Access:                      manifestAccess(app, providerConfig),
		TrustZone:                   app.ResolvedTrustZone(),
		ImpersonationAccessClientID: impersonationClientID,
		ProviderOauthClientID:       providerOAuthClientID,
		ProviderOauthScopes:         app.ProviderAPIScopes,
	})
	if err != nil {
		output.Fail("register application: %v", err)
	}

	if !skipCodegen {
		if hasResources || app.BrowserAuthClient {
			generatePlatform(root)
		} else if err := bffgen.Generate(root, name); err != nil {
			output.Fail("generate bff worker for %s: %v", name, err)
		}
	}

	var credential *sdksecrets.ClientCredential
	if cred, ok := sdksecrets.ServiceClientCredential(response.Credential.ClientID, response.Credential.ClientSecret); ok {
		credential = secrets.StoreServiceCredential(
			ctx,
			name,
			cred.ClientID,
			cred.ClientSecret,
			app.Provider(),
		)
	} else if existing := platform.CredentialDocument(root, name); existing != nil {
		credential = existing.Credential
		output.Logger.Info("kept existing service client credential", "application", name)
	} else {
		output.Logger.Info("application has a registered client but no local credential; run platy app rotate-client", "application", name)
	}
	registered := &discovery.Application{}
	if err := json.Unmarshal(response.Application, registered); err != nil {
		output.Fail("decode registered application: %v", err)
	}
	document := applications.Document(registered, s.GatewayURL(), credential, providerOAuth)
	applications.MergeRepoMetadata(root, document)
	applications.WriteRepoMetadata(root, document)
	syncGatewayProviderOAuthVars(root)
	// The gateway needs the confidential provider OAuth client to mint
	// delegated provider tokens; deliver it as part of registration rather
	// than only on the next idp deploy.
	if providerOAuth != nil {
		if err := pushGatewayProviderOAuthSecrets(ctx, root, nil); err != nil {
			output.Logger.Info("provider oauth clients not pushed to gateway; run platy deploy idp", "error", err)
		}
	}
	platform.Session(ctx).InvalidateDiscovery()
	return map[string]any{
		"application": applications.JSON(registered),
		"credential":  credential,
	}
}

func Sync(ctx context.Context, prune bool) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	results := SyncApplications(ctx, root, loaded, nil, prune)
	providerConfig := provider.LoadConfig(root)
	if err := provider.SyncToGateway(ctx, providerConfig); err != nil {
		output.Logger.Info("provider config not synced to gateway", "error", err)
	}
	output.PrintJSON(results)
}

func List(ctx context.Context) {
	apps, err := platform.Session(ctx).ListApplicationsHTTP(ctx)
	if err != nil {
		output.Fail("list applications: %v", err)
	}
	for index := range apps {
		if index > 0 {
			output.PrintLines("")
		}
		app := apps[index]
		display.PrintApplicationSummary(applications.Document(&app, "", nil, nil))
	}
}

func Get(ctx context.Context, name string) {
	app, err := platform.Session(ctx).GetApplicationHTTP(ctx, name)
	if err != nil {
		output.Fail("get application: %v", err)
	}
	output.PrintJSON(applications.JSON(app))
}

func Delete(ctx context.Context, name string) {
	deleted, err := platform.Session(ctx).DeleteApplicationHTTP(ctx, name)
	if err != nil {
		output.Fail("delete application: %v", err)
	}
	if err := os.Remove(applications.RepoMetadataPath(platform.RepoRoot(), name)); err != nil && !os.IsNotExist(err) {
		output.Fail("remove application metadata: %v", err)
	}
	platform.SyncDiscovery(ctx)
	output.PrintJSON(map[string]any{"deleted": deleted, "name": name})
}

func RotateClient(ctx context.Context, name string) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	providerName := loaded.Application(name).Provider()
	s := platform.Session(ctx)
	credentialHTTP, err := s.RegisterClientHTTP(ctx, name)
	if err != nil {
		output.Fail("rotate client: %v", err)
	}
	credential := secrets.StoreServiceCredential(ctx, name, credentialHTTP.ClientID, credentialHTTP.ClientSecret, providerName)
	registered, err := s.Application(ctx, name)
	if err != nil {
		output.Fail("application metadata: %v", err)
	}
	registered.GatewayURL = s.GatewayURL()
	registered.Credential = credential
	applications.MergeRepoMetadata(root, registered)
	applications.WriteRepoMetadata(root, registered)
	output.PrintJSON(credential)
}
