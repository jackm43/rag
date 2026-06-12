package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"
	"github.com/spf13/cobra"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/cli/cmd/bootstrap"
	"jsmunro.me/platy/cli/internal/applications"
	"jsmunro.me/platy/cli/internal/display"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/cli/internal/webgen"
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
	cmd.Flags().BoolVar(&skipCodegen, "skip-codegen", false, "skip protobuf code generation after registration")
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

func protoResources(root, name string) ([]*idpv1.Resource, map[string]string) {
	outputPath := filepath.Join(os.TempDir(), fmt.Sprintf("platy-%s.binpb", name))
	defer os.Remove(outputPath)
	build := exec.Command(
		"buf", "build", filepath.Join(root, "infra", "proto"),
		"--path", filepath.Join(root, "infra", "proto", name),
		"-o", outputPath,
	)
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		output.Fail("buf build for %s: %v", name, err)
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		output.Fail("read descriptor set: %v", err)
	}
	descriptorSet := &descriptorpb.FileDescriptorSet{}
	if err := proto.Unmarshal(data, descriptorSet); err != nil {
		output.Fail("decode descriptor set: %v", err)
	}

	resources := []*idpv1.Resource{}
	fullNames := map[string]string{}
	for _, file := range descriptorSet.GetFile() {
		pkg := file.GetPackage()
		if !strings.HasPrefix(pkg, name+".") {
			continue
		}
		for _, service := range file.GetService() {
			resource := &idpv1.Resource{Name: service.GetName()}
			fullNames[service.GetName()] = pkg + "." + service.GetName()
			for _, method := range service.GetMethod() {
				resource.Methods = append(resource.Methods, &idpv1.ResourceMethod{
					Name:  method.GetName(),
					Scope: fmt.Sprintf("%s/%s.%s", name, service.GetName(), method.GetName()),
				})
			}
			resources = append(resources, resource)
		}
	}
	if len(resources) == 0 {
		output.Fail("no services found in infra/proto/%s", name)
	}
	return resources, fullNames
}

func generateCode(root, name string) {
	script := filepath.Join(root, "infra", "scripts", "generate.sh")
	command := exec.Command(script, name)
	command.Dir = root
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		output.Fail("code generation for %s: %v", name, err)
	}
	webgen.Generate(root, []string{name})
	output.Logger.Info("generated client and server code", "app", name, "dir", filepath.Join("infra", "applications", name))
}

func Register(ctx context.Context, name, endpoint, description string, skipCodegen bool) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	result := registerApplication(ctx, root, loaded, name, endpoint, description, skipCodegen)
	platform.SyncDiscovery(ctx)
	output.PrintJSON(result)
}

func manifestDelegations(app *manifest.Application) []*idpv1.Delegation {
	delegations := []*idpv1.Delegation{}
	for _, delegation := range app.Delegations {
		delegations = append(delegations, &idpv1.Delegation{
			Audience: delegation.Audience,
			Scopes:   delegation.Scopes,
		})
	}
	return delegations
}

func loadProviderConfig(root string) provider.ProviderConfig {
	data, err := os.ReadFile(bootstrap.ProviderConfigPath(root))
	if err != nil {
		output.Fail("read provider config: run platy bootstrap first")
	}
	config := provider.ProviderConfig{}
	if err := json.Unmarshal(data, &config); err != nil {
		output.Fail("decode provider config: %v", err)
	}
	if len(config.Organization.TrustZones) == 0 {
		config.Organization = provider.LoadOrganization(root)
	}
	return config
}

func manifestTrustBoundary(app *manifest.Application, config provider.ProviderConfig) *idpv1.TrustBoundary {
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
	return &idpv1.TrustBoundary{
		Provider:   string(boundary.Provider),
		AccountId:  boundary.AccountID,
		TeamId:     boundary.TeamID,
		TeamName:   boundary.TeamName,
		TeamDomain: boundary.TeamDomain,
	}
}

func manifestAccess(app *manifest.Application, config provider.ProviderConfig) *idpv1.ApplicationAccess {
	postureRequired := config.Posture.Enabled
	if app.Access.PostureRequired != nil {
		postureRequired = *app.Access.PostureRequired
	} else if config.Organization.PostureRequiredForZone(app.ResolvedTrustZone()) {
		postureRequired = true
	}
	return &idpv1.ApplicationAccess{
		AllowedGroups:   app.Access.AllowedGroups,
		AllowedIdps:     app.Access.AllowedIdPs,
		PostureRequired: postureRequired,
	}
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

	// Applications without a proto package are client-only principals
	// (confidential web clients, connectors): they register for a service
	// credential and delegations but expose no RPC resources of their own.
	resources, fullNames, hasProto := applicationResources(root, name)
	if !hasProto {
		output.Logger.Info("no proto package; registering client-only application", "application", name)
	}
	providerConfig := loadProviderConfig(root)
	impersonationClientID := ""
	if app.AllowsImpersonation() {
		impersonationClientID = provisionImpersonationAccessClientID(ctx, name, app, providerConfig)
	} else {
		output.Logger.Info("skipping impersonation access app (impersonatable: false)", "application", name)
	}
	provisionClientOnlyWebAccess(ctx, name, app, endpoint, hasProto, providerConfig)
	providerOAuthClientID, providerOAuth := provisionProviderOAuth(ctx, name, app, providerConfig)
	s := platform.Session()
	response, err := s.RegistryClient().RegisterApplication(ctx, connect.NewRequest(&idpv1.RegisterApplicationRequest{
		Name:                        name,
		Endpoint:                    endpoint,
		Description:                 description,
		Resources:                   resources,
		Delegations:                 manifestDelegations(app),
		Provider:                    app.ProxyProvider(),
		TrustBoundary:               manifestTrustBoundary(app, providerConfig),
		Access:                      manifestAccess(app, providerConfig),
		TrustZone:                   app.ResolvedTrustZone(),
		ImpersonationAccessClientId: impersonationClientID,
		ProviderOauthClientId:       providerOAuthClientID,
		ProviderOauthScopes:         app.ProviderAPIScopes,
	}))
	if err != nil {
		output.Fail("register application: %v", err)
	}

	if !skipCodegen && hasProto {
		generateCode(root, name)
	}

	var credential *sdksecrets.ClientCredential
	if response.Msg.Credential.GetClientId() != "" {
		credential = secrets.StoreServiceCredential(
			ctx,
			name,
			response.Msg.Credential.GetClientId(),
			response.Msg.Credential.GetClientSecret(),
			app.Provider(),
		)
	} else if existing := platform.CredentialDocument(root, name); existing != nil {
		credential = existing.Credential
		output.Logger.Info("kept existing service client credential", "application", name)
	} else {
		output.Logger.Info("application has a registered client but no local credential; run platy app rotate-client", "application", name)
	}
	document := applications.Document(response.Msg.Application, s.GatewayURL, credential, providerOAuth, fullNames)
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
	platform.Session().InvalidateDiscovery()
	return map[string]any{
		"application": applications.JSON(response.Msg.Application),
		"credential":  credential,
	}
}

func Sync(ctx context.Context, prune bool) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	results := SyncApplications(ctx, root, loaded, nil, prune)
	if config, err := os.ReadFile(bootstrap.ProviderConfigPath(root)); err == nil {
		providerConfig := provider.ProviderConfig{}
		if err := json.Unmarshal(config, &providerConfig); err == nil {
			if err := provider.SyncToGateway(ctx, providerConfig); err != nil {
				output.Logger.Info("provider config not synced to gateway", "error", err)
			}
		}
	}
	output.PrintJSON(results)
}

func List(ctx context.Context) {
	response, err := platform.Session().RegistryClient().ListApplications(ctx, connect.NewRequest(&idpv1.ListApplicationsRequest{}))
	if err != nil {
		output.Fail("list applications: %v", err)
	}
	for index, registered := range response.Msg.Applications {
		if index > 0 {
			output.PrintLines("")
		}
		display.PrintApplicationSummary(applications.Document(registered, "", nil, nil, nil))
	}
}

func Get(ctx context.Context, name string) {
	response, err := platform.Session().RegistryClient().GetApplication(ctx, connect.NewRequest(&idpv1.GetApplicationRequest{Name: name}))
	if err != nil {
		output.Fail("get application: %v", err)
	}
	output.PrintJSON(applications.JSON(response.Msg.Application))
}

func Delete(ctx context.Context, name string) {
	response, err := platform.Session().RegistryClient().DeleteApplication(ctx, connect.NewRequest(&idpv1.DeleteApplicationRequest{Name: name}))
	if err != nil {
		output.Fail("delete application: %v", err)
	}
	if err := os.Remove(applications.RepoMetadataPath(platform.RepoRoot(), name)); err != nil && !os.IsNotExist(err) {
		output.Fail("remove application metadata: %v", err)
	}
	platform.SyncDiscovery(ctx)
	output.PrintJSON(map[string]any{"deleted": response.Msg.Deleted, "name": name})
}

func RotateClient(ctx context.Context, name string) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	provider := loaded.Application(name).Provider()
	s := platform.Session()
	response, err := s.RegistryClient().RegisterClient(ctx, connect.NewRequest(&idpv1.RegisterClientRequest{Application: name}))
	if err != nil {
		output.Fail("rotate client: %v", err)
	}
	credential := secrets.StoreServiceCredential(ctx, name, response.Msg.Credential.GetClientId(), response.Msg.Credential.GetClientSecret(), provider)
	registered, err := s.Application(ctx, name)
	if err != nil {
		output.Fail("application metadata: %v", err)
	}
	registered.GatewayURL = s.GatewayURL
	registered.Credential = credential
	applications.MergeRepoMetadata(root, registered)
	applications.WriteRepoMetadata(root, registered)
	output.PrintJSON(credential)
}
