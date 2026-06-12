package bffgen

import (
	"strings"
	"testing"

	"jsmunro.me/platy/cli/internal/manifest"
)

func TestProxyTargetsSkipsIdp(t *testing.T) {
	app := manifest.Application{
		Delegations: []manifest.Delegation{
			{Audience: "idp", Scopes: []string{"idp/TraceService.ListTraces"}},
			{Audience: "deploy", Scopes: []string{"deploy/DeployService.ListWorkers"}},
			{Audience: "aigateway"},
		},
	}
	targets := proxyTargets(app)
	if len(targets) != 2 {
		t.Fatalf("expected 2 proxy targets, got %d", len(targets))
	}
	if targets[0].Audience != "aigateway" || targets[1].Audience != "deploy" {
		t.Fatalf("unexpected order: %+v", targets)
	}
}

func TestScopeRoute(t *testing.T) {
	route := scopeRoute("ragbot", "ragbot/ConfigService.ListConfig")
	if route != "/ragbot.v1.ConfigService/*" {
		t.Fatalf("unexpected route %q", route)
	}
}

func TestRenderWorker(t *testing.T) {
	source := renderWorker("chat", []proxyTarget{
		{Audience: "aigateway", Binding: "AIGATEWAY", Endpoint: "AIGATEWAY_ENDPOINT"},
	})
	if !strings.Contains(source, `app: "chat"`) {
		t.Fatal("missing app name")
	}
	if !strings.Contains(source, `createWebBffWorker`) {
		t.Fatal("missing factory call")
	}
}
