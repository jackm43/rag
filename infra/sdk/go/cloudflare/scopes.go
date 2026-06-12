package cloudflare

import "strings"

// Provider OAuth scopes have a single source of truth: each application's
// provider_api_scopes in applications.yaml. These helpers only normalize a
// wanted scope list against the provider's published catalog.

const OfflineAccessScope = "offline_access"

func WithOfflineAccess(scopes []string) []string {
	for _, scope := range scopes {
		if scope == OfflineAccessScope {
			return scopes
		}
	}
	return append(scopes, OfflineAccessScope)
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
