package cfauth

import (
	"context"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	cfcloud "jsmunro.me/platy/sdk/cloudflare"
)

type tokenKey struct{}

func WithToken(ctx context.Context, token string) context.Context {
	return context.WithValue(ctx, tokenKey{}, token)
}

func tokenFrom(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(tokenKey{}).(string)
	return token, ok && token != ""
}

func EnsureOAuthToken(ctx context.Context, scopes []string) string {
	if token, ok := tokenFrom(ctx); ok {
		return token
	}
	token, err := platform.DelegatedCloudflare().TokenWithScopes(ctx, scopes, false)
	if err != nil {
		output.Fail("cloudflare authorization: %v", err)
	}
	return token
}

func Proxy(ctx context.Context, scopes []string) provider.IdentityProxy {
	token := EnsureOAuthToken(ctx, scopes)
	proxy, err := provider.Resolve(ctx, provider.Cloudflare, token)
	if err != nil {
		output.Fail("%v", err)
	}
	return proxy
}

func EnsurePlatform(ctx context.Context) context.Context {
	token := EnsureOAuthToken(ctx, cfcloud.PlatformScopeIDs())
	return WithToken(ctx, token)
}

func ProxyForAccess(ctx context.Context) provider.IdentityProxy {
	return Proxy(ctx, cfcloud.AccessManagementScopeIDs)
}
