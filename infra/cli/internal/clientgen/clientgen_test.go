package clientgen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	content, err := renderTemplate("service", "ragbot", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, `export const APPLICATION = "ragbot"`) {
		t.Fatal("missing application constant")
	}
	if !strings.Contains(content, `export const RPC_PREFIX = "/ragbot.v1."`) {
		t.Fatal("missing rpc prefix")
	}
	if !strings.Contains(content, "serviceClient") {
		t.Fatal("missing generic service client")
	}
}

func TestRenderWebTemplate(t *testing.T) {
	content, err := renderTemplate("web", "aigateway", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, `export const APPLICATION = "aigateway"`) {
		t.Fatal("missing application constant")
	}
	if !strings.Contains(content, "export const client") {
		t.Fatal("missing generic web client")
	}
}
