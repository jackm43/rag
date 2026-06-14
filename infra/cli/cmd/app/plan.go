package app

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/catalog"
)

func applicationResources(root, name string) ([]catalog.Resource, bool) {
	if !catalog.HasApplicationResources(root, name) {
		return nil, false
	}
	resources, err := catalog.ApplicationResources(root, name)
	if err != nil {
		output.Fail("load resources for %s: %v", name, err)
	}
	return resources, true
}

func desiredApplication(
	root string,
	loaded *manifest.Manifest,
	name string,
	providerConfig provider.ProviderConfig,
) *discovery.Application {
	app := loaded.Application(name)
	resources, _ := applicationResources(root, name)
	converted := make([]discovery.Resource, 0, len(resources))
	for _, resource := range resources {
		entry := discovery.Resource{Name: resource.Name}
		for _, method := range resource.Methods {
			entry.Methods = append(entry.Methods, discovery.ResourceMethod{Name: method.Name, Scope: method.Scope})
		}
		converted = append(converted, entry)
	}
	return &discovery.Application{
		Name:                name,
		Endpoint:            app.Endpoint,
		Description:         app.Description,
		Resources:           converted,
		Delegations:         manifestDelegationsDiscovery(app),
		Provider:            app.ProxyProvider(),
		TrustBoundary:       manifestTrustBoundaryDiscovery(app, providerConfig),
		Access:              manifestAccessDiscovery(app, providerConfig),
		TrustZone:           app.ResolvedTrustZone(),
		ProviderOauthScopes: app.ProviderAPIScopes,
	}
}

func diffApplication(desired, actual *discovery.Application) []string {
	changes := []string{}
	scalar := func(field, want, got string) {
		if want != got {
			changes = append(changes, fmt.Sprintf("%s: %q -> %q", field, got, want))
		}
	}
	scalar("endpoint", desired.Endpoint, actual.Endpoint)
	scalar("description", desired.Description, actual.Description)
	scalar("provider", desired.Provider, actual.Provider)
	scalar("trust_zone", desired.TrustZone, actual.TrustZone)

	if !reflect.DeepEqual(desired.Resources, actual.Resources) {
		changes = append(changes, fmt.Sprintf("resources: %d service(s) changed", len(desired.Resources)))
	}
	if !reflect.DeepEqual(sortedDelegationsDiscovery(desired.Delegations), sortedDelegationsDiscovery(actual.Delegations)) {
		desiredJSON, _ := json.Marshal(sortedDelegationsDiscovery(desired.Delegations))
		actualJSON, _ := json.Marshal(sortedDelegationsDiscovery(actual.Delegations))
		changes = append(changes, fmt.Sprintf("delegations: %s -> %s", actualJSON, desiredJSON))
	}
	if !reflect.DeepEqual(desired.Access, actual.Access) {
		desiredJSON, _ := json.Marshal(desired.Access)
		actualJSON, _ := json.Marshal(actual.Access)
		changes = append(changes, fmt.Sprintf("access: %s -> %s", actualJSON, desiredJSON))
	}
	if !reflect.DeepEqual(desired.TrustBoundary, actual.TrustBoundary) {
		desiredJSON, _ := json.Marshal(desired.TrustBoundary)
		actualJSON, _ := json.Marshal(actual.TrustBoundary)
		changes = append(changes, fmt.Sprintf("trust_boundary: %s -> %s", actualJSON, desiredJSON))
	}
	if !slicesEqual(desired.ProviderOauthScopes, actual.ProviderOauthScopes) {
		changes = append(changes, fmt.Sprintf("provider_oauth_scopes: %v -> %v", actual.ProviderOauthScopes, desired.ProviderOauthScopes))
	}
	return changes
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func sortedDelegationsDiscovery(delegations []discovery.Delegation) []discovery.Delegation {
	sorted := append([]discovery.Delegation{}, delegations...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Audience < sorted[j].Audience })
	return sorted
}

func registeredApplications(ctx context.Context) map[string]*discovery.Application {
	apps, err := platform.Session(ctx).ListApplicationsHTTP(ctx)
	if err != nil {
		output.Fail("list applications: %v", err)
	}
	registered := map[string]*discovery.Application{}
	for index := range apps {
		app := apps[index]
		registered[app.Name] = &app
	}
	return registered
}

func Plan(ctx context.Context) int {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	providerConfig := provider.LoadConfig(root)
	registered := registeredApplications(ctx)

	lines := []string{}
	changedCount := 0
	for _, name := range loaded.Names() {
		if loaded.Application(name).Internal {
			lines = append(lines, fmt.Sprintf("  %-12s internal (not registered)", name))
			continue
		}
		desired := desiredApplication(root, loaded, name, providerConfig)
		actual, exists := registered[name]
		if !exists {
			changedCount++
			lines = append(lines, fmt.Sprintf("+ %-12s new application (audience %s, %d resource(s), %d delegation(s))",
				name, name, len(desired.Resources), len(desired.Delegations)))
			continue
		}
		changes := diffApplication(desired, actual)
		if len(changes) == 0 {
			lines = append(lines, fmt.Sprintf("  %-12s unchanged", name))
			continue
		}
		changedCount++
		lines = append(lines, fmt.Sprintf("~ %-12s %d change(s)", name, len(changes)))
		for _, change := range changes {
			lines = append(lines, "      "+change)
		}
	}

	orphans := []string{}
	for name := range registered {
		if name == "idp" {
			continue
		}
		if _, declared := loaded.Applications[name]; !declared {
			orphans = append(orphans, name)
		}
	}
	sort.Strings(orphans)
	for _, name := range orphans {
		lines = append(lines, fmt.Sprintf("- %-12s in registry but not in manifest (removed by app sync --prune)", name))
	}

	output.PrintLines(lines...)
	if changedCount == 0 && len(orphans) == 0 {
		output.PrintLines("", "registry matches the manifest; app sync would change nothing")
		return 0
	}
	output.PrintLines("", fmt.Sprintf("%d application(s) would change; apply with platy app sync", changedCount+len(orphans)))
	return changedCount + len(orphans)
}

func manifestDelegationsDiscovery(app *manifest.Application) []discovery.Delegation {
	delegations := []discovery.Delegation{}
	for _, delegation := range app.Delegations {
		delegations = append(delegations, discovery.Delegation{
			Audience: delegation.Audience,
			Scopes:   delegation.Scopes,
		})
	}
	return delegations
}

func manifestTrustBoundaryDiscovery(app *manifest.Application, config provider.ProviderConfig) discovery.TrustBoundary {
	boundary := config.Boundary
	if app.TrustBoundary.AccountID != "" {
		boundary.AccountID = app.TrustBoundary.AccountID
	}
	if app.TrustBoundary.TeamID != "" {
		boundary.TeamID = app.TrustBoundary.TeamID
	}
	if app.TrustBoundary.TeamName != "" {
		boundary.TeamName = app.TrustBoundary.TeamName
	}
	if app.TrustBoundary.TeamDomain != "" {
		boundary.TeamDomain = app.TrustBoundary.TeamDomain
	}
	return discovery.TrustBoundary{
		Provider:   string(boundary.Provider),
		AccountID:  boundary.AccountID,
		TeamID:     boundary.TeamID,
		TeamName:   boundary.TeamName,
		TeamDomain: boundary.TeamDomain,
	}
}

func manifestAccessDiscovery(app *manifest.Application, config provider.ProviderConfig) discovery.ApplicationAccess {
	postureRequired := config.Posture.Enabled
	if app.Access.PostureRequired != nil {
		postureRequired = *app.Access.PostureRequired
	} else if config.Organization.PostureRequiredForZone(app.ResolvedTrustZone()) {
		postureRequired = true
	}
	return discovery.ApplicationAccess{
		AllowedGroups:   app.Access.AllowedGroups,
		AllowedIdPs:     app.Access.AllowedIdPs,
		PostureRequired: postureRequired,
	}
}
