package applications

import (
	"encoding/json"
	"os"
	"path/filepath"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
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
	app *idpv1.Application,
	gatewayURL string,
	credential *sdksecrets.ClientCredential,
	providerOAuth *sdksecrets.ClientCredential,
	fullNames map[string]string,
) *discovery.Application {
	document := &discovery.Application{
		Name:                        app.GetName(),
		Audience:                    app.GetAudience(),
		Endpoint:                    app.GetEndpoint(),
		Description:                 app.GetDescription(),
		CreatedAt:                   app.GetCreatedAt(),
		UpdatedAt:                   app.GetUpdatedAt(),
		GatewayURL:                  gatewayURL,
		ImpersonationAccessClientID: app.GetImpersonationAccessClientId(),
		ProviderOAuthClientID:       app.GetProviderOauthClientId(),
		Credential:                  credential,
		ProviderOAuth:               providerOAuth,
	}
	for _, resource := range app.GetResources() {
		converted := discovery.Resource{Name: resource.GetName(), FullName: fullNames[resource.GetName()]}
		for _, method := range resource.GetMethods() {
			converted.Methods = append(converted.Methods, discovery.ResourceMethod{Name: method.GetName(), Scope: method.GetScope()})
		}
		document.Resources = append(document.Resources, converted)
	}
	for _, delegation := range app.GetDelegations() {
		document.Delegations = append(document.Delegations, discovery.Delegation{
			Audience: delegation.GetAudience(),
			Scopes:   delegation.GetScopes(),
		})
	}
	document.Provider = app.GetProvider()
	document.TrustZone = app.GetTrustZone()
	if boundary := app.GetTrustBoundary(); boundary != nil {
		document.TrustBoundary = discovery.TrustBoundary{
			Provider:   boundary.GetProvider(),
			AccountID:  boundary.GetAccountId(),
			TeamID:     boundary.GetTeamId(),
			TeamName:   boundary.GetTeamName(),
			TeamDomain: boundary.GetTeamDomain(),
		}
	}
	if access := app.GetAccess(); access != nil {
		document.Access = discovery.ApplicationAccess{
			AllowedGroups:   access.GetAllowedGroups(),
			AllowedIdPs:     access.GetAllowedIdps(),
			PostureRequired: access.GetPostureRequired(),
		}
	}
	return document
}

// MergeRepoMetadata carries forward the fields only the repository metadata
// document knows: the stored credentials and the protos' qualified resource
// names.
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
	existingResources := map[string]discovery.Resource{}
	for _, resource := range existing.Resources {
		existingResources[resource.Name] = resource
	}
	for index := range document.Resources {
		if resource, ok := existingResources[document.Resources[index].Name]; ok && document.Resources[index].FullName == "" {
			document.Resources[index].FullName = resource.FullName
		}
	}
}

func JSON(app *idpv1.Application) map[string]any {
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
