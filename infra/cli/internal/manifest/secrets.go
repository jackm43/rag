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

func ResolveSecretRefs(ctx context.Context, refs map[string]string, provider string) map[string]string {
	if len(refs) == 0 {
		return map[string]string{}
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
		if strings.HasPrefix(ref, "op://") {
			var err error
			value, err = service.Resolve(ctx, ref, provider)
			if err != nil {
				output.Fail("resolve %s: %v", key, err)
			}
		}
		resolved[key] = value
	}
	return resolved
}

func (a *Application) ResolveSecrets(ctx context.Context) map[string]string {
	return ResolveSecretRefs(ctx, a.Secrets, a.Provider())
}

func WriteDevVars(root string, resolved map[string]string) {
	path := filepath.Join(root, ".dev.vars")
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
