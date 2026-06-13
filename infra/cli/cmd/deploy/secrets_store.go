package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/secrets"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func pushSecretsStoreBindings(
	ctx context.Context,
	root, name string,
	app *manifest.Application,
	env []string,
	out io.Writer,
	resolved map[string]string,
	providerOAuth map[string]string,
	clientID string,
) error {
	extra := map[string]string{}
	if clientID != "" {
		document := platform.CredentialDocument(root, name)
		if document != nil && document.Credential != nil {
			secretRef := strings.TrimSpace(document.Credential.ClientSecret)
			if secretRef != "" {
				if strings.HasPrefix(secretRef, sdksecrets.CFSSPrefix) {
					_, secretName, ok := sdksecrets.ParseCFSSReference(secretRef)
					if ok {
						extra["SERVICE_CLIENT_SECRET"] = secretRef
						_ = secretName
					}
				} else {
					resolvedCredential, err := secrets.Service().Application.ResolveServiceClientCredential(ctx, document.Credential)
					if err != nil {
						return fmt.Errorf("resolve service credential for %s: %w", name, err)
					}
					extra["SERVICE_CLIENT_SECRET"] = resolvedCredential.ClientSecret
				}
				if err := manifest.SetWranglerVars(filepath.Join(root, filepath.FromSlash(app.Config)), map[string]string{
					"SERVICE_CLIENT_ID": clientID,
				}); err != nil {
					output.Logger.Debug("service client id var not injected", "app", name, "error", err.Error())
				}
			}
		}
	}
	storeID, bindings, err := app.SyncSecretsStore(ctx, root, name, extra)
	if err != nil {
		return fmt.Errorf("sync secrets store for %s: %w", name, err)
	}
	if name == "idp" && len(providerOAuth) > 0 {
		encoded, err := json.Marshal(providerOAuth)
		if err != nil {
			return fmt.Errorf("encode provider oauth secrets for %s: %w", name, err)
		}
		factory := secrets.CloudflareSecretsStoreFactory(root)
		reference, err := factory.SyncWorkerSecret(ctx, name, "PROVIDER_OAUTH_CLIENTS", string(encoded))
		if err != nil {
			return fmt.Errorf("sync provider oauth secrets for %s: %w", name, err)
		}
		_, secretName, ok := sdksecrets.ParseCFSSReference(reference)
		if ok {
			bindings = append(bindings, manifest.SecretsStoreBinding{
				Binding:    "PROVIDER_OAUTH_CLIENTS",
				StoreID:    storeID,
				SecretName: secretName,
			})
		}
	}
	configPath := filepath.Join(root, filepath.FromSlash(app.Config))
	if err := manifest.InjectSecretsStoreBindings(configPath, storeID, bindings); err != nil {
		return fmt.Errorf("inject secrets store bindings for %s: %w", name, err)
	}
	output.Logger.Info("synced secrets store bindings", "app", name, "worker", app.Worker, "bindings", len(bindings), "store_id", storeID)
	return nil
}
