package app

import (
	"context"

	"jsmunro.me/platy/cli/internal/cfauth"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
)

func provisionImpersonationAccessClientID(
	ctx context.Context,
	name string,
	app *manifest.Application,
	config provider.ProviderConfig,
) string {
	proxy := cfauth.ProxyForAccess(ctx)
	access := manifestAccess(app, config)
	postureRequired := access.GetPostureRequired()
	spec, err := proxy.ImpersonationAccessSpec(
		ctx,
		config.Boundary,
		provider.ApplicationAccess{
			AllowedGroups:   access.GetAllowedGroups(),
			AllowedIdPs:     access.GetAllowedIdps(),
			PostureRequired: &postureRequired,
		},
		config.Groups,
		config.IdentityProviders,
		config.EmailAllowlist,
		config.Posture,
	)
	if err != nil {
		output.Fail("impersonation access spec: %v", err)
	}
	created, err := proxy.EnsureImpersonationAccessApplication(ctx, config.Boundary, name, spec)
	if err != nil {
		output.Fail("impersonation access app: %v", err)
	}
	return created.ClientID
}
