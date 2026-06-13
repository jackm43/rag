package manifest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/secrets"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func ResolveSecretRefs(ctx context.Context, refs map[string]string, provider string) (map[string]string, error) {
	if len(refs) == 0 {
		return map[string]string{}, nil
	}
	if provider == "" {
		provider = sdksecrets.OnePasswordProvider
	}
	service := secrets.Service()
	resolved := map[string]string{}
	for key, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		value := ref
		if sdksecrets.ProviderForReference(ref) != "" {
			var err error
			sourceProvider := sdksecrets.OnePasswordProvider
			if provider == sdksecrets.CloudflareSecretsStoreProvider && strings.HasPrefix(ref, sdksecrets.CFSSPrefix) {
				continue
			}
			value, err = service.Resolve(ctx, ref, sourceProvider)
			if err != nil {
				return nil, fmt.Errorf("resolve %s: %w", key, err)
			}
		}
		resolved[key] = value
	}
	return resolved, nil
}

func (a *Application) ResolveSecrets(ctx context.Context) (map[string]string, error) {
	return ResolveSecretRefs(ctx, a.Secrets, a.Provider())
}

// WriteDevVars writes a .dev.vars file into dir (the worker's wrangler config
// directory, so `wrangler dev -c <dir>/wrangler.jsonc` picks it up).
func WriteDevVars(dir string, resolved map[string]string) {
	path := filepath.Join(dir, ".dev.vars")
	if len(resolved) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			output.Fail("remove %s: %v", path, err)
		}
		return
	}
	lines := []string{}
	for key, value := range resolved {
		lines = append(lines, fmt.Sprintf("%s=%q", key, value))
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		output.Fail("write %s: %v", path, err)
	}
	output.Logger.Info("wrote wrangler dev vars", "path", path, "keys", len(resolved))
}
