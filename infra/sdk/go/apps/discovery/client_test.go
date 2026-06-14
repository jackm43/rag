package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const testRegistry = `{
  "applications": [
    {
      "name": "ragbot",
      "audience": "ragbot",
      "endpoint": "https://ragbot.example.com",
      "description": "bot",
      "resources": [
        {"name": "ConfigService", "methods": [{"name": "ListConfig", "scope": "ragbot/ConfigService.ListConfig"}]}
      ],
      "delegations": [{"audience": "aigateway", "scopes": ["aigateway/ChatService.Complete"]}]
    }
  ],
  "delegationGraph": [
    {"application": "ragbot", "audience": "aigateway", "scopes": ["aigateway/ChatService.Complete"]}
  ]
}`

func registryServer(t *testing.T, queries *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing bearer token, got %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/platform/discovery/v1/graphql/queries":
			*queries++
			w.Header().Set("Content-Type", "application/json")
			payload, _ := json.Marshal(map[string]any{
				"data": map[string]any{"dataJson": testRegistry},
			})
			w.Write(payload)
		case "/platform/discovery/v1/synchronisations":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":{"applications":1,"delegations":1,"methods":1,"syncedAt":42}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func testClient(server *httptest.Server) *Client {
	return NewClient(server.URL, func(ctx context.Context) (string, error) {
		return "test-token", nil
	})
}

func TestListApplicationsCachesOneQuery(t *testing.T) {
	queries := 0
	server := registryServer(t, &queries)
	defer server.Close()
	client := testClient(server)

	apps, err := client.ListApplications(context.Background())
	if err != nil {
		t.Fatalf("ListApplications: %v", err)
	}
	if len(apps) != 1 || apps[0].Name != "ragbot" || apps[0].Audience != "ragbot" {
		t.Fatalf("unexpected applications: %+v", apps)
	}

	edges, err := client.DelegationGraph(context.Background())
	if err != nil {
		t.Fatalf("DelegationGraph: %v", err)
	}
	if len(edges) != 1 || edges[0].Application != "ragbot" || edges[0].Audience != "aigateway" {
		t.Fatalf("unexpected delegation graph: %+v", edges)
	}
	if _, err := client.Application(context.Background(), "ragbot"); err != nil {
		t.Fatalf("Application: %v", err)
	}
	if _, err := client.Application(context.Background(), "missing"); err == nil {
		t.Fatal("expected an error for an unregistered application")
	}
	if queries != 1 {
		t.Fatalf("expected one backing query, got %d", queries)
	}
}

func TestSyncInvalidatesCache(t *testing.T) {
	queries := 0
	server := registryServer(t, &queries)
	defer server.Close()
	client := testClient(server)

	if _, err := client.ListApplications(context.Background()); err != nil {
		t.Fatalf("ListApplications: %v", err)
	}
	state, err := client.Sync(context.Background())
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if state.Applications != 1 || state.SyncedAt != 42 {
		t.Fatalf("unexpected sync state: %+v", state)
	}
	if _, err := client.ListApplications(context.Background()); err != nil {
		t.Fatalf("ListApplications after sync: %v", err)
	}
	if queries != 2 {
		t.Fatalf("expected the cache to refetch after sync, got %d queries", queries)
	}
}
