package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
)

// applicationResources returns the registry resources for an application:
// services/methods from its proto package, or none for client-only
// applications (confidential web clients, connectors) without one.
func applicationResources(root, name string) ([]*idpv1.Resource, map[string]string, bool) {
	if _, err := os.Stat(filepath.Join(root, "infra", "proto", name)); err != nil {
		return []*idpv1.Resource{}, map[string]string{}, false
	}
	resources, fullNames := protoResources(root, name)
	return resources, fullNames, true
}

// desiredApplication builds the registry state the manifest declares for one
// application — the same inputs registerApplication sends, minus the
// provisioned impersonation client id (cloud-side, excluded from diffs).
func desiredApplication(
	root string,
	loaded *manifest.Manifest,
	name string,
	providerConfig provider.ProviderConfig,
) *idpv1.Application {
	app := loaded.Application(name)
	resources, _, _ := applicationResources(root, name)
	return &idpv1.Application{
		Name:                name,
		Endpoint:            app.Endpoint,
		Description:         app.Description,
		Resources:           resources,
		Delegations:         manifestDelegations(app),
		Provider:            app.ProxyProvider(),
		TrustBoundary:       manifestTrustBoundary(app, providerConfig),
		Access:              manifestAccess(app, providerConfig),
		TrustZone:           app.ResolvedTrustZone(),
		ProviderOauthScopes: app.ProviderAPIScopes,
	}
}

var diffJSON = protojson.MarshalOptions{UseProtoNames: true}

func messageChange(field string, desired, actual proto.Message) string {
	return fmt.Sprintf("%s: %s -> %s", field, diffJSON.Format(actual), diffJSON.Format(desired))
}

// diffApplication lists the fields where the manifest's desired state differs
// from the registry, as "field: actual -> desired" strings.
func diffApplication(desired, actual *idpv1.Application) []string {
	changes := []string{}
	scalar := func(field, want, got string) {
		if want != got {
			changes = append(changes, fmt.Sprintf("%s: %q -> %q", field, got, want))
		}
	}
	scalar("endpoint", desired.GetEndpoint(), actual.GetEndpoint())
	scalar("description", desired.GetDescription(), actual.GetDescription())
	scalar("provider", desired.GetProvider(), actual.GetProvider())
	scalar("trust_zone", desired.GetTrustZone(), actual.GetTrustZone())

	if !messageListsEqual(desired.GetResources(), actual.GetResources()) {
		changes = append(changes, fmt.Sprintf("resources: %d service(s) changed", len(desired.GetResources())))
	}
	// The registry returns delegations sorted by audience; compare order-free.
	if !messageListsEqual(sortedDelegations(desired.GetDelegations()), sortedDelegations(actual.GetDelegations())) {
		changes = append(changes, messageChange("delegations",
			&idpv1.Application{Delegations: desired.GetDelegations()},
			&idpv1.Application{Delegations: actual.GetDelegations()}))
	}
	if !proto.Equal(desired.GetAccess(), actual.GetAccess()) {
		changes = append(changes, messageChange("access", desired.GetAccess(), actual.GetAccess()))
	}
	if !proto.Equal(desired.GetTrustBoundary(), actual.GetTrustBoundary()) {
		changes = append(changes, messageChange("trust_boundary", desired.GetTrustBoundary(), actual.GetTrustBoundary()))
	}
	if !slicesEqual(desired.GetProviderOauthScopes(), actual.GetProviderOauthScopes()) {
		changes = append(changes, fmt.Sprintf("provider_oauth_scopes: %v -> %v", actual.GetProviderOauthScopes(), desired.GetProviderOauthScopes()))
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

func sortedDelegations(delegations []*idpv1.Delegation) []*idpv1.Delegation {
	sorted := append([]*idpv1.Delegation{}, delegations...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].GetAudience() < sorted[j].GetAudience() })
	return sorted
}

func messageListsEqual[M proto.Message](desired, actual []M) bool {
	if len(desired) != len(actual) {
		return false
	}
	for index := range desired {
		if !proto.Equal(desired[index], actual[index]) {
			return false
		}
	}
	return true
}

func registeredApplications(ctx context.Context) map[string]*idpv1.Application {
	response, err := platform.Session().RegistryClient().ListApplications(ctx, connect.NewRequest(&idpv1.ListApplicationsRequest{}))
	if err != nil {
		output.Fail("list applications: %v", err)
	}
	registered := map[string]*idpv1.Application{}
	for _, application := range response.Msg.Applications {
		registered[application.Name] = application
	}
	return registered
}

// Plan retrieves the registry's current state and diffs it against the
// manifest, so a sync's effect is visible before anything is applied.
// It returns the number of applications that would change (non-zero exit
// status when invoked as `platy app plan`).
func Plan(ctx context.Context) int {
	root := platform.RepoRoot()
	loaded := manifest.Load(root)
	providerConfig := loadProviderConfig(root)
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
				name, name, len(desired.GetResources()), len(desired.GetDelegations())))
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
