package gateway

import (
	"context"
	"encoding/json"
	"fmt"

	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/catalog"
)

func (s *Session) fetchDiscoverHTTP(ctx context.Context) (*discovery.Document, error) {
	payload, err := s.gatewayData(ctx, "GET", "/platform/gateway/v1/discovery", nil, true)
	if err != nil {
		return nil, fmt.Errorf("gateway discover: %w", err)
	}
	document := &discovery.Document{}
	if err := json.Unmarshal(payload, document); err != nil {
		return nil, fmt.Errorf("gateway discover decode: %w", err)
	}
	if document.Endpoints.TokenExchange == "" && document.TokenExchangeEndpoint != "" {
		document.Endpoints.TokenExchange = document.TokenExchangeEndpoint
	}
	return document, nil
}

func (s *Session) Introspect(ctx context.Context) (*IntrospectResponse, error) {
	payload, err := s.gatewayData(ctx, "GET", "/platform/gateway/v1/identity/introspections", nil, true)
	if err != nil {
		return nil, err
	}
	response := &IntrospectResponse{}
	if err := json.Unmarshal(payload, response); err != nil {
		return nil, fmt.Errorf("introspect decode: %w", err)
	}
	return response, nil
}

func (s *Session) ListApplicationsHTTP(ctx context.Context) ([]discovery.Application, error) {
	payload, err := s.gatewayData(ctx, "GET", "/platform/applications/v1/applications", nil, false)
	if err != nil {
		return nil, err
	}
	var response struct {
		Applications []discovery.Application `json:"applications"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("list applications decode: %w", err)
	}
	return response.Applications, nil
}

func (s *Session) GetApplicationHTTP(ctx context.Context, name string) (*discovery.Application, error) {
	path := catalog.SubstitutePath("/platform/applications/v1/applications/{applicationId}", map[string]string{
		"applicationId": name,
	})
	payload, err := s.gatewayData(ctx, "GET", path, nil, false)
	if err != nil {
		return nil, err
	}
	var response struct {
		Application discovery.Application `json:"application"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("get application decode: %w", err)
	}
	return &response.Application, nil
}

func (s *Session) RegisterApplicationHTTP(ctx context.Context, input RegisterApplicationInput) (*RegisterApplicationResult, error) {
	payload, err := s.gatewayData(ctx, "POST", "/platform/applications/v1/applications", input, false)
	if err != nil {
		return nil, err
	}
	result := &RegisterApplicationResult{}
	if err := json.Unmarshal(payload, result); err != nil {
		return nil, fmt.Errorf("register application decode: %w", err)
	}
	return result, nil
}

func (s *Session) DeleteApplicationHTTP(ctx context.Context, name string) (bool, error) {
	path := catalog.SubstitutePath("/platform/applications/v1/applications/{applicationId}", map[string]string{
		"applicationId": name,
	})
	payload, err := s.gatewayData(ctx, "DELETE", path, nil, false)
	if err != nil {
		return false, err
	}
	var response struct {
		Deleted bool `json:"deleted"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return false, fmt.Errorf("delete application decode: %w", err)
	}
	return response.Deleted, nil
}

func (s *Session) RegisterClientHTTP(ctx context.Context, name string) (*ServiceCredential, error) {
	path := catalog.SubstitutePath("/platform/applications/v1/applications/{applicationId}/service/clients", map[string]string{
		"applicationId": name,
	})
	payload, err := s.gatewayData(ctx, "POST", path, map[string]any{}, false)
	if err != nil {
		return nil, err
	}
	var response struct {
		Credential ServiceCredential `json:"credential"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("register client decode: %w", err)
	}
	return &response.Credential, nil
}

func (s *Session) UpsertProviderConfigHTTP(ctx context.Context, configJSON string) error {
	_, err := s.gatewayData(ctx, "PUT", "/platform/gateway/v1/provider/config", map[string]string{
		"configJson": configJSON,
	}, false)
	return err
}
