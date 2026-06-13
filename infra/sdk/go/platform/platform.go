package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/client"
	"jsmunro.me/platy/sdk/gateway"
	"jsmunro.me/platy/sdk/oauth2/oauthclient"
	"jsmunro.me/platy/sdk/oauth2/oauthclient/dpop"
	"jsmunro.me/platy/sdk/secrets"
)

const (
	DefaultGatewayURL = "https://auth-gateway.jsmunro.me"
	ServicesVaultID   = "mqrwrig24fxs3ssywmf3pxwqgy"
)

func CurrentUser() string {
	if current, err := user.Current(); err == nil && current.Username != "" {
		return current.Username
	}
	return "default"
}

func SecretsService(logger *slog.Logger) (*secrets.Service, error) {
	file, err := secrets.DefaultFile()
	if err != nil {
		return nil, fmt.Errorf("file secret provider: %w", err)
	}
	return secrets.NewService(&secrets.OnePassword{VaultID: ServicesVaultID, Logger: logger}, file), nil
}

// RepoRoot locates the repository checkout containing the platform manifest,
// walking up from the working directory.
func RepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("getwd: %w", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "infra", "proto", "buf.yaml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not locate repository root containing infra/proto/buf.yaml")
		}
		dir = parent
	}
}

func RepoMetadataPath(root, application string) string {
	return filepath.Join(root, "infra", "applications", application, "metadata.json")
}

// CredentialDocument reads an application's repository metadata document,
// the sole store for service credentials (client id plus secret reference).
func CredentialDocument(root, application string) *discovery.Application {
	if root == "" {
		return nil
	}
	data, err := os.ReadFile(RepoMetadataPath(root, application))
	if err != nil {
		return nil
	}
	document := &discovery.Application{}
	if err := json.Unmarshal(data, document); err != nil || document.Credential == nil {
		return nil
	}
	return document
}

func manifestGatewayEndpoint(root string) string {
	data, err := os.ReadFile(filepath.Join(root, "infra", "applications", "applications.yaml"))
	if err != nil {
		return ""
	}
	loaded := struct {
		Applications map[string]struct {
			Endpoint string `yaml:"endpoint"`
		} `yaml:"applications"`
	}{}
	if yaml.Unmarshal(data, &loaded) != nil {
		return ""
	}
	return loaded.Applications["idp"].Endpoint
}

func gatewayIssuerVar(root string) string {
	data, err := os.ReadFile(filepath.Join(root, "infra", "applications", "idp", "worker", "wrangler.jsonc"))
	if err != nil {
		return ""
	}
	decoded := struct {
		Vars map[string]string `json:"vars"`
	}{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return ""
	}
	return decoded.Vars["GATEWAY_ISSUER"]
}

// GatewayURL resolves the auth gateway endpoint: PLATY_GATEWAY_URL override,
// the manifest idp endpoint, the gateway worker's issuer var, then the
// default. Pass an empty root when no repository checkout is available.
func GatewayURL(root string) string {
	if override := strings.TrimSpace(os.Getenv("PLATY_GATEWAY_URL")); override != "" {
		return override
	}
	if root != "" {
		if endpoint := manifestGatewayEndpoint(root); endpoint != "" {
			return endpoint
		}
		if issuer := gatewayIssuerVar(root); issuer != "" {
			return issuer
		}
	}
	return DefaultGatewayURL
}

// NewSession builds the standard CLI gateway session: file-backed token
// store, device-bound DPoP key, and a credential resolver reading repository
// metadata documents.
func NewSession(ctx context.Context, logger *slog.Logger) (*gateway.Session, error) {
	service, err := SecretsService(logger)
	if err != nil {
		return nil, err
	}
	username := CurrentUser()
	store := &oauthclient.SecretStore{Secrets: service, User: username, Provider: secrets.FileProvider}
	key, err := dpop.LoadOrCreate(ctx, service, username, secrets.FileProvider)
	if err != nil {
		return nil, fmt.Errorf("device key: %w", err)
	}
	root, rootErr := RepoRoot()
	if rootErr != nil {
		root = ""
	}
	session := gateway.NewSession(
		GatewayURL(root),
		store,
		gateway.WithLogger(logger),
		gateway.WithDeviceKey(key, func(ctx context.Context) (*dpop.Key, error) {
			return dpop.Rotate(ctx, service, username, secrets.FileProvider)
		}),
		gateway.WithCredentialResolver(func(ctx context.Context, application string) (*secrets.ClientCredential, error) {
			return ResolveApplicationServiceCredential(ctx, service, root, application)
		}),
	)
	return session, nil
}

func NewClient(ctx context.Context, logger *slog.Logger) (*client.Client, error) {
	session, err := NewSession(ctx, logger)
	if err != nil {
		return nil, err
	}
	return client.New(session), nil
}
