package platform

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/env"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/sdk/auth"
	"jsmunro.me/platy/sdk/client"
	"jsmunro.me/platy/sdk/cloudflare"
	"jsmunro.me/platy/sdk/discovery"
	"jsmunro.me/platy/sdk/dpop"
	"jsmunro.me/platy/sdk/gateway"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

const DefaultGatewayURL = "https://auth-gateway.jsmunro.workers.dev"

const DelegatedTokenHeader = "X-Delegated-Cloudflare-Token"

func CloudflareScopes() []string {
	raw := env.Or("CF_OAUTH_SCOPES", "")
	if raw == "" {
		return nil
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

func Session() *gateway.Session {
	s := gateway.NewSession(env.Or("PLATY_GATEWAY_URL", DefaultGatewayURL), tokenStore(), output.Logger)
	s.Local = DiscoveryService()
	s.Dpop = deviceKey()
	return s
}

func Client() *client.Client {
	c := client.New(Session())
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

func DelegatedCloudflare() *cloudflare.DelegatedTokenSource {
	clientID := env.Or("CF_OAUTH_CLIENT_ID", "")
	if clientID == "" {
		output.Fail("CF_OAUTH_CLIENT_ID is not set; run platy bootstrap first and export the printed client id")
	}
	return &cloudflare.DelegatedTokenSource{
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
