package client

import "strings"

func CoversScopes(granted, wanted []string) bool {
	if len(wanted) == 0 {
		return true
	}
	if len(granted) == 0 {
		return false
	}
	seen := map[string]struct{}{}
	for _, scope := range granted {
		seen[strings.ToLower(scope)] = struct{}{}
	}
	for _, scope := range wanted {
		if _, ok := seen[strings.ToLower(scope)]; !ok {
			return false
		}
	}
	return true
}
