package platform

import (
	"context"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/client"
	"jsmunro.me/platy/sdk/gateway"
	sdkplatform "jsmunro.me/platy/sdk/platform"
)

const DefaultGatewayURL = sdkplatform.DefaultGatewayURL

func Session() *gateway.Session {
	session, err := sdkplatform.NewSession(context.Background(), output.Logger)
	if err != nil {
		output.Fail("gateway session: %v", err)
	}
	return session
}

func Client() *client.Client {
	c, err := sdkplatform.NewClient(context.Background(), output.Logger)
	if err != nil {
		output.Fail("request client: %v", err)
	}
	return c
}

func CredentialDocument(root, application string) *discovery.Application {
	return sdkplatform.CredentialDocument(root, application)
}

func RepoRoot() string {
	root, err := sdkplatform.RepoRoot()
	if err != nil {
		output.Fail("%v", err)
	}
	return root
}

// SyncDiscovery triggers re-ingestion of the gateway registry into the
// discovery application after registry mutations. Best effort: failures are
// logged, never fatal.
func SyncDiscovery(ctx context.Context) {
	state, err := Session().SyncDiscovery(ctx)
	if err != nil {
		output.Logger.Warn("discovery sync failed; the read model may be stale", "error", err)
		return
	}
	output.Logger.Info(
		"discovery synced",
		"applications", state.Applications,
		"delegations", state.Delegations,
		"methods", state.Methods,
	)
}
