package app

import (
	"context"
	"encoding/json"
	"os"
	"strings"

	"connectrpc.com/connect"
	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/cli/internal/applications"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/sdk/discovery"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func provisionProviderOAuth(
	ctx context.Context,
	name string,
	app *manifest.Application,
	config provider.ProviderConfig,
) (string, *sdksecrets.ClientCredential) {
	if app.ProxyProvider() != string(provider.Cloudflare) || app.ProviderAuthMode() != manifest.ProviderAuthOAuth {
		return "", nil
	}
	apiToken := secrets.ResolveCloudflareAPIToken(ctx, "", config.Organization.Organization.Secrets["cloudflare_api_token"])
	proxy, err := provider.Resolve(ctx, provider.Cloudflare, apiToken)
	if err != nil {
		output.Fail("provider oauth client: %v", err)
	}
	callbackURL := strings.TrimRight(platform.DefaultGatewayURL, "/")
	if gatewayURL := platform.Session().GatewayURL; gatewayURL != "" {
		callbackURL = strings.TrimRight(gatewayURL, "/")
	}
	clientID, clientSecret, _, err := proxy.EnsureApplicationOAuthClient(
		ctx,
		config.Boundary,
		name,
		app.ProviderAPIScopes,
		callbackURL,
	)
	if err != nil {
		output.Fail("provider oauth client: %v", err)
	}
	rotated := false
	if clientSecret == "" && clientID != "" {
		if existing := resolveProviderOAuthCredential(ctx, platform.RepoRoot(), name, app); existing != nil {
			if _, err := secrets.Service().Application.ResolveProviderOAuthCredential(ctx, existing); err == nil {
				output.Logger.Info("kept existing provider oauth credential", "application", name, "client_id", existing.ClientID)
				return clientID, existing
			}
			output.Logger.Info("rotating provider oauth client secret", "application", name, "client_id", clientID)
		}
		clientSecret, err = proxy.RotateApplicationOAuthClientSecret(ctx, config.Boundary, clientID)
		if err != nil {
			output.Fail("rotate provider oauth client secret: %v", err)
		}
		rotated = true
	}
	if clientSecret != "" {
		credential, err := secrets.Service().Application.StoreProviderOAuthCredential(ctx, name, clientID, clientSecret, app.Provider())
		if err != nil {
			output.Fail("store provider oauth credential: %v", err)
		}
		if rotated {
			if err := proxy.FinalizeApplicationOAuthClientRotation(ctx, config.Boundary, clientID); err != nil {
				output.Fail("finalize provider oauth client rotation: %v", err)
			}
		}
		return clientID, credential
	}
	return clientID, nil
}

func loadProviderOAuthCredential(application string) *sdksecrets.ClientCredential {
	data, err := os.ReadFile(applications.RepoMetadataPath(platform.RepoRoot(), application))
	if err != nil {
		return nil
	}
	document := &discovery.Application{}
	if err := json.Unmarshal(data, document); err != nil {
		return nil
	}
	return document.ProviderOAuth
}

func RotateProviderOAuth(ctx context.Context, name string) {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	app := loaded.Application(name)
	if app.ProviderAuthMode() != manifest.ProviderAuthOAuth {
		output.Fail("application %s does not use provider oauth", name)
	}
	existing := resolveProviderOAuthCredential(ctx, root, name, app)
	if existing == nil || existing.ClientID == "" {
		output.Fail("no provider oauth client for %s; run: platy app register %s", name, name)
	}
	config := loadProviderConfig(root)
	apiToken := secrets.ResolveCloudflareAPIToken(ctx, "", config.Organization.Organization.Secrets["cloudflare_api_token"])
	proxy, err := provider.Resolve(ctx, provider.Cloudflare, apiToken)
	if err != nil {
		output.Fail("provider oauth: %v", err)
	}
	secret, err := proxy.RotateApplicationOAuthClientSecret(ctx, config.Boundary, existing.ClientID)
	if err != nil {
		output.Fail("rotate provider oauth client secret: %v", err)
	}
	credential, err := secrets.Service().Application.StoreProviderOAuthCredential(ctx, name, existing.ClientID, secret, app.Provider())
	if err != nil {
		output.Fail("store provider oauth credential: %v", err)
	}
	registered, err := platform.Session().Application(ctx, name)
	if err != nil {
		output.Fail("application metadata: %v", err)
	}
	registered.ProviderOAuth = credential
	registered.ProviderOAuthClientID = existing.ClientID
	applications.MergeRepoMetadata(root, registered)
	applications.WriteRepoMetadata(root, registered)
	if err := proxy.FinalizeApplicationOAuthClientRotation(ctx, config.Boundary, existing.ClientID); err != nil {
		output.Fail("finalize provider oauth client rotation: %v", err)
	}
	syncGatewayProviderOAuthVars(root)
	PushGatewayProviderOAuthSecrets(ctx, root, nil)
	output.Logger.Info("rotated provider oauth credential", "application", name, "client_id", existing.ClientID)
	output.PrintJSON(credential)
}

func resolveProviderOAuthCredential(ctx context.Context, root, name string, app *manifest.Application) *sdksecrets.ClientCredential {
	if cred := loadProviderOAuthCredential(name); cred != nil && cred.ClientID != "" {
		return cred
	}
	if app.ProviderAuthMode() != manifest.ProviderAuthOAuth {
		return nil
	}
	data, err := os.ReadFile(applications.RepoMetadataPath(root, name))
	if err != nil {
		return nil
	}
	document := &discovery.Application{}
	if err := json.Unmarshal(data, document); err != nil {
		return nil
	}
	if document.ProviderOAuthClientID == "" {
		registered, err := platform.Session().RegistryClient().GetApplication(ctx, connect.NewRequest(&idpv1.GetApplicationRequest{Name: name}))
		if err != nil || registered.Msg.Application.GetProviderOauthClientId() == "" {
			return nil
		}
		document.ProviderOAuthClientID = registered.Msg.Application.GetProviderOauthClientId()
	}
	secretProvider := app.Provider()
	if secretProvider == "" {
		secretProvider = sdksecrets.OnePasswordProvider
	}
	credential, err := secrets.Service().Application.ProviderOAuthCredential(
		ctx,
		name,
		document.ProviderOAuthClientID,
		secretProvider,
	)
	if err != nil {
		output.Logger.Debug("provider oauth credential unavailable", "application", name, "error", err)
		return nil
	}
	return credential
}
