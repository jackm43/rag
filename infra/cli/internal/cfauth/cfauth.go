package cfauth

import (
	"context"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
)

func ProxyForAccess(ctx context.Context) provider.IdentityProxy {
	config := provider.LoadOrganization(platform.RepoRoot())
	token := secrets.ResolveCloudflareAPIToken(ctx, "", config.CloudflareAPITokenRef())
	proxy, err := provider.Resolve(ctx, provider.Cloudflare, token)
	if err != nil {
		output.Fail("%v", err)
	}
	return proxy
}
