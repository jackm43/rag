package clientgen

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"google.golang.org/protobuf/compiler/protogen"

	"jsmunro.me/platy/cli/internal/manifest"
)

//go:embed templates/*.ts
var templates embed.FS

func Generate(gen *protogen.Plugin, app, root string) error {
	loaded := manifest.Load(root)
	entry, registered := loaded.Applications[app]

	webEnabled := registered && entry.WebClient
	serviceEnabled := registered && entry.ServiceClient

	if webEnabled || serviceEnabled {
		if !hasServices(gen) {
			return fmt.Errorf("no service declarations under infra/proto/%s", app)
		}
	}

	extra := extraExports(app, root)
	appRoot := filepath.Join(root, "infra", "applications", app)

	if webEnabled {
		content, err := renderTemplate("web", app, extra)
		if err != nil {
			return err
		}
		emitGeneratedFile(gen, "web/index.ts", content)
	} else if err := os.RemoveAll(filepath.Join(appRoot, "web")); err != nil {
		return fmt.Errorf("remove stale web client for %s: %w", app, err)
	}

	if serviceEnabled {
		content, err := renderTemplate("service", app, extra)
		if err != nil {
			return err
		}
		emitGeneratedFile(gen, "service/index.ts", content)
	} else if err := os.RemoveAll(filepath.Join(appRoot, "service")); err != nil {
		return fmt.Errorf("remove stale service client for %s: %w", app, err)
	}

	return nil
}

func hasServices(gen *protogen.Plugin) bool {
	for _, file := range gen.Files {
		if file.Generate && len(file.Services) > 0 {
			return true
		}
	}
	return false
}

func extraExports(app, root string) string {
	graphqlIndex := filepath.Join(root, "infra", "applications", app, "graphql", "index.ts")
	if _, err := os.Stat(graphqlIndex); err == nil {
		return "\nexport * from \"../graphql\";\n"
	}
	return ""
}

func renderTemplate(kind, app, extra string) (string, error) {
	data, err := templates.ReadFile("templates/" + kind + ".ts")
	if err != nil {
		return "", fmt.Errorf("read %s template: %w", kind, err)
	}
	return strings.ReplaceAll(string(data), "{{APP}}", app) + extra, nil
}

func emitGeneratedFile(gen *protogen.Plugin, relativePath, content string) {
	generated := gen.NewGeneratedFile(relativePath, "")
	for _, line := range strings.Split(content, "\n") {
		generated.P(line)
	}
}
