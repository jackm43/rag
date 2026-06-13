package clientgen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"jsmunro.me/platy/cli/internal/manifest"
)

func TestExtraExportsGraphQLWhenPresent(t *testing.T) {
	root := t.TempDir()
	app := "discovery"
	graphqlDir := filepath.Join(root, "infra", "applications", app, "graphql")
	if err := os.MkdirAll(graphqlDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(graphqlDir, "index.ts"), []byte("export {};\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	extra := extraExports(app, root)
	if !strings.Contains(extra, `export * from "../graphql"`) {
		t.Fatalf("unexpected extra exports: %q", extra)
	}
}

func TestRenderServiceTemplate(t *testing.T) {
	content := renderService("ragbot", []serviceBinding{{
		Name:        "ConfigService",
		FactoryName: "configServiceClient",
		ImportPath:  "../server/ragbot/v1/config_service_pb",
	}}, "")
	if !strings.Contains(content, `export const APPLICATION = "ragbot"`) {
		t.Fatal("missing application constant")
	}
	if !strings.Contains(content, `export const RPC_PREFIX = "/ragbot.v1."`) {
		t.Fatal("missing rpc prefix")
	}
	if !strings.Contains(content, "configServiceClient") {
		t.Fatal("missing named service client")
	}
	if strings.Contains(content, "serviceClient = <") {
		t.Fatal("generic service client should not be generated")
	}
}

func TestRenderWebTemplate(t *testing.T) {
	content := renderWeb("aigateway", []serviceBinding{{
		Name:        "ChatService",
		FactoryName: "chatServiceClient",
		ImportPath:  "../server/aigateway/v1/chat_service_pb",
	}}, "")
	if !strings.Contains(content, `export const APPLICATION = "aigateway"`) {
		t.Fatal("missing application constant")
	}
	if !strings.Contains(content, "chatServiceClient") {
		t.Fatal("missing named web client")
	}
}

func TestRenderPolicy(t *testing.T) {
	content := renderPolicy("ragbot", manifest.Application{
		Description:   "Discord bot",
		Endpoint:      "https://ragbot.example",
		Worker:        "ragbot-worker",
		ServiceClient: true,
		Delegations: []manifest.Delegation{{
			Audience: "aigateway",
			Scopes:   []string{"aigateway/ChatService.Complete"},
		}},
		Secrets: map[string]string{"DISCORD_BOT_TOKEN": "op://redacted"},
	}, []serviceBinding{{
		Name: "ConfigService",
		Methods: []methodBinding{{
			Name:  "ListConfig",
			Scope: "ragbot/ConfigService.ListConfig",
		}},
	}})
	for _, want := range []string{
		"# ragbot Policy",
		"`ragbot/ConfigService.ListConfig`",
		"`aigateway/ChatService.Complete`",
		"`DISCORD_BOT_TOKEN`",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("policy missing %q:\n%s", want, content)
		}
	}
}
