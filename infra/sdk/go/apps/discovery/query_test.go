package discovery

import "testing"

func TestRegistryQueryIncludesApplicationsAndGraph(t *testing.T) {
	query := RegistryQuery
	if !containsAll(query, "applications", "delegationGraph", "resources", "methods", "delegations") {
		t.Fatalf("registry query missing expected fields: %s", query)
	}
}

func TestPredefinedQueries(t *testing.T) {
	if !containsAll(ApplicationsListQuery, "applications", "syncState") {
		t.Fatalf("applications list query: %s", ApplicationsListQuery)
	}
	if !containsAll(ApplicationDetailQuery, "ApplicationDetail", "$name", "application(name:") {
		t.Fatalf("application detail query: %s", ApplicationDetailQuery)
	}
	if !containsAll(DelegationGraphQuery, "delegationGraph", "applications") {
		t.Fatalf("delegation graph query: %s", DelegationGraphQuery)
	}
}

func containsAll(query string, parts ...string) bool {
	for _, part := range parts {
		if !contains(query, part) {
			return false
		}
	}
	return true
}

func contains(query, part string) bool {
	return len(query) >= len(part) && (query == part || len(part) == 0 || indexOf(query, part) >= 0)
}

func indexOf(text, part string) int {
	for i := 0; i+len(part) <= len(text); i++ {
		if text[i:i+len(part)] == part {
			return i
		}
	}
	return -1
}
