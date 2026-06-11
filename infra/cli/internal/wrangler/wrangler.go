package wrangler

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
)

func Env(values map[string]string) []string {
	env := os.Environ()
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}

func Run(root string, env []string, stdin string, args ...string) error {
	command := exec.Command("npx", append([]string{"wrangler"}, args...)...)
	command.Dir = root
	command.Env = env
	if stdin != "" {
		command.Stdin = strings.NewReader(stdin)
	}
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	return command.Run()
}

func InjectBootstrapVars(root string, loaded *manifest.Manifest) {
	metadataPath := filepath.Join(root, "infra", "applications", "client_metadata.json")
	data, err := os.ReadFile(metadataPath)
	if err != nil {
		output.Logger.Debug("no bootstrap metadata to inject", "path", metadataPath)
		return
	}
	decoded := struct {
		WranglerVars    map[string]string `json:"wrangler_vars"`
		CloudflareOauth struct {
			ClientID string `json:"client_id"`
		} `json:"cloudflare_oauth_client"`
	}{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		output.Fail("decode %s: %v", metadataPath, err)
	}
	vars := map[string]string{}
	for key, value := range decoded.WranglerVars {
		vars[key] = value
	}
	if decoded.CloudflareOauth.ClientID != "" {
		vars["CF_OAUTH_CLIENT_ID"] = decoded.CloudflareOauth.ClientID
	}
	if len(vars) == 0 {
		return
	}
	gatewayConfig := filepath.Join(root, filepath.FromSlash(loaded.Application("idp").Config))
	if err := manifest.SetWranglerVars(gatewayConfig, vars); err != nil {
		output.Fail("inject bootstrap vars: %v", err)
	}
	output.Logger.Info("synced gateway wrangler vars from bootstrap metadata", "path", gatewayConfig)
}
