package manifest

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

const RelativePath = "infra/applications/applications.yaml"

type Delegation struct {
	Audience string   `yaml:"audience"`
	Scopes   []string `yaml:"scopes"`
}

type TrustBoundary struct {
	TeamName   string `yaml:"team_name"`
	TeamDomain string `yaml:"team_domain"`
	TeamID     string `yaml:"team_id"`
	AccountID  string `yaml:"account_id"`
}

type ApplicationAccess struct {
	AllowedGroups   []string `yaml:"allowed_groups"`
	AllowedIdPs     []string `yaml:"allowed_idps"`
	PostureRequired *bool    `yaml:"posture_required"`
}

type Application struct {
	Description         string            `yaml:"description"`
	Endpoint            string            `yaml:"endpoint"`
	Worker              string            `yaml:"worker"`
	Config              string            `yaml:"config"`
	IdentityProvider    string            `yaml:"provider"`
	TrustZone           string            `yaml:"trust_zone"`
	TrustBoundary       TrustBoundary     `yaml:"trust_boundary"`
	Access              ApplicationAccess `yaml:"access"`
	SecretProvider      string            `yaml:"secret_provider"`
	SecretsDeliveryMode string            `yaml:"secrets_delivery"`
	Secrets             map[string]string `yaml:"secrets"`
	Internal            bool              `yaml:"internal"`
	// Impersonatable controls whether registration provisions a Cloudflare
	// Access application so this app can be impersonated as an actor
	// (`platy fetch <target> --as <thisapp>`). Defaults to true to preserve
	// existing behaviour; set false for target-only services that are never
	// the actor, which also lets them register without the interactive
	// Cloudflare OAuth step.
	Impersonatable *bool `yaml:"impersonatable"`
	// WebClient makes buf generate emit a typed browser client for
	// this application (infra/applications/<name>/web) that binds the
	// generated Connect services to the trust zone web auth SDK.
	WebClient bool `yaml:"web_client"`
	// BrowserAuthClient marks an application origin as a browser client that
	// completes the OIDC callback itself using the trust zone web auth SDK.
	// These origins need <endpoint>/callback registered on the Auth Gateway
	// Access application even when the app is not a client-only BFF.
	BrowserAuthClient bool `yaml:"browser_auth_client"`
	// ServiceClient makes buf generate emit a typed worker-to-worker client
	// (infra/applications/<name>/service): each factory wraps the SDK
	// connector (validate caller, chain identity, attach token) so callers
	// only configure the connection; also exports the session-proxy target.
	ServiceClient bool         `yaml:"service_client"`
	Delegations   []Delegation `yaml:"delegations"`
	PostDeploy    []string     `yaml:"post_deploy"`
	// ProviderAuth selects how this application authenticates to its external
	// provider API: "oauth" provisions a confidential provider OAuth client
	// during registration and the gateway exchanges the caller's identity for
	// short-lived delegated tokens (requires provider_api_scopes);
	// "api_token" delivers a static credential from the secrets map as a
	// worker secret. Defaults to oauth when provider_api_scopes is set.
	ProviderAuth string `yaml:"provider_auth"`
	// ProviderAPIScopes lists Cloudflare OAuth API scopes provisioned for this
	// application during registration. The gateway exchanges the operator's
	// session for provider API tokens using the confidential OAuth client.
	ProviderAPIScopes []string `yaml:"provider_api_scopes"`
}

const (
	ProviderAuthNone     = ""
	ProviderAuthOAuth    = "oauth"
	ProviderAuthAPIToken = "api_token"
)

// ProviderAuthMode resolves the provider authentication mode, defaulting to
// oauth when provider API scopes are declared. Invalid combinations fail.
func (a *Application) ProviderAuthMode() string {
	switch a.ProviderAuth {
	case ProviderAuthNone:
		if len(a.ProviderAPIScopes) > 0 {
			return ProviderAuthOAuth
		}
		return ProviderAuthNone
	case ProviderAuthOAuth:
		if len(a.ProviderAPIScopes) == 0 {
			output.Fail("provider_auth: oauth requires provider_api_scopes")
		}
		return ProviderAuthOAuth
	case ProviderAuthAPIToken:
		if len(a.ProviderAPIScopes) > 0 {
			output.Fail("provider_auth: api_token does not take provider_api_scopes")
		}
		return ProviderAuthAPIToken
	default:
		output.Fail("provider_auth must be oauth or api_token, got %q", a.ProviderAuth)
		return ProviderAuthNone
	}
}

func (a *Application) ProxyProvider() string {
	if a.IdentityProvider != "" {
		return a.IdentityProvider
	}
	return "cloudflare"
}

func (a *Application) Provider() string {
	if a.SecretProvider != "" {
		return a.SecretProvider
	}
	return sdksecrets.OnePasswordProvider
}

const (
	SecretsDeliveryWrangler     = "wrangler"
	SecretsDeliverySecretsStore = "secrets_store"
)

func (a *Application) SecretsDelivery() string {
	if a.SecretsDeliveryMode != "" {
		return a.SecretsDeliveryMode
	}
	if a.Provider() == sdksecrets.CloudflareSecretsStoreProvider {
		return SecretsDeliverySecretsStore
	}
	return SecretsDeliveryWrangler
}

func (a *Application) UsesSecretsStore() bool {
	return a.SecretsDelivery() == SecretsDeliverySecretsStore
}

func (a *Application) ResolvedTrustZone() string {
	return provider.NormalizeTrustZone(a.TrustZone)
}

// AllowsImpersonation reports whether registration should provision a
// Cloudflare Access application for impersonating this app as an actor.
func (a *Application) AllowsImpersonation() bool {
	return a.Impersonatable == nil || *a.Impersonatable
}

type Manifest struct {
	Applications map[string]Application `yaml:"applications"`
}

func Path(root string) string {
	return filepath.Join(root, filepath.FromSlash(RelativePath))
}

func Load(root string) *Manifest {
	data, err := os.ReadFile(Path(root))
	if err != nil {
		output.Fail("read %s: %v", RelativePath, err)
	}
	loaded := &Manifest{}
	if err := yaml.Unmarshal(data, loaded); err != nil {
		output.Fail("decode %s: %v", RelativePath, err)
	}
	if len(loaded.Applications) == 0 {
		output.Fail("%s declares no applications", RelativePath)
	}
	return loaded
}

func (m *Manifest) Application(name string) *Application {
	app, ok := m.Applications[name]
	if !ok {
		output.Fail("application %s is not declared in %s", name, RelativePath)
	}
	return &app
}

func HasProtoPackage(root, name string) bool {
	_, err := os.Stat(filepath.Join(root, "infra", "proto", name))
	return err == nil
}

func (m *Manifest) WebClientCallbackURIs(root string) []string {
	uris := []string{}
	seen := map[string]bool{}
	for _, app := range m.Applications {
		if app.Internal || !app.BrowserAuthClient || strings.TrimSpace(app.Endpoint) == "" {
			continue
		}
		uri := strings.TrimRight(strings.TrimSpace(app.Endpoint), "/") + "/callback"
		if seen[uri] {
			continue
		}
		seen[uri] = true
		uris = append(uris, uri)
	}
	sort.Strings(uris)
	return uris
}

func (m *Manifest) Names() []string {
	names := []string{}
	for name := range m.Applications {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i] == "idp" {
			return true
		}
		if names[j] == "idp" {
			return false
		}
		return names[i] < names[j]
	})
	return names
}

func SetWranglerVars(path string, vars map[string]string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	body := string(data)
	for key, value := range vars {
		if value == "" {
			continue
		}
		pattern := regexp.MustCompile(`("` + regexp.QuoteMeta(key) + `"\s*:\s*)"[^"]*"`)
		if !pattern.MatchString(body) {
			return fmt.Errorf("%s has no var %s to update", path, key)
		}
		body = pattern.ReplaceAllString(body, `${1}"`+value+`"`)
	}
	return os.WriteFile(path, []byte(body), 0o644)
}
