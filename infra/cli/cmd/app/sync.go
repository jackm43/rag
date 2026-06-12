package app

import (
	"context"
	"os"

	"connectrpc.com/connect"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/cli/internal/applications"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
)

func SyncApplications(ctx context.Context, root string, loaded *manifest.Manifest, names []string, prune bool) map[string]any {
	if len(names) == 0 {
		names = loaded.Names()
	}
	providerConfig := loadProviderConfig(root)
	registered := registeredApplications(ctx)
	results := map[string]any{}
	for _, name := range names {
		if loaded.Application(name).Internal {
			continue
		}
		if actual, exists := registered[name]; exists {
			desired := desiredApplication(root, loaded, name, providerConfig)
			if len(diffApplication(desired, actual)) == 0 && platform.CredentialDocument(root, name) != nil {
				output.Logger.Info("application unchanged; skipping", "application", name)
				results[name] = map[string]any{"unchanged": true}
				continue
			}
		}
		results[name] = registerApplication(ctx, root, loaded, name, "", "", false)
	}
	if prune {
		results = pruneOrphanedApplications(ctx, root, loaded, registered, results)
	}
	platform.Session().InvalidateDiscovery()
	platform.SyncDiscovery(ctx)
	return results
}

func pruneOrphanedApplications(
	ctx context.Context,
	root string,
	loaded *manifest.Manifest,
	_ map[string]*idpv1.Application,
	results map[string]any,
) map[string]any {
	response, err := platform.Session().RegistryClient().ListApplications(ctx, connect.NewRequest(&idpv1.ListApplicationsRequest{}))
	if err != nil {
		output.Fail("list applications: %v", err)
	}
	for _, registered := range response.Msg.Applications {
		if registered.Name == "idp" {
			continue
		}
		if _, declared := loaded.Applications[registered.Name]; declared {
			continue
		}
		if _, err := platform.Session().RegistryClient().DeleteApplication(
			ctx,
			connect.NewRequest(&idpv1.DeleteApplicationRequest{Name: registered.Name}),
		); err != nil {
			output.Fail("delete application %s: %v", registered.Name, err)
		}
		if err := os.Remove(applications.RepoMetadataPath(root, registered.Name)); err != nil && !os.IsNotExist(err) {
			output.Fail("remove application metadata: %v", err)
		}
		results[registered.Name] = map[string]any{"deleted": true}
	}
	return results
}
