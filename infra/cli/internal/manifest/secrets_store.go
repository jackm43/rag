package manifest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider"
	"jsmunro.me/platy/cli/internal/secrets"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

type SecretsStoreBinding struct {
	Binding    string `json:"binding"`
	StoreID    string `json:"store_id"`
	SecretName string `json:"secret_name"`
}

func ResolveSecretSource(ctx context.Context, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", nil
	}
	if strings.HasPrefix(ref, sdksecrets.CFSSPrefix) {
		return "", nil
	}
	if strings.HasPrefix(ref, "op://") {
		return secrets.Service().Resolve(ctx, ref, sdksecrets.OnePasswordProvider)
	}
	return ref, nil
}

func (a *Application) SyncSecretsStore(ctx context.Context, root, name string, extra map[string]string) (string, []SecretsStoreBinding, error) {
	factory := secrets.CloudflareSecretsStoreFactory(root)
	storeID, err := factory.EnsureStore(ctx)
	if err != nil {
		return "", nil, err
	}
	if err := provider.SaveSecretsStoreID(root, storeID); err != nil {
		output.Logger.Warn("persist secrets store id", "error", err.Error())
	}
	bindings := []SecretsStoreBinding{}
	refs := map[string]string{}
	for key, ref := range a.Secrets {
		refs[key] = ref
	}
	for key, value := range extra {
		refs[key] = value
	}
	for envKey, ref := range refs {
		value, err := ResolveSecretSource(ctx, ref)
		if err != nil {
			return "", nil, fmt.Errorf("resolve %s: %w", envKey, err)
		}
		if value == "" && strings.HasPrefix(ref, sdksecrets.CFSSPrefix) {
			_, secretName, ok := sdksecrets.ParseCFSSReference(ref)
			if !ok {
				return "", nil, fmt.Errorf("invalid secrets store reference for %s", envKey)
			}
			bindings = append(bindings, SecretsStoreBinding{
				Binding:    envKey,
				StoreID:    storeID,
				SecretName: secretName,
			})
			continue
		}
		if value == "" {
			continue
		}
		reference, err := factory.SyncWorkerSecret(ctx, name, envKey, value)
		if err != nil {
			return "", nil, err
		}
		_, secretName, ok := sdksecrets.ParseCFSSReference(reference)
		if !ok {
			return "", nil, fmt.Errorf("invalid synced reference for %s", envKey)
		}
		bindings = append(bindings, SecretsStoreBinding{
			Binding:    envKey,
			StoreID:    storeID,
			SecretName: secretName,
		})
	}
	return storeID, bindings, nil
}

func InjectSecretsStoreBindings(configPath, storeID string, bindings []SecretsStoreBinding) error {
	if len(bindings) == 0 {
		return nil
	}
	for index := range bindings {
		bindings[index].StoreID = storeID
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(bindings, "", "  ")
	if err != nil {
		return err
	}
	block := fmt.Sprintf(`  "secrets_store_secrets": %s`, string(encoded))
	body := string(data)
	pattern := regexp.MustCompile(`(?ms)"secrets_store_secrets"\s*:\s*\[[^\]]*\]`)
	if pattern.MatchString(body) {
		body = pattern.ReplaceAllString(body, strings.TrimSpace(block))
	} else {
		closing := strings.LastIndex(body, "}")
		if closing < 0 {
			return fmt.Errorf("%s is not valid jsonc", configPath)
		}
		body = body[:closing] + ",\n" + block + "\n" + body[closing:]
	}
	return os.WriteFile(configPath, []byte(body), 0o644)
}

func SecretsStoreBindingsJSON(bindings []SecretsStoreBinding) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(bindings)
	return buffer.String()
}
