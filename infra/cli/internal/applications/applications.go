package applications

import (
	"encoding/json"
	"os"
	"path/filepath"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/sdk/apps/discovery"
	sdksecrets "jsmunro.me/platy/sdk/secrets"
)

func RepoMetadataPath(root, app string) string {
	return filepath.Join(root, "infra", "applications", app, "metadata.json")
}

func WriteRepoMetadata(root string, document *discovery.Application) {
	path := RepoMetadataPath(root, document.Name)
	if err := output.WriteJSONFile(path, document); err != nil {
		output.Fail("write %s: %v", path, err)
	}
	output.Logger.Info("wrote application metadata", "application", document.Name, "path", path)
}

func Document(
	app *discovery.Application,
	gatewayURL string,
	credential *sdksecrets.ClientCredential,
	providerOAuth *sdksecrets.ClientCredential,
) *discovery.Application {
	if app == nil {
		return nil
	}
	document := *app
	document.GatewayURL = gatewayURL
	document.Credential = credential
	document.ProviderOAuth = providerOAuth
	return &document
}

func MergeRepoMetadata(root string, document *discovery.Application) {
	data, err := os.ReadFile(RepoMetadataPath(root, document.Name))
	if err != nil {
		return
	}
	existing := &discovery.Application{}
	if err := json.Unmarshal(data, existing); err != nil {
		return
	}
	if document.Credential == nil {
		document.Credential = existing.Credential
	}
	if document.ProviderOAuth == nil {
		document.ProviderOAuth = existing.ProviderOAuth
	}
	if document.ProviderOAuthClientID == "" {
		document.ProviderOAuthClientID = existing.ProviderOAuthClientID
	}
	if document.ImpersonationAccessClientID == "" {
		document.ImpersonationAccessClientID = existing.ImpersonationAccessClientID
	}
}

func JSON(app *discovery.Application) map[string]any {
	if app == nil {
		return nil
	}
	resources := []map[string]any{}
	for _, resource := range app.Resources {
		methods := []map[string]string{}
		for _, method := range resource.Methods {
			methods = append(methods, map[string]string{"name": method.Name, "scope": method.Scope})
		}
		resources = append(resources, map[string]any{"name": resource.Name, "methods": methods})
	}
	delegations := []map[string]any{}
	for _, delegation := range app.Delegations {
		delegations = append(delegations, map[string]any{
			"audience": delegation.Audience,
			"scopes":   delegation.Scopes,
		})
	}
	return map[string]any{
		"name":        app.Name,
		"audience":    app.Audience,
		"endpoint":    app.Endpoint,
		"description": app.Description,
		"resources":   resources,
		"delegations": delegations,
	}
}
