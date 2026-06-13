package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	cf "github.com/cloudflare/cloudflare-go/v6"
	"github.com/cloudflare/cloudflare-go/v6/option"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider/core"
	cfcloud "jsmunro.me/platy/sdk/extensions/cloudflare"
	"jsmunro.me/platy/sdk/oauth2/oauthclient"
)

type cloudflareProvider struct {
	client *cf.Client
}

func New(apiToken string) (core.OAuthClientProvisioner, error) {
	if strings.TrimSpace(apiToken) == "" {
		return nil, fmt.Errorf("cloudflare api token is required")
	}
	client := cf.NewClient(option.WithAPIToken(apiToken))
	return &cloudflareProvider{client: client}, nil
}

type apiEnvelope struct {
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

func (e *apiEnvelope) decode(target any) error {
	if !e.Success {
		messages := []string{}
		for _, apiError := range e.Errors {
			messages = append(messages, fmt.Sprintf("%d %s", apiError.Code, apiError.Message))
		}
		return fmt.Errorf("cloudflare api error: %s", strings.Join(messages, "; "))
	}
	return json.Unmarshal(e.Result, target)
}

type oauthClientInfo struct {
	ClientID     string   `json:"client_id"`
	ClientName   string   `json:"client_name"`
	ClientSecret string   `json:"client_secret"`
	Scopes       []string `json:"scopes"`
}

func applicationOAuthClientName(application string) string {
	return "platy-app-" + application
}

func oauthScopesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]struct{}{}
	for _, scope := range a {
		seen[strings.ToLower(scope)] = struct{}{}
	}
	for _, scope := range b {
		if _, ok := seen[strings.ToLower(scope)]; !ok {
			return false
		}
	}
	return true
}

func (p *cloudflareProvider) finalizeOAuthClientRotation(ctx context.Context, accountID, clientID string) error {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s/rotate_secret", accountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Delete(ctx, path, nil, envelope); err != nil {
		return fmt.Errorf("finalize oauth client rotation: %w", err)
	}
	if err := envelope.decode(&struct{}{}); err != nil {
		return err
	}
	output.Logger.Info("finalized oauth client secret rotation", "client_id", clientID)
	return nil
}

func (p *cloudflareProvider) DeleteApplicationOAuthClient(ctx context.Context, boundary core.TrustBoundary, clientID string) error {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s", boundary.AccountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Delete(ctx, path, nil, envelope); err != nil {
		return fmt.Errorf("delete oauth client: %w", err)
	}
	return envelope.decode(&struct{}{})
}

func (p *cloudflareProvider) RotateApplicationOAuthClientSecret(ctx context.Context, boundary core.TrustBoundary, clientID string) (string, error) {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s/rotate_secret", boundary.AccountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Post(ctx, path, nil, envelope); err != nil {
		if strings.Contains(err.Error(), "70721") {
			if deleteErr := p.finalizeOAuthClientRotation(ctx, boundary.AccountID, clientID); deleteErr != nil {
				return "", fmt.Errorf("clear rotated oauth client secret: %w", deleteErr)
			}
			envelope = &apiEnvelope{}
			if err := p.client.Post(ctx, path, nil, envelope); err != nil {
				return "", fmt.Errorf("rotate oauth client secret: %w", err)
			}
		} else {
			return "", fmt.Errorf("rotate oauth client secret: %w", err)
		}
	}
	result := &struct {
		ClientSecret string `json:"client_secret"`
	}{}
	if err := envelope.decode(result); err != nil {
		return "", err
	}
	if result.ClientSecret == "" {
		return "", fmt.Errorf("rotate oauth client secret returned empty secret")
	}
	output.Logger.Info("rotated application oauth client secret", "client_id", clientID)
	return result.ClientSecret, nil
}

func (p *cloudflareProvider) FinalizeApplicationOAuthClientRotation(ctx context.Context, boundary core.TrustBoundary, clientID string) error {
	return p.finalizeOAuthClientRotation(ctx, boundary.AccountID, clientID)
}

func (p *cloudflareProvider) updateOAuthClientScopes(ctx context.Context, accountID, clientID string, scopes []string) error {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s", accountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Patch(ctx, path, map[string]any{"scopes": scopes}, envelope); err != nil {
		return fmt.Errorf("update oauth client scopes: %w", err)
	}
	if err := envelope.decode(&struct{}{}); err != nil {
		return err
	}
	output.Logger.Info("updated oauth client scopes", "client_id", clientID, "scopes", strings.Join(scopes, ","))
	return nil
}

func (p *cloudflareProvider) EnsureApplicationOAuthClient(
	ctx context.Context,
	boundary core.TrustBoundary,
	application string,
	wantedScopes []string,
	callbackURL string,
) (string, string, []string, error) {
	scopes := cfcloud.WithOfflineAccess(cfcloud.FilterAvailableScopeIDs(p.availableOauthScopes(ctx), wantedScopes))
	if len(scopes) == 0 {
		return "", "", nil, fmt.Errorf("no provider oauth scopes are available for %s", application)
	}
	name := applicationOAuthClientName(application)
	path := fmt.Sprintf("accounts/%s/oauth_clients", boundary.AccountID)
	listEnvelope := &apiEnvelope{}
	if err := p.client.Get(ctx, path, nil, listEnvelope); err == nil {
		var existing []oauthClientInfo
		if err := listEnvelope.decode(&existing); err == nil {
			for _, candidate := range existing {
				if candidate.ClientName != name {
					continue
				}
				if !oauthScopesEqual(candidate.Scopes, scopes) {
					if err := p.updateOAuthClientScopes(ctx, boundary.AccountID, candidate.ClientID, scopes); err != nil {
						return "", "", nil, err
					}
				} else {
					output.Logger.Info("reusing application oauth client", "application", application, "client_id", candidate.ClientID)
				}
				return candidate.ClientID, "", scopes, nil
			}
		}
	}
	redirects := []string{
		strings.TrimRight(callbackURL, "/") + "/provider/oauth/callback",
		oauthclient.RedirectURL,
		fmt.Sprintf("http://localhost:%d/callback", oauthclient.CallbackPort),
	}
	body := map[string]any{
		"client_name":                name,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "client_secret_post",
		"redirect_uris":              redirects,
		"scopes":                     scopes,
		"visibility":                 "private",
	}
	createEnvelope := &apiEnvelope{}
	if err := p.client.Post(ctx, path, body, createEnvelope); err != nil {
		return "", "", nil, fmt.Errorf("create application oauth client: %w", err)
	}
	created := &oauthClientInfo{}
	if err := createEnvelope.decode(created); err != nil {
		return "", "", nil, fmt.Errorf("decode application oauth client response: %w", err)
	}
	if created.ClientSecret == "" {
		return "", "", nil, fmt.Errorf("cloudflare did not return a provider oauth client secret")
	}
	output.Logger.Info("created application oauth client", "application", application, "client_id", created.ClientID)
	return created.ClientID, created.ClientSecret, scopes, nil
}

func (p *cloudflareProvider) availableOauthScopes(ctx context.Context) map[string]string {
	envelope := &apiEnvelope{}
	if err := p.client.Get(ctx, "oauth/scopes", nil, envelope); err != nil {
		output.Fail("list oauth scopes: %v", err)
	}
	var scopes []struct {
		ID string `json:"id"`
	}
	if err := envelope.decode(&scopes); err != nil {
		output.Fail("decode oauth scopes: %v", err)
	}
	available := map[string]string{}
	for _, scope := range scopes {
		available[strings.ToLower(scope.ID)] = scope.ID
	}
	return available
}
