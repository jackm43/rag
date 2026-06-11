package cloudflare

import "strings"

func unionScopeIDs(groups ...[]string) []string {
	seen := map[string]struct{}{}
	merged := []string{}
	for _, group := range groups {
		for _, scope := range group {
			if scope == "" {
				continue
			}
			if _, ok := seen[scope]; ok {
				continue
			}
			seen[scope] = struct{}{}
			merged = append(merged, scope)
		}
	}
	return merged
}

var DeployScopeIDs = []string{
	"workers-scripts.read",
	"workers-scripts.write",
	"workers-routes.read",
	"workers-routes.write",
	"d1.read",
	"d1.write",
	"d1.metadata_read",
}

var AccessManagementScopeIDs = []string{
	"access-app.read",
	"access-app.write",
	"access-policy.read",
	"access-policy.write",
}

func PlatformScopeIDs() []string {
	return unionScopeIDs(DeployScopeIDs, AccessManagementScopeIDs)
}

func FilterAvailableScopeIDs(available map[string]string, wanted []string) []string {
	selected := []string{}
	for _, scope := range wanted {
		if id, ok := available[scope]; ok {
			selected = append(selected, id)
			continue
		}
		if id, ok := available[strings.ToLower(scope)]; ok {
			selected = append(selected, id)
		}
	}
	return selected
}
