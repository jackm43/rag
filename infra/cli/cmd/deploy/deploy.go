package deploy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"

	"jsmunro.me/platy/cli/internal/applications"
	"jsmunro.me/platy/cli/internal/args"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/cli/internal/wrangler"
)

func Run(ctx context.Context, cmdArgs []string) {
	if args.HasHelpFlag(cmdArgs) {
		output.PrintLines(
			"usage: platy deploy [app...]",
			"",
			"Deploys the workers declared in "+manifest.RelativePath+" (all when no app is named).",
			"Application secrets declared in the manifest are resolved through 1Password and",
			"pushed to each worker; bootstrap metadata is synced into the gateway config.",
		)
		return
	}
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	names := cmdArgs
	if len(names) == 0 {
		names = loaded.Names()
	}
	wranglerEnv := wranglerDeployEnv(ctx, root)
	wrangler.InjectBootstrapVars(root, loaded)

	for _, name := range names {
		app := loaded.Application(name)
		if app.Config == "" {
			output.Fail("application %s has no wrangler config in %s", name, manifest.RelativePath)
		}
		output.Logger.Info("deploying worker", "app", name, "worker", app.Worker, "config", app.Config)
		if err := wrangler.Run(root, wranglerEnv, "", "deploy", "-c", app.Config); err != nil {
			output.Fail("deploy %s: %v", name, err)
		}
		pushWorkerSecrets(ctx, root, name, app, wranglerEnv)
		if !app.Internal {
			pushServiceCredential(ctx, root, name, app, wranglerEnv)
		}
	}

	for _, name := range names {
		app := loaded.Application(name)
		for _, hook := range app.PostDeploy {
			runPostDeploy(ctx, name, app, hook)
		}
	}
	output.PrintJSON(map[string]any{"deployed": names})
}

func wranglerDeployEnv(ctx context.Context, root string) []string {
	env := os.Environ()
	organization := provider.LoadOrganization(root)
	token := secrets.ResolveCloudflareAPIToken(ctx, "", organization.CloudflareAPITokenRef())
	if token != "" {
		env = append(env, "CLOUDFLARE_API_TOKEN="+token)
	}
	return env
}

func pushWorkerSecrets(ctx context.Context, root, name string, app *manifest.Application, env []string) {
	resolved := app.ResolveSecrets(ctx)
	if len(resolved) == 0 {
		return
	}
	payload, err := json.Marshal(resolved)
	if err != nil {
		output.Fail("encode worker secrets for %s: %v", name, err)
	}
	output.Logger.Info("pushing worker secrets", "app", name, "worker", app.Worker, "keys", len(resolved))
	if err := wrangler.Run(root, env, string(payload), "secret", "bulk", "-c", app.Config); err != nil {
		output.Fail("push worker secrets for %s: %v", name, err)
	}
}

func pushServiceCredential(ctx context.Context, root, name string, app *manifest.Application, env []string) {
	document := applications.CredentialDocument(root, name)
	if document == nil {
		output.Logger.Debug("no service credential to push", "app", name)
		return
	}
	resolved, err := secrets.Service().Application.ResolveServiceClientCredential(ctx, document.Credential)
	if err != nil {
		output.Fail("resolve service credential for %s: %v", name, err)
	}
	payload, err := json.Marshal(map[string]string{
		"SERVICE_CLIENT_ID":     resolved.ClientID,
		"SERVICE_CLIENT_SECRET": resolved.ClientSecret,
	})
	if err != nil {
		output.Fail("encode service credential for %s: %v", name, err)
	}
	output.Logger.Info("pushing service credential to worker", "app", name, "worker", app.Worker)
	if err := wrangler.Run(root, env, string(payload), "secret", "bulk", "-c", app.Config); err != nil {
		output.Fail("push service credential for %s: %v", name, err)
	}
}

func runPostDeploy(ctx context.Context, name string, app *manifest.Application, hook string) {
	switch hook {
	case "gateway-start":
		resolved := app.ResolveSecrets(ctx)
		token := resolved["DISCORD_BOT_TOKEN"]
		if token == "" {
			output.Fail("post-deploy %s for %s requires DISCORD_BOT_TOKEN in application secrets", hook, name)
		}
		url := strings.TrimRight(app.Endpoint, "/") + "/gateway/start"
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
		if err != nil {
			output.Fail("post-deploy %s: %v", hook, err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			output.Fail("post-deploy %s: %v", hook, err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		if response.StatusCode != http.StatusOK {
			output.Fail("post-deploy %s failed with status %d: %s", hook, response.StatusCode, strings.TrimSpace(string(body)))
		}
		output.Logger.Info("post-deploy hook completed", "app", name, "hook", hook, "response", strings.TrimSpace(string(body)))
	default:
		output.Fail("unknown post-deploy hook %s for application %s", hook, name)
	}
}
