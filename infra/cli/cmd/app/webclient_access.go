package app

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"jsmunro.me/platy/cli/internal/cfauth"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
)

var errInvalidEndpoint = errors.New("invalid endpoint")

func provisionWebClientBypassAccess(
	ctx context.Context,
	name string,
	endpoint string,
	config provider.ProviderConfig,
) {
	domain, err := endpointHost(endpoint)
	if err != nil {
		output.Logger.Warn("skipping web client access bypass", "application", name, "error", err)
		return
	}
	proxy := cfauth.ProxyForAccess(ctx)
	if err := proxy.EnsureWebClientBypassAccess(ctx, config.Boundary, name, domain); err != nil {
		output.Logger.Warn("web client access bypass", "application", name, "domain", domain, "error", err)
	}
}

func endpointHost(endpoint string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", errInvalidEndpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return "", errInvalidEndpoint
	}
	return host, nil
}

func provisionClientOnlyWebAccess(
	ctx context.Context,
	name string,
	app *manifest.Application,
	endpoint string,
	hasProto bool,
	config provider.ProviderConfig,
) {
	if hasProto || app.AllowsImpersonation() {
		return
	}
	provisionWebClientBypassAccess(ctx, name, endpoint, config)
}
