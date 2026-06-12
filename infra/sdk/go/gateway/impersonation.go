package gateway

import (
	"context"
	"fmt"
	"strings"

	"golang.org/x/oauth2"

	"jsmunro.me/platy/sdk/apps/discovery"
	oauthclient "jsmunro.me/platy/sdk/oauth2/client"
)

func impersonationTokenKey(gatewayURL, application string) string {
	return "impersonation|" + strings.TrimRight(gatewayURL, "/") + "|" + application
}

func teamDomainFromDiscovery(document *discovery.Document) (string, error) {
	if document.Provider.Boundary.TeamDomain != "" {
		return document.Provider.Boundary.TeamDomain, nil
	}
	issuer := strings.TrimRight(document.Oidc.Issuer, "/")
	if idx := strings.Index(issuer, "/cdn-cgi/access/sso/oidc/"); idx > 0 {
		return issuer[:idx], nil
	}
	return "", fmt.Errorf("gateway discovery has no access team domain")
}

func impersonationOAuthConfig(document *discovery.Document, clientID string) (oauth2.Config, error) {
	teamDomain, err := teamDomainFromDiscovery(document)
	if err != nil {
		return oauth2.Config{}, err
	}
	team := strings.TrimRight(teamDomain, "/")
	base := fmt.Sprintf("%s/cdn-cgi/access/sso/oidc/%s", team, clientID)
	return oauth2.Config{
		ClientID: clientID,
		Endpoint: oauth2.Endpoint{
			AuthURL:  base + "/authorization",
			TokenURL: base + "/token",
		},
		Scopes: []string{"openid", "email", "profile"},
	}, nil
}

func (s *Session) ImpersonationToken(ctx context.Context, application string, forceLogin bool) (string, error) {
	document, err := s.Application(ctx, application)
	if err != nil {
		return "", err
	}
	if document.ImpersonationAccessClientID == "" {
		return "", fmt.Errorf("application %s has no impersonation access app; run platy app register %s", application, application)
	}
	discovered, err := s.Discovery(ctx)
	if err != nil {
		return "", err
	}
	config, err := impersonationOAuthConfig(discovered, document.ImpersonationAccessClientID)
	if err != nil {
		return "", err
	}
	flow := &oauthclient.BrowserFlow{
		Config:     config,
		Logger:     s.logger(),
		HTTPClient: s.HTTPClient,
	}
	token, err := flow.Token(ctx, s.Store, impersonationTokenKey(s.GatewayURL, application), forceLogin, nil)
	if err != nil {
		return "", fmt.Errorf("impersonation authorization for %s: %w", application, err)
	}
	return token.AccessToken, nil
}
