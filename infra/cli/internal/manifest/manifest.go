package manifest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

const RelativePath = "infra/applications/applications.yaml"

type Delegation struct {
	Audience string   `yaml:"audience"`
	Scopes   []string `yaml:"scopes"`
}

type Webhook struct {
	Name string `yaml:"name"`
	Type string `yaml:"type"`
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
	Description      string            `yaml:"description"`
	Endpoint         string            `yaml:"endpoint"`
	Worker           string            `yaml:"worker"`
	Config           string            `yaml:"config"`
	Language         string            `yaml:"language"`
	IdentityProvider string            `yaml:"provider"`
	TrustZone        string            `yaml:"trust_zone"`
	TrustBoundary    TrustBoundary     `yaml:"trust_boundary"`
	Access           ApplicationAccess `yaml:"access"`
	SecretProvider   string            `yaml:"secret_provider"`
	Internal         bool              `yaml:"internal"`
	Delegations      []Delegation      `yaml:"delegations"`
	Webhooks         []Webhook         `yaml:"webhooks"`
	PostDeploy       []string          `yaml:"post_deploy"`
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

func (a *Application) ResolvedTrustZone() string {
	return provider.NormalizeTrustZone(a.TrustZone)
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

func ParseDotenv(path string) map[string]string {
	values := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return values
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		values[strings.TrimSpace(key)] = value
	}
	return values
}

func ResolveDotenv(ctx context.Context, root string) map[string]string {
	values := ParseDotenv(filepath.Join(root, ".env"))
	service := secrets.Service()
	for key, value := range values {
		if !strings.HasPrefix(value, "op://") {
			continue
		}
		resolved, err := service.Resolve(ctx, value, sdksecrets.OnePasswordProvider)
		if err != nil {
			output.Fail("resolve %s: %v", key, err)
		}
		values[key] = resolved
	}
	return values
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
