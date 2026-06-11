package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/clientmetadata"
	"jsmunro.me/platy/cli/internal/env"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/sdk/auth"
	"jsmunro.me/platy/sdk/client"
	cfcloud "jsmunro.me/platy/sdk/cloudflare"
	"jsmunro.me/platy/sdk/discovery"
	"jsmunro.me/platy/sdk/dpop"
	"jsmunro.me/platy/sdk/gateway"
	"jsmunro.me/platy/sdk/httpclient"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

const DefaultGatewayURL = "https://auth-gateway.jsmunro.workers.dev"

const DelegatedTokenHeader = "X-Delegated-Cloudflare-Token"

func CloudflareScopes() []string {
	raw := env.Or("CF_OAUTH_SCOPES", "")
	if raw == "" {
		return cfcloud.PlatformScopeIDs()
	}
	return strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' })
}

func currentUser() string {
	if current, err := user.Current(); err == nil && current.Username != "" {
		return current.Username
	}
	return "default"
}

func tokenStore() auth.TokenStore {
	return &auth.SecretStore{Secrets: secrets.Service(), User: currentUser(), Provider: sdksecrets.FileProvider}
}

func DiscoveryService() *discovery.ApplicationDiscoveryService {
	service, err := discovery.DefaultService()
	if err != nil {
		output.Fail("application discovery service: %v", err)
	}
	return service
}

func deviceKey() *dpop.Key {
	key, err := dpop.LoadOrCreate(context.Background(), secrets.Service(), currentUser(), sdksecrets.FileProvider)
	if err != nil {
		output.Fail("device key: %v", err)
	}
	return key
}

func credentialDocument(application string) *discovery.Application {
	if document, err := DiscoveryService().Application(application); err == nil && document.Credential != nil {
		return document
	}
	path := filepath.Join(RepoRoot(), "infra", "applications", application, "metadata.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	document := &discovery.Application{}
	if err := json.Unmarshal(data, document); err != nil || document.Credential == nil {
		return nil
	}
	return document
}

func resolveServiceCredential(ctx context.Context, application string) (string, string, error) {
	document := credentialDocument(application)
	if document == nil {
		return "", "", fmt.Errorf("application %s has no stored service credential", application)
	}
	resolved, err := secrets.Service().Application.ResolveServiceClientCredential(ctx, document.Credential)
	if err != nil {
		return "", "", err
	}
	return resolved.ClientID, resolved.ClientSecret, nil
}

func Session() *gateway.Session {
	secretsSvc := secrets.Service()
	user := currentUser()
	provider := sdksecrets.FileProvider
	s := gateway.NewSession(env.Or("PLATY_GATEWAY_URL", DefaultGatewayURL), tokenStore(), output.Logger)
	s.Local = DiscoveryService()
	s.RotateDeviceKey = func(ctx context.Context) (*dpop.Key, error) {
		return dpop.Rotate(ctx, secretsSvc, user, provider)
	}
	s.Dpop = deviceKey()
	s.CredentialResolver = resolveServiceCredential
	return s
}

func Client() *client.Client {
	c := client.New(Session())
	c.HTTPClient = httpclient.Default()
	c.Decorate("deploy", func(ctx context.Context, header http.Header) error {
		token, err := DelegatedCloudflare().Token(ctx, false)
		if err != nil {
			return fmt.Errorf("cloudflare delegated token: %w", err)
		}
		header.Set(DelegatedTokenHeader, token)
		return nil
	})
	return c
}

func DelegatedCloudflare() *cfcloud.DelegatedTokenSource {
	clientID := env.Or("CF_OAUTH_CLIENT_ID", "")
	if clientID == "" {
		clientID = clientmetadata.OAuthClientID(RepoRoot())
	}
	if clientID == "" {
		output.Fail("cloudflare oauth client id is not configured; run platy bootstrap first")
	}
	return &cfcloud.DelegatedTokenSource{
		ClientID: clientID,
		Scopes:   CloudflareScopes(),
		Store:    tokenStore(),
		Logger:   output.Logger,
	}
}

func RepoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		output.Fail("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "infra", "proto", "buf.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			output.Fail("could not locate repository root containing infra/proto/buf.yaml")
		}
		dir = parent
	}
}
