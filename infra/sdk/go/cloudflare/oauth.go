package cloudflare

import (
	"context"
	"fmt"
	"log/slog"

	"golang.org/x/oauth2"

	"jsmunro.me/platy/sdk/auth"
	"jsmunro.me/platy/sdk/httpclient"
)

const APIBaseURL = "https://api.cloudflare.com/client/v4"

var Endpoint = oauth2.Endpoint{
	AuthURL:  "https://dash.cloudflare.com/oauth2/auth",
	TokenURL: "https://dash.cloudflare.com/oauth2/token",
}

type DelegatedTokenSource struct {
	ClientID string
	Scopes   []string
	Store    auth.TokenStore
	Logger   *slog.Logger
}

func (d *DelegatedTokenSource) key() string {
	return "cloudflare|" + d.ClientID
}

func (d *DelegatedTokenSource) flowForScopes(scopes []string) *auth.BrowserFlow {
	config := oauth2.Config{
		ClientID: d.ClientID,
		Endpoint: Endpoint,
	}
	if len(scopes) > 0 {
		config.Scopes = scopes
	} else if len(d.Scopes) > 0 {
		config.Scopes = d.Scopes
	} else {
		config.Scopes = PlatformScopeIDs()
	}
	return &auth.BrowserFlow{
		Config:     config,
		Logger:     d.logger(),
		HTTPClient: httpclient.Default(),
	}
}

func (d *DelegatedTokenSource) logger() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

func (d *DelegatedTokenSource) Token(ctx context.Context, forceLogin bool) (string, error) {
	return d.TokenWithScopes(ctx, nil, forceLogin)
}

func (d *DelegatedTokenSource) TokenWithScopes(ctx context.Context, scopes []string, forceLogin bool) (string, error) {
	token, err := d.flowForScopes(scopes).Token(ctx, d.Store, d.key(), forceLogin)
	if err != nil {
		return "", err
	}
	if token.AccessToken == "" {
		return "", fmt.Errorf("cloudflare oauth returned no access token")
	}
	return token.AccessToken, nil
}

func (d *DelegatedTokenSource) Logout(ctx context.Context) error {
	return d.Store.Delete(ctx, d.key())
}
