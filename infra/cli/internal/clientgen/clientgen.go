package clientgen

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"google.golang.org/protobuf/compiler/protogen"

	"jsmunro.me/platy/cli/internal/manifest"
)

func Generate(gen *protogen.Plugin, app, root string) error {
	loaded := manifest.Load(root)
	entry, registered := loaded.Applications[app]
	services := serviceBindings(gen, app)

	webEnabled := registered && entry.WebClient
	serviceEnabled := registered && entry.ServiceClient

	if webEnabled || serviceEnabled {
		if len(services) == 0 {
			return fmt.Errorf("no service declarations under infra/proto/%s", app)
		}
	}

	extra := extraExports(app, root)
	appRoot := filepath.Join(root, "infra", "applications", app)

	if webEnabled {
		emitGeneratedFile(gen, "web/index.ts", renderWeb(app, services, extra))
	} else if err := os.RemoveAll(filepath.Join(appRoot, "web")); err != nil {
		return fmt.Errorf("remove stale web client for %s: %w", app, err)
	}

	if serviceEnabled {
		emitGeneratedFile(gen, "service/index.ts", renderService(app, services, extra))
	} else if err := os.RemoveAll(filepath.Join(appRoot, "service")); err != nil {
		return fmt.Errorf("remove stale service client for %s: %w", app, err)
	}

	if targets := targetBindings(app, entry); len(targets) > 0 {
		emitGeneratedFile(gen, "targets/index.ts", renderTargets(targets))
	} else if err := os.RemoveAll(filepath.Join(appRoot, "targets")); err != nil {
		return fmt.Errorf("remove stale targets for %s: %w", app, err)
	}

	if registered && len(services) > 0 {
		emitGeneratedFile(gen, "policy.generated.md", renderPolicy(app, entry, services))
	}

	return nil
}

type serviceBinding struct {
	Name        string
	FactoryName string
	ImportPath  string
	Methods     []methodBinding
}

type methodBinding struct {
	Name  string
	Scope string
}

func serviceBindings(gen *protogen.Plugin, app string) []serviceBinding {
	var bindings []serviceBinding
	for _, file := range gen.Files {
		if !file.Generate {
			continue
		}
		importPath := "../server/" + strings.TrimSuffix(file.Desc.Path(), ".proto") + "_pb"
		for _, service := range file.Services {
			binding := serviceBinding{
				Name:        service.GoName,
				FactoryName: lowerFirst(service.GoName) + "Client",
				ImportPath:  importPath,
			}
			for _, method := range service.Methods {
				binding.Methods = append(binding.Methods, methodBinding{
					Name:  method.GoName,
					Scope: defaultScope(app, service.GoName, method.GoName),
				})
			}
			bindings = append(bindings, binding)
		}
	}
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].Name < bindings[j].Name })
	return bindings
}

func defaultScope(app, service, method string) string {
	return fmt.Sprintf("%s/%s.%s", app, service, method)
}

func lowerFirst(value string) string {
	if value == "" {
		return value
	}
	return strings.ToLower(value[:1]) + value[1:]
}

func extraExports(app, root string) string {
	graphqlIndex := filepath.Join(root, "infra", "applications", app, "graphql", "index.ts")
	if _, err := os.Stat(graphqlIndex); err == nil {
		return "\nexport * from \"../graphql\";\n"
	}
	return ""
}

// targetService is one delegated service a worker can call on a target app.
type targetService struct {
	ServiceKey  string // accessor key, e.g. "workerService"
	FactoryName string // namespaced factory, e.g. "workerServiceClient"
}

// targetBinding is a worker-to-worker call target derived from a manifest
// delegation: an audience, its env binding/endpoint, the chained scopes, and
// the services reachable on it.
type targetBinding struct {
	Audience    string
	Binding     string // env binding name (UPPER(audience), or AUTH_GATEWAY for idp)
	EndpointVar string // env endpoint var (BINDING_ENDPOINT, or AUTH_GATEWAY_URL for idp)
	Scopes      []string
	Services    []targetService
}

// targetBindings derives the worker-to-worker call targets for an application
// from its manifest delegations. Self-audience and scope-less ("all")
// delegations are skipped because the concrete services cannot be derived.
func targetBindings(app string, entry manifest.Application) []targetBinding {
	var bindings []targetBinding
	for _, delegation := range entry.Delegations {
		if delegation.Audience == app || len(delegation.Scopes) == 0 {
			continue
		}
		seen := map[string]bool{}
		var svcs []targetService
		for _, scope := range delegation.Scopes {
			service := serviceFromScope(scope)
			if service == "" || seen[service] {
				continue
			}
			seen[service] = true
			svcs = append(svcs, targetService{
				ServiceKey:  lowerFirst(service),
				FactoryName: lowerFirst(service) + "Client",
			})
		}
		if len(svcs) == 0 {
			continue
		}
		sort.Slice(svcs, func(i, j int) bool { return svcs[i].ServiceKey < svcs[j].ServiceKey })
		binding := targetBinding{Audience: delegation.Audience, Scopes: delegation.Scopes, Services: svcs}
		if delegation.Audience == "idp" {
			binding.Binding = "AUTH_GATEWAY"
			binding.EndpointVar = "AUTH_GATEWAY_URL"
		} else {
			binding.Binding = strings.ToUpper(delegation.Audience)
			binding.EndpointVar = strings.ToUpper(delegation.Audience) + "_ENDPOINT"
		}
		bindings = append(bindings, binding)
	}
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].Audience < bindings[j].Audience })
	return bindings
}

// serviceFromScope extracts the service name from a scope "audience/Service.Method".
func serviceFromScope(scope string) string {
	slash := strings.IndexByte(scope, '/')
	if slash < 0 {
		return ""
	}
	rest := scope[slash+1:]
	if dot := strings.IndexByte(rest, '.'); dot >= 0 {
		return rest[:dot]
	}
	return rest
}

func renderTargets(targets []targetBinding) string {
	var b strings.Builder
	b.WriteString("// Code generated by buf generate (protoc-gen-platy-clients). DO NOT EDIT.\n")
	b.WriteString("import { serviceConnection, type Identity, type ServiceConnectionEnv } from \"@platy/sdk\";\n")
	for _, target := range targets {
		fmt.Fprintf(&b, "import { %s } from %q;\n", target.Audience, "../../"+target.Audience+"/service")
	}
	b.WriteString("\ntype Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };\n\n")
	b.WriteString("export type TargetsEnv = ServiceConnectionEnv & {\n")
	for _, target := range targets {
		if target.Audience == "idp" {
			continue // AUTH_GATEWAY / AUTH_GATEWAY_URL already in ServiceConnectionEnv
		}
		fmt.Fprintf(&b, "  %s?: Fetcher;\n", target.Binding)
		fmt.Fprintf(&b, "  %s?: string;\n", target.EndpointVar)
	}
	b.WriteString("};\n\n")
	for _, target := range targets {
		fmt.Fprintf(&b, "const %sConnection = (env: TargetsEnv) =>\n", target.Audience)
		b.WriteString("  serviceConnection(env, {\n")
		fmt.Fprintf(&b, "    endpoint: env.%s,\n", target.EndpointVar)
		fmt.Fprintf(&b, "    binding: env.%s,\n", target.Binding)
		fmt.Fprintf(&b, "    scopes: [%s],\n", quotedList(target.Scopes))
		b.WriteString("  });\n\n")
	}
	b.WriteString("// targets returns typed worker-to-worker clients for this app's manifest\n")
	b.WriteString("// delegations. Each accessor throws when the target's endpoint or this\n")
	b.WriteString("// worker's service credential is not configured.\n")
	b.WriteString("export const targets = (env: TargetsEnv, identity: Identity) => ({\n")
	for _, target := range targets {
		fmt.Fprintf(&b, "  %s: {\n", target.Audience)
		for _, service := range target.Services {
			fmt.Fprintf(&b, "    %s: () => {\n", service.ServiceKey)
			fmt.Fprintf(&b, "      const connection = %sConnection(env);\n", target.Audience)
			b.WriteString("      if (!connection) {\n")
			fmt.Fprintf(&b, "        throw new Error(%q);\n", target.Audience+" service connection unavailable (missing endpoint or credential)")
			b.WriteString("      }\n")
			fmt.Fprintf(&b, "      return %s.%s(connection, identity);\n", target.Audience, service.FactoryName)
			b.WriteString("    },\n")
		}
		b.WriteString("  },\n")
	}
	b.WriteString("});\n")
	return b.String()
}

func quotedList(values []string) string {
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = fmt.Sprintf("%q", value)
	}
	return strings.Join(quoted, ", ")
}

func renderService(app string, services []serviceBinding, extra string) string {
	var b strings.Builder
	b.WriteString("// Code generated by buf generate (protoc-gen-platy-clients). DO NOT EDIT.\n")
	b.WriteString("import type { Client } from \"@connectrpc/connect\";\n\n")
	for _, service := range services {
		fmt.Fprintf(&b, "import { %s } from %q;\n", service.Name, service.ImportPath)
	}
	b.WriteString("import {\n")
	b.WriteString("  connectorServiceClient,\n")
	b.WriteString("  type ConnectorConfig,\n")
	b.WriteString("  type Identity,\n")
	b.WriteString("} from \"@platy/sdk\";\n\n")
	fmt.Fprintf(&b, "export const APPLICATION = %q;\n", app)
	fmt.Fprintf(&b, "export const RPC_PREFIX = \"/%s.v1.\";\n\n", app)
	b.WriteString("export type Connection = Omit<ConnectorConfig, \"application\">;\n\n")
	fmt.Fprintf(&b, "export const %s = {\n", app)
	for _, service := range services {
		fmt.Fprintf(&b, "  %s: (connection: Connection, identity: Identity): Client<typeof %s> =>\n", service.FactoryName, service.Name)
		fmt.Fprintf(&b, "    connectorServiceClient({ ...connection, application: APPLICATION }, identity, %s),\n", service.Name)
	}
	b.WriteString("};\n")
	b.WriteString(extra)
	return b.String()
}

func renderWeb(app string, services []serviceBinding, extra string) string {
	var b strings.Builder
	b.WriteString("// Code generated by buf generate (protoc-gen-platy-clients). DO NOT EDIT.\n")
	b.WriteString("import type { Client } from \"@connectrpc/connect\";\n\n")
	for _, service := range services {
		fmt.Fprintf(&b, "import { %s } from %q;\n", service.Name, service.ImportPath)
	}
	b.WriteString("import { webClient, type BrowserAuth, type WebClientOptions } from \"@platy/web\";\n\n")
	fmt.Fprintf(&b, "export const APPLICATION = %q;\n\n", app)
	fmt.Fprintf(&b, "export const %s = {\n", app)
	for _, service := range services {
		fmt.Fprintf(&b, "  %s: (auth: BrowserAuth, options?: WebClientOptions): Client<typeof %s> =>\n", service.FactoryName, service.Name)
		fmt.Fprintf(&b, "    webClient(auth, APPLICATION, %s, options),\n", service.Name)
	}
	b.WriteString("};\n")
	b.WriteString(extra)
	return b.String()
}

func renderPolicy(app string, entry manifest.Application, services []serviceBinding) string {
	var b strings.Builder
	b.WriteString("<!-- Code generated by buf generate (protoc-gen-platy-clients). DO NOT EDIT. -->\n")
	fmt.Fprintf(&b, "# %s Policy\n\n", app)
	fmt.Fprintf(&b, "- Application: `%s`\n", app)
	fmt.Fprintf(&b, "- Description: %s\n", entry.Description)
	fmt.Fprintf(&b, "- Endpoint: `%s`\n", entry.Endpoint)
	fmt.Fprintf(&b, "- Worker: `%s`\n", entry.Worker)
	fmt.Fprintf(&b, "- Trust zone: `%s`\n", entry.ResolvedTrustZone())
	fmt.Fprintf(&b, "- Provider auth: `%s`\n", entry.ProviderAuthMode())
	fmt.Fprintf(&b, "- Impersonatable: `%t`\n", entry.AllowsImpersonation())
	fmt.Fprintf(&b, "- Service client generated: `%t`\n", entry.ServiceClient)
	fmt.Fprintf(&b, "- Web client generated: `%t`\n\n", entry.WebClient)
	b.WriteString("## Resources\n\n")
	for _, service := range services {
		fmt.Fprintf(&b, "### %s\n\n", service.Name)
		for _, method := range service.Methods {
			fmt.Fprintf(&b, "- `%s` -> `%s`\n", method.Name, method.Scope)
		}
		b.WriteString("\n")
	}
	b.WriteString("## Delegations\n\n")
	if len(entry.Delegations) == 0 {
		b.WriteString("- none\n\n")
	} else {
		for _, delegation := range entry.Delegations {
			fmt.Fprintf(&b, "- `%s`", delegation.Audience)
			if len(delegation.Scopes) == 0 {
				b.WriteString(" -> all registered scopes\n")
				continue
			}
			b.WriteString("\n")
			for _, scope := range delegation.Scopes {
				fmt.Fprintf(&b, "  - `%s`\n", scope)
			}
		}
		b.WriteString("\n")
	}
	b.WriteString("## Secrets\n\n")
	if len(entry.Secrets) == 0 {
		b.WriteString("- none\n\n")
	} else {
		keys := make([]string, 0, len(entry.Secrets))
		for key := range entry.Secrets {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			fmt.Fprintf(&b, "- `%s`\n", key)
		}
		b.WriteString("\n")
	}
	b.WriteString("## Post Deploy\n\n")
	if len(entry.PostDeploy) == 0 {
		b.WriteString("- none\n")
	} else {
		for _, hook := range entry.PostDeploy {
			fmt.Fprintf(&b, "- `%s`\n", hook)
		}
	}
	return b.String()
}

func emitGeneratedFile(gen *protogen.Plugin, relativePath, content string) {
	generated := gen.NewGeneratedFile(relativePath, "")
	for _, line := range strings.Split(content, "\n") {
		generated.P(line)
	}
}
