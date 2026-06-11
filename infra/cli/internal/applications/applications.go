package applications

import (
	"encoding/json"
	"os"
	"path/filepath"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/sdk/discovery"
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

func CredentialDocument(root, name string) *discovery.Application {
	if document, err := platform.DiscoveryService().Application(name); err == nil && document.Credential != nil {
		return document
	}
	data, err := os.ReadFile(RepoMetadataPath(root, name))
	if err != nil {
		return nil
	}
	document := &discovery.Application{}
	if err := json.Unmarshal(data, document); err != nil {
		return nil
	}
	if document.Credential == nil {
		return nil
	}
	return document
}

func Document(app *idpv1.Application, gatewayURL string, credential *sdksecrets.ClientCredential, fullNames map[string]string) *discovery.Application {
	document := &discovery.Application{
		Name:                          app.GetName(),
		Audience:                      app.GetAudience(),
		Endpoint:                      app.GetEndpoint(),
		Description:                   app.GetDescription(),
		CreatedAt:                     app.GetCreatedAt(),
		UpdatedAt:                     app.GetUpdatedAt(),
		GatewayURL:                    gatewayURL,
		ImpersonationAccessClientID:   app.GetImpersonationAccessClientId(),
		Credential:                    credential,
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

func RegisterDocument(document *discovery.Application) {
	service := platform.DiscoveryService()
	if err := service.Register(document); err != nil {
		output.Fail("register application document: %v", err)
	}
	output.Logger.Info("registered local application document", "application", document.Name, "dir", service.Dir)
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
