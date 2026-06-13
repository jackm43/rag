package secrets

import (
	"context"
	"fmt"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func CloudflareSecretsStoreFactory(root string) *sdksecrets.CloudflareSecretsStoreFactory {
	config := provider.LoadConfig(root)
	organization, err := provider.LoadOrganization(root)
	if err != nil {
		output.Fail("%v", err)
	}
	return &sdksecrets.CloudflareSecretsStoreFactory{
		AccountID: config.Boundary.AccountID,
		StoreID:   config.SecretsStoreID,
		Token: func(ctx context.Context) (string, error) {
			token := ResolveCloudflareAPIToken(ctx, "", organization.CloudflareAPITokenRef())
			if token == "" {
				return "", fmt.Errorf("cloudflare api token is not configured")
			}
			return token, nil
		},
		Logger: output.Logger,
	}
}

func registerCloudflareSecretsStore(service *sdksecrets.Service, root string) {
	service.RegisterProvider(CloudflareSecretsStoreFactory(root).Provider())
}
