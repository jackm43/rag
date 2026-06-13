package discovery

import (
	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
)

func DocumentFromDiscover(response *idpv1.DiscoverResponse) *Document {
	if response == nil {
		return &Document{}
	}
	document := &Document{
		Issuer:  response.GetIssuer(),
		JwksURI: response.GetJwksUri(),
		Oidc: OidcProvider{
			Issuer:                response.GetOidc().GetIssuer(),
			ClientID:              response.GetOidc().GetClientId(),
			AuthorizationEndpoint: response.GetOidc().GetAuthorizationEndpoint(),
			TokenEndpoint:         response.GetOidc().GetTokenEndpoint(),
			JwksEndpoint:          response.GetOidc().GetJwksEndpoint(),
		},
	}
	if endpoints := response.GetEndpoints(); endpoints != nil {
		document.Endpoints = Endpoints{
			TokenExchange: endpoints.GetTokenExchange(),
			TokenRevoke:   endpoints.GetTokenRevoke(),
			Introspect:    endpoints.GetIntrospect(),
			Discovery:     endpoints.GetDiscovery(),
			Jwks:          endpoints.GetJwks(),
		}
		document.TokenExchangeEndpoint = endpoints.GetTokenExchange()
	}
	if provider := response.GetProvider(); provider != nil {
		document.Provider = providerConfigFromRPC(provider)
	}
	for _, app := range response.GetApplications() {
		document.Applications = append(document.Applications, applicationFromRPC(app))
	}
	return document
}

func applicationFromRPC(app *idpv1.Application) Application {
	if app == nil {
		return Application{}
	}
	converted := Application{
		Name:                        app.GetName(),
		Audience:                    app.GetAudience(),
		Endpoint:                    app.GetEndpoint(),
		Description:                 app.GetDescription(),
		Provider:                    app.GetProvider(),
		TrustZone:                   app.GetTrustZone(),
		CreatedAt:                   app.GetCreatedAt(),
		UpdatedAt:                   app.GetUpdatedAt(),
		ImpersonationAccessClientID: app.GetImpersonationAccessClientId(),
		ProviderOAuthClientID:       app.GetProviderOauthClientId(),
	}
	if boundary := app.GetTrustBoundary(); boundary != nil {
		converted.TrustBoundary = TrustBoundary{
			Provider:   boundary.GetProvider(),
			AccountID:  boundary.GetAccountId(),
			TeamID:     boundary.GetTeamId(),
			TeamName:   boundary.GetTeamName(),
			TeamDomain: boundary.GetTeamDomain(),
		}
	}
	if access := app.GetAccess(); access != nil {
		converted.Access = ApplicationAccess{
			AllowedGroups:   access.GetAllowedGroups(),
			AllowedIdPs:     access.GetAllowedIdps(),
			PostureRequired: access.GetPostureRequired(),
		}
	}
	for _, resource := range app.GetResources() {
		entry := Resource{Name: resource.GetName()}
		for _, method := range resource.GetMethods() {
			entry.Methods = append(entry.Methods, ResourceMethod{Name: method.GetName(), Scope: method.GetScope()})
		}
		converted.Resources = append(converted.Resources, entry)
	}
	for _, delegation := range app.GetDelegations() {
		converted.Delegations = append(converted.Delegations, Delegation{
			Audience: delegation.GetAudience(),
			Scopes:   delegation.GetScopes(),
		})
	}
	return converted
}

func providerConfigFromRPC(provider *idpv1.ProviderConfig) ProviderConfig {
	if provider == nil {
		return ProviderConfig{}
	}
	converted := ProviderConfig{
		EmailAllowlist: provider.GetEmailAllowlist(),
	}
	if boundary := provider.GetBoundary(); boundary != nil {
		converted.Boundary = TrustBoundary{
			Provider:   boundary.GetProvider(),
			AccountID:  boundary.GetAccountId(),
			TeamID:     boundary.GetTeamId(),
			TeamName:   boundary.GetTeamName(),
			TeamDomain: boundary.GetTeamDomain(),
		}
	}
	for _, idp := range provider.GetIdentityProviders() {
		converted.IdentityProviders = append(converted.IdentityProviders, IdentityProvider{
			ID:   idp.GetId(),
			Name: idp.GetName(),
			Type: idp.GetType(),
		})
	}
	for _, group := range provider.GetGroups() {
		converted.Groups = append(converted.Groups, AccessGroup{ID: group.GetId(), Name: group.GetName()})
	}
	if posture := provider.GetPosture(); posture != nil {
		converted.Posture = PosturePolicy{
			Enabled: posture.GetEnabled(),
			RuleID:  posture.GetRuleId(),
		}
		for _, check := range posture.GetChecks() {
			converted.Posture.Checks = append(converted.Posture.Checks, PostureCheck{Type: check.GetType()})
		}
	}
	if organization := provider.GetOrganization(); organization != nil {
		converted.Organization = OrganizationPolicy{
			Organization: OrganizationSpec{
				Name:     organization.GetOrganization().GetName(),
				Provider: organization.GetOrganization().GetProvider(),
			},
		}
	}
	return converted
}
