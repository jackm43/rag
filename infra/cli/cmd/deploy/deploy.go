package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"

	"github.com/spf13/cobra"
	"golang.org/x/sync/errgroup"

	cmdapp "jsmunro.me/platy/cli/cmd/app"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/cli/internal/wrangler"
)

const deployConcurrency = 4

func Command() *cobra.Command {
	force := false
	cmd := &cobra.Command{
		Use:   "deploy [app...]",
		Short: "Deploy workers from applications.yaml with 1Password secrets",
		Long: "Deploys the workers declared in " + manifest.RelativePath + " (all when no app is named).\n" +
			"Application secrets declared in the manifest are resolved through 1Password and\n" +
			"pushed to each worker; terraform client metadata is synced into the gateway config.\n" +
			"Applications whose inputs are unchanged since the last deploy are skipped.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run(cmd.Context(), args, force)
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "deploy even when no inputs changed since the last deploy")
	return cmd
}

func run(ctx context.Context, names []string, force bool) error {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	if len(names) == 0 {
		names = loaded.Names()
	}
	for _, name := range names {
		if loaded.Application(name).Config == "" {
			return fmt.Errorf("application %s has no wrangler config in %s", name, manifest.RelativePath)
		}
	}
	output.Logger.Info("reconciling application registry from manifest before deploy")
	cmdapp.SyncApplications(ctx, root, loaded, names, false)
	wranglerEnv, apiToken := wranglerDeployEnv(ctx, root)
	wrangler.InjectGatewayVars(root, loaded)

	state, err := loadState(root)
	if err != nil {
		return err
	}

	var mu sync.Mutex
	deployed := []string{}
	skipped := []string{}

	// Service bindings can only reference workers that already exist, so a
	// first-time deploy must create dependencies before dependents. Apps are
	// grouped into topological waves of the binding graph; each wave still
	// deploys in parallel.
	for _, wave := range deployWaves(root, loaded, names) {
		group, groupCtx := errgroup.WithContext(ctx)
		group.SetLimit(deployConcurrency)
		for _, name := range wave {
			app := loaded.Application(name)
			group.Go(func() error {
				didDeploy, err := deployApplication(groupCtx, root, name, app, wranglerEnv, apiToken, state, force)
				if err != nil {
					return err
				}
				mu.Lock()
				defer mu.Unlock()
				if didDeploy {
					deployed = append(deployed, name)
				} else {
					skipped = append(skipped, name)
				}
				return nil
			})
		}
		if err := group.Wait(); err != nil {
			return err
		}
	}

	for _, name := range names {
		app := loaded.Application(name)
		for _, hook := range app.PostDeploy {
			if err := runPostDeploy(ctx, name, app, hook); err != nil {
				return err
			}
		}
	}
	sort.Strings(deployed)
	sort.Strings(skipped)
	output.PrintJSON(map[string]any{"deployed": deployed, "skipped": skipped})
	return nil
}

func deployApplication(
	ctx context.Context,
	root, name string,
	app *manifest.Application,
	env []string,
	apiToken string,
	state *stateStore,
	force bool,
) (bool, error) {
	resolved, err := app.ResolveSecrets(ctx)
	if err != nil {
		return false, fmt.Errorf("resolve secrets for %s: %w", name, err)
	}
	var providerOAuth map[string]string
	if name == "idp" {
		providerOAuth = cmdapp.ResolvedProviderOAuthClients(ctx, root)
	}
	clientID := ""
	if document := platform.CredentialDocument(root, name); document != nil && document.Credential != nil {
		clientID = document.Credential.ClientID
	}
	hash, err := computeHash(root, name, app, resolved, providerOAuth, clientID)
	if err != nil {
		return false, fmt.Errorf("hash deploy inputs for %s: %w", name, err)
	}
	if !force && state.hash(name) == hash {
		output.Logger.Info("deploy skipped, no changes", "app", name, "worker", app.Worker)
		return false, nil
	}

	out := newPrefixWriter(name)
	defer out.Flush()
	output.Logger.Info("deploying worker", "app", name, "worker", app.Worker, "config", app.Config)
	if err := wrangler.Run(root, env, "", out, "deploy", "-c", app.Config); err != nil {
		return false, fmt.Errorf("deploy %s: %w", name, err)
	}
	if err := pushWorkerSecrets(root, name, app, env, out, resolved); err != nil {
		return false, err
	}
	if name == "idp" {
		if err := cmdapp.PushProviderOAuthClients(root, env, out, providerOAuth); err != nil {
			return false, fmt.Errorf("push provider oauth secrets: %w", err)
		}
	}
	if !app.Internal {
		if err := pushServiceCredential(ctx, root, name, app, env, out); err != nil {
			return false, err
		}
	}
	reconcileRoutes(apiToken, root, name, app)
	if err := state.record(name, hash); err != nil {
		return false, fmt.Errorf("record deploy state for %s: %w", name, err)
	}
	return true, nil
}

func wranglerDeployEnv(ctx context.Context, root string) ([]string, string) {
	env := os.Environ()
	organization, err := provider.LoadOrganization(root)
	if err != nil {
		output.Fail("%v", err)
	}
	token := secrets.ResolveCloudflareAPIToken(ctx, "", organization.CloudflareAPITokenRef())
	if token != "" {
		env = append(env, "CLOUDFLARE_API_TOKEN="+token)
	}
	return env, token
}

func pushWorkerSecrets(root, name string, app *manifest.Application, env []string, out io.Writer, resolved map[string]string) error {
	if len(resolved) == 0 {
		return nil
	}
	payload, err := json.Marshal(resolved)
	if err != nil {
		return fmt.Errorf("encode worker secrets for %s: %w", name, err)
	}
	output.Logger.Info("pushing worker secrets", "app", name, "worker", app.Worker, "keys", len(resolved))
	if err := wrangler.Run(root, env, string(payload), out, "secret", "bulk", "-c", app.Config); err != nil {
		return fmt.Errorf("push worker secrets for %s: %w", name, err)
	}
	return nil
}

func pushServiceCredential(ctx context.Context, root, name string, app *manifest.Application, env []string, out io.Writer) error {
	document := platform.CredentialDocument(root, name)
	if document == nil {
		output.Logger.Debug("no service credential to push", "app", name)
		return nil
	}
	resolved, err := secrets.Service().Application.ResolveServiceClientCredential(ctx, document.Credential)
	if err != nil {
		return fmt.Errorf("resolve service credential for %s: %w", name, err)
	}
	payload, err := json.Marshal(map[string]string{
		"SERVICE_CLIENT_ID":     resolved.ClientID,
		"SERVICE_CLIENT_SECRET": resolved.ClientSecret,
	})
	if err != nil {
		return fmt.Errorf("encode service credential for %s: %w", name, err)
	}
	output.Logger.Info("pushing service credential to worker", "app", name, "worker", app.Worker)
	if err := wrangler.Run(root, env, string(payload), out, "secret", "bulk", "-c", app.Config); err != nil {
		return fmt.Errorf("push service credential for %s: %w", name, err)
	}
	return nil
}

func runPostDeploy(ctx context.Context, name string, app *manifest.Application, hook string) error {
	switch hook {
	case "gateway-start":
		_, err := platform.Client(ctx).Invoke(ctx, name+".GatewayControlService.StartGateway", "{}")
		if err != nil {
			return fmt.Errorf("post-deploy %s: %w", hook, err)
		}
		output.Logger.Info("post-deploy hook completed", "app", name, "hook", hook)
		return nil
	default:
		return fmt.Errorf("unknown post-deploy hook %s for application %s", hook, name)
	}
}
