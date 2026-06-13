package secrets

import (
	"context"
	"strings"

	"jsmunro.me/platy/cli/internal/output"
	sdkplatform "jsmunro.me/platy/sdk/platform"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func Service() *sdksecrets.Service {
	service, err := sdkplatform.SecretsService(output.Logger)
	if err != nil {
		output.Fail("secret service: %v", err)
	}
	root, err := sdkplatform.RepoRoot()
	if err != nil {
		output.Fail("repo root: %v", err)
	}
	registerCloudflareSecretsStore(service, root)
	return service
}

func ResolveValue(ctx context.Context, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	providerName := sdksecrets.ProviderForReference(value)
	if providerName == "" {
		return value
	}
	resolved, err := Service().Resolve(ctx, value, providerName)
	if err != nil {
		output.Fail("resolve secret: %v", err)
	}
	return resolved
}

func ResolveCloudflareAPIToken(ctx context.Context, override, organizationRef string) string {
	if token := ResolveValue(ctx, override); token != "" {
		return token
	}
	return ResolveValue(ctx, organizationRef)
}

func StoreProviderOAuthCredential(ctx context.Context, app, clientID, clientSecret, provider string) *sdksecrets.ClientCredential {
	if provider == "" {
		provider = sdksecrets.OnePasswordProvider
	}
	credential, err := Service().Application.StoreProviderOAuthCredential(ctx, app, clientID, clientSecret, provider)
	if err != nil {
		output.Fail("store provider oauth credential: %v", err)
	}
	output.Logger.Info("stored provider oauth credential", "provider", credential.Provider, "application", app)
	return credential
}

func StoreServiceCredential(ctx context.Context, app, clientID, clientSecret, provider string) *sdksecrets.ClientCredential {
	if provider == "" {
		provider = sdksecrets.OnePasswordProvider
	}
	credential, err := Service().Application.StoreServiceClientCredential(ctx, app, clientID, clientSecret, provider)
	if err != nil {
		output.Fail("store client secret: %v", err)
	}
	output.Logger.Info("stored service client credential", "provider", credential.Provider, "application", app)
	return credential
}
