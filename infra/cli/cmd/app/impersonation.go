package app

import (
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
)

func impersonationAccessClientID(name string, config provider.ProviderConfig) string {
	clientID := config.ImpersonationClients[name]
	if clientID == "" {
		output.Fail(
			"no impersonation access client for %s in %s; the impersonation Access application is managed by infra/terraform - run terraform -chdir=infra/terraform apply",
			name, provider.ConfigRelativePath,
		)
	}
	return clientID
}
