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
	pushSecrets := false
	cmd := &cobra.Command{
		Use:   "deploy [app...]",
		Short: "Deploy workers from applications.yaml",
		Long: "Deploys the workers declared in " + manifest.RelativePath + " (all when no app is named).\n" +
			"Worker code and config are hashed against .platy/deploy-state.json; unchanged\n" +
			"applications are skipped unless --force is set. Terraform client metadata is\n" +
			"synced into the gateway wrangler config before deploy.\n" +
			"Use --push-secrets to resolve 1Password manifest secrets and run wrangler secret bulk.",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run(cmd.Context(), args, force, pushSecrets)
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "deploy and push secrets even when inputs are unchanged")
	cmd.Flags().BoolVar(&pushSecrets, "push-secrets", false, "resolve manifest secrets and push them with wrangler secret bulk")
	return cmd
}

func run(ctx context.Context, names []string, force, pushSecrets bool) error {
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
	secretsPushed := []string{}
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
				didDeploy, didPushSecrets, err := deployApplication(groupCtx, root, name, app, wranglerEnv, apiToken, state, force, pushSecrets)
				if err != nil {
					return err
				}
				mu.Lock()
				defer mu.Unlock()
				if didDeploy {
					deployed = append(deployed, name)
				}
				if didPushSecrets {
					secretsPushed = append(secretsPushed, name)
				}
				if !didDeploy && !didPushSecrets {
					skipped = append(skipped, name)
				}
				return nil
			})
		}
		if err := group.Wait(); err != nil {
			return err
		}
	}

	sort.Strings(deployed)
	sort.Strings(secretsPushed)
	sort.Strings(skipped)
	output.PrintJSON(map[string]any{"deployed": deployed, "secrets_pushed": secretsPushed, "skipped": skipped})
	return nil
}

func deployApplication(
	ctx context.Context,
	root, name string,
	app *manifest.Application,
	env []string,
	apiToken string,
	state *stateStore,
	force, pushSecrets bool,
) (bool, bool, error) {
	deployHash, err := computeDeployHash(root, name, app)
	if err != nil {
		return false, false, fmt.Errorf("hash deploy inputs for %s: %w", name, err)
	}
	needsDeploy := force || state.hash(name) != deployHash

	var resolved map[string]string
	var providerOAuth map[string]string
	clientID := ""
	secretsHash := ""
	needsSecrets := false
	if pushSecrets {
		resolved, err = app.ResolveSecrets(ctx)
		if err != nil {
			return false, false, fmt.Errorf("resolve secrets for %s: %w", name, err)
		}
		if name == "idp" {
			providerOAuth = cmdapp.ResolvedProviderOAuthClients(ctx, root)
		}
		if document := platform.CredentialDocument(root, name); document != nil && document.Credential != nil {
			clientID = document.Credential.ClientID
		}
		secretsHash = computeSecretsHash(resolved, providerOAuth, clientID)
		needsSecrets = force || state.secretsHash(name) != secretsHash
	}

	if !needsDeploy && !needsSecrets {
		output.Logger.Info("deploy skipped, no changes", "app", name, "worker", app.Worker)
		return false, false, nil
	}

	out := newPrefixWriter(name)
	defer out.Flush()

	if needsDeploy {
		output.Logger.Info("deploying worker", "app", name, "worker", app.Worker, "config", app.Config)
		if err := wrangler.Run(root, env, "", out, "deploy", "-c", app.Config); err != nil {
			return false, false, fmt.Errorf("deploy %s: %w", name, err)
		}
		reconcileRoutes(apiToken, root, name, app)
		if err := state.recordDeploy(name, deployHash); err != nil {
			return false, false, fmt.Errorf("record deploy state for %s: %w", name, err)
		}
		for _, hook := range app.PostDeploy {
			if err := runPostDeploy(ctx, name, app, hook); err != nil {
				return false, false, err
			}
		}
	}

	if needsSecrets {
		if app.UsesSecretsStore() {
			if err := pushSecretsStoreBindings(ctx, root, name, app, env, out, resolved, providerOAuth, clientID); err != nil {
				return needsDeploy, false, err
			}
		} else {
			if err := pushWorkerSecrets(root, name, app, env, out, resolved); err != nil {
				return needsDeploy, false, err
			}
			if name == "idp" {
				if err := cmdapp.PushProviderOAuthClients(root, env, out, providerOAuth); err != nil {
					return needsDeploy, false, fmt.Errorf("push provider oauth secrets: %w", err)
				}
			}
			if !app.Internal {
				if err := pushServiceCredential(ctx, root, name, app, env, out); err != nil {
					return needsDeploy, false, err
				}
			}
		}
		if err := state.recordSecrets(name, secretsHash); err != nil {
			return needsDeploy, false, fmt.Errorf("record secrets state for %s: %w", name, err)
		}
	}

	return needsDeploy, needsSecrets, nil
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
