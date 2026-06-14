package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"jsmunro.me/platy/sdk/catalog"
	"jsmunro.me/platy/sdk/httpapi"
)

type IntrospectResponse struct {
	Principal struct {
		Kind  string   `json:"kind"`
		Sub   string   `json:"sub"`
		Email string   `json:"email"`
		Act   []string `json:"act"`
	} `json:"principal"`
	Scopes []string `json:"scopes"`
}

type RegisterApplicationInput struct {
	Name                        string              `json:"name"`
	Endpoint                    string              `json:"endpoint"`
	Description                 string              `json:"description"`
	Resources                   []catalog.Resource  `json:"resources"`
	Delegations                 []DelegationInput   `json:"delegations"`
	Provider                    string              `json:"provider,omitempty"`
	TrustBoundary               *TrustBoundaryInput `json:"trustBoundary,omitempty"`
	Access                      *AccessInput        `json:"access,omitempty"`
	TrustZone                   string              `json:"trustZone,omitempty"`
	ImpersonationAccessClientID string              `json:"impersonationAccessClientId,omitempty"`
	ProviderOauthClientID       string              `json:"providerOauthClientId,omitempty"`
	ProviderOauthScopes         []string            `json:"providerOauthScopes,omitempty"`
}

type DelegationInput struct {
	Audience string   `json:"audience"`
	Scopes   []string `json:"scopes"`
}

type TrustBoundaryInput struct {
	Provider   string `json:"provider,omitempty"`
	AccountID  string `json:"accountId,omitempty"`
	TeamID     string `json:"teamId,omitempty"`
	TeamName   string `json:"teamName,omitempty"`
	TeamDomain string `json:"teamDomain,omitempty"`
}

type AccessInput struct {
	AllowedGroups   []string `json:"allowedGroups,omitempty"`
	AllowedIdPs     []string `json:"allowedIdps,omitempty"`
	PostureRequired bool     `json:"postureRequired,omitempty"`
}

type ServiceCredential struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

type RegisterApplicationResult struct {
	Application json.RawMessage  `json:"application"`
	Credential  ServiceCredential `json:"credential"`
}

func (s *Session) gatewayRequest(
	ctx context.Context,
	method, path string,
	body any,
	useDPoP bool,
	bearer func(context.Context) (string, error),
) ([]byte, int, error) {
	token, err := bearer(ctx)
	if err != nil {
		return nil, 0, err
	}
	var reader io.Reader
	if body != nil {
		payload, err := httpapi.WrapData(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(payload)
	}
	url := strings.TrimRight(s.gatewayURL, "/") + path
	request, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if useDPoP {
		if err := s.attachDpopForToken(request.Header, method, url, token); err != nil {
			return nil, 0, err
		}
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 10<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return payload, response.StatusCode, nil
}

func (s *Session) userGatewayRequest(ctx context.Context, method, path string, body any, useDPoP bool) ([]byte, error) {
	if s.deviceKey != nil {
		useDPoP = true
	}
	payload, status, err := s.gatewayRequest(ctx, method, path, body, useDPoP, func(ctx context.Context) (string, error) {
		return s.UserToken(ctx, false)
	})
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("%s", httpapi.ErrorMessage(payload, status))
	}
	return httpapi.UnwrapData(payload)
}

func (s *Session) impersonatingGatewayRequest(ctx context.Context, serviceApp, method, path string, body any, useDPoP bool) ([]byte, error) {
	payload, status, err := s.gatewayRequest(ctx, method, path, body, useDPoP, func(ctx context.Context) (string, error) {
		return s.ChainedAppToken(ctx, serviceApp, "idp", nil)
	})
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("%s", httpapi.ErrorMessage(payload, status))
	}
	return httpapi.UnwrapData(payload)
}

func (s *Session) gatewayData(ctx context.Context, method, path string, body any, useDPoP bool) ([]byte, error) {
	if actor := impersonate(ctx); actor != "" {
		return s.impersonatingGatewayRequest(ctx, actor, method, path, body, useDPoP)
	}
	return s.userGatewayRequest(ctx, method, path, body, useDPoP)
}

func (s *Session) AppRequestHTTP(
	ctx context.Context,
	endpoint, method, path string,
	body any,
	useDPoP bool,
	token func(context.Context) (string, error),
) ([]byte, int, error) {
	bearer, err := token(ctx)
	if err != nil {
		return nil, 0, err
	}
	var reader io.Reader
	if body != nil {
		payload, err := httpapi.WrapData(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(payload)
	}
	url := strings.TrimRight(endpoint, "/") + path
	request, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+bearer)
	if useDPoP {
		if err := s.attachDpopForToken(request.Header, method, url, bearer); err != nil {
			return nil, 0, err
		}
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 10<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return payload, response.StatusCode, nil
}
