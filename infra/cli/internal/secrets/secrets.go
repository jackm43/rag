package secrets

import (
	"context"
	"strings"

	"jsmunro.me/platy/cli/internal/output"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

const servicesVaultID = "mqrwrig24fxs3ssywmf3pxwqgy"

func Service() *sdksecrets.Service {
	file, err := sdksecrets.DefaultFile()
	if err != nil {
		output.Fail("file secret provider: %v", err)
	}
	return sdksecrets.NewService(&sdksecrets.OnePassword{VaultID: servicesVaultID, Logger: output.Logger}, file)
}

func ResolveValue(ctx context.Context, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if !strings.HasPrefix(value, "op://") {
		return value
	}
	resolved, err := Service().Resolve(ctx, value, sdksecrets.OnePasswordProvider)
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
