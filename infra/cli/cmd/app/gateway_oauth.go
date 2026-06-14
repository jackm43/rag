package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/secrets"
	"jsmunro.me/platy/cli/internal/wrangler"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

// ResolvedProviderOAuthClients gathers every oauth-mode application's
// provisioned provider OAuth client into the PROVIDER_OAUTH_CLIENTS payload
// the gateway consumes; secrets are resolved through the secret service.
func ResolvedProviderOAuthClients(ctx context.Context, root string) map[string]string {
	entries := map[string]map[string]string{}
	loaded := manifest.Load(root)
	for _, name := range loaded.Names() {
		credential := resolveProviderOAuthCredential(ctx, root, name, loaded.Application(name))
		if credential == nil || credential.ClientID == "" || credential.ClientSecret == "" {
			continue
		}
		secret := credential.ClientSecret
		if strings.HasPrefix(secret, "op://") {
			secret = secrets.ResolveValue(ctx, secret)
		}
		entries[name] = map[string]string{
			"client_id":     credential.ClientID,
			"client_secret": secret,
		}
	}
	if len(entries) == 0 {
		return nil
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		output.Fail("encode gateway provider oauth clients: %v", err)
	}
	return map[string]string{
		"PROVIDER_OAUTH_CLIENTS": string(encoded),
	}
}

func syncGatewayProviderOAuthVars(root string) {
	payload := ResolvedProviderOAuthClients(context.Background(), root)
	if len(payload) == 0 {
		return
	}
	manifest.WriteDevVars(filepath.Join(root, "infra", "applications", "idp", "worker"), payload)
}

// PushProviderOAuthClients delivers a precomputed PROVIDER_OAUTH_CLIENTS
// payload to the gateway worker as a bulk secret.
func PushProviderOAuthClients(root string, env []string, out io.Writer, payload map[string]string) error {
	if len(payload) == 0 {
		return nil
	}
	loaded := manifest.Load(root)
	app := loaded.Application("idp")
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	output.Logger.Info("pushing provider oauth clients to gateway", "keys", len(payload))
	return wrangler.Run(root, env, string(body), out, "secret", "bulk", "-c", app.Config)
}

func syncGatewayProviderOAuthSecretsStore(ctx context.Context, root string, payload map[string]string) error {
	encoded := payload["PROVIDER_OAUTH_CLIENTS"]
	if encoded == "" {
		return nil
	}
	loaded := manifest.Load(root)
	app := loaded.Application("idp")
	factory := secrets.CloudflareSecretsStoreFactory(root)
	reference, err := factory.SyncWorkerSecret(ctx, "idp", "PROVIDER_OAUTH_CLIENTS", encoded)
	if err != nil {
		return fmt.Errorf("sync provider oauth secrets store: %w", err)
	}
	storeID, err := factory.EnsureStore(ctx)
	if err != nil {
		return fmt.Errorf("ensure secrets store: %w", err)
	}
	_, secretName, ok := sdksecrets.ParseCFSSReference(reference)
	if !ok {
		return fmt.Errorf("invalid synced reference for PROVIDER_OAUTH_CLIENTS")
	}
	configPath := filepath.Join(root, filepath.FromSlash(app.Config))
	return manifest.InjectSecretsStoreBindings(configPath, storeID, []manifest.SecretsStoreBinding{{
		Binding:    "PROVIDER_OAUTH_CLIENTS",
		StoreID:    storeID,
		SecretName: secretName,
	}})
}

func pushGatewayProviderOAuthSecrets(ctx context.Context, root string, env []string) error {
	payload := ResolvedProviderOAuthClients(ctx, root)
	if len(payload) == 0 {
		return nil
	}
	loaded := manifest.Load(root)
	if loaded.Application("idp").UsesSecretsStore() {
		output.Logger.Info("syncing provider oauth clients to gateway secrets store", "keys", len(payload))
		return syncGatewayProviderOAuthSecretsStore(ctx, root, payload)
	}
	return PushProviderOAuthClients(root, env, nil, payload)
}

func PushGatewayProviderOAuthSecrets(ctx context.Context, root string, env []string) {
	if err := pushGatewayProviderOAuthSecrets(ctx, root, env); err != nil {
		output.Fail("push provider oauth secrets: %v", err)
	}
}
