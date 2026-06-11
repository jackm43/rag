package clientmetadata

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func Path(root string) string {
	return filepath.Join(root, "infra", "applications", "client_metadata.json")
}

func OAuthClientID(root string) string {
	if id := oauthClientIDFromFile(Path(root)); id != "" {
		return id
	}
	gatewayConfig := filepath.Join(root, "infra", "gateway", "wrangler.jsonc")
	return wranglerVar(gatewayConfig, "CF_OAUTH_CLIENT_ID")
}

func oauthClientIDFromFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	decoded := struct {
		Environment struct {
			CFOAuthClientID string `json:"CF_OAUTH_CLIENT_ID"`
		} `json:"environment"`
		CloudflareOAuth struct {
			ClientID string `json:"client_id"`
		} `json:"cloudflare_oauth_client"`
	}{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return ""
	}
	if decoded.Environment.CFOAuthClientID != "" {
		return decoded.Environment.CFOAuthClientID
	}
	return decoded.CloudflareOAuth.ClientID
}

func wranglerVar(path, name string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	decoded := struct {
		Vars map[string]string `json:"vars"`
	}{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return ""
	}
	return decoded.Vars[name]
}
