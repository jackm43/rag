package cloudflare

import (
	"context"
	"log/slog"

	"golang.org/x/oauth2"

	"jsmunro.me/platy/sdk/auth"
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

func (d *DelegatedTokenSource) flow() *auth.BrowserFlow {
	return &auth.BrowserFlow{
		Config: oauth2.Config{
			ClientID: d.ClientID,
			Endpoint: Endpoint,
			Scopes:   d.Scopes,
		},
		Logger: d.Logger,
	}
}

func (d *DelegatedTokenSource) key() string {
	return "cloudflare|" + d.ClientID
}

func (d *DelegatedTokenSource) Token(ctx context.Context, forceLogin bool) (string, error) {
	token, err := d.flow().Token(ctx, d.Store, d.key(), forceLogin)
	if err != nil {
		return "", err
	}
	return token.AccessToken, nil
}

func (d *DelegatedTokenSource) Logout(ctx context.Context) error {
	return d.Store.Delete(ctx, d.key())
}
