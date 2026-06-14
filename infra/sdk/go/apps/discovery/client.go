package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"jsmunro.me/platy/sdk/httpapi"
)

const DefaultCacheTTL = 5 * time.Minute

type TokenSource func(ctx context.Context) (string, error)

type DPoPAttacher func(ctx context.Context, header http.Header, method, url, accessToken string) error

type DelegationEdge struct {
	Application string   `json:"application"`
	Audience    string   `json:"audience"`
	Scopes      []string `json:"scopes"`
}

type SyncState struct {
	Applications int32 `json:"applications"`
	Delegations  int32 `json:"delegations"`
	Methods      int32 `json:"methods"`
	SyncedAt     int64 `json:"syncedAt"`
}

type Client struct {
	Endpoint   string
	Token      TokenSource
	AttachDPoP DPoPAttacher
	HTTPClient *http.Client
	Logger     *slog.Logger
	TTL        time.Duration

	mu        sync.Mutex
	apps      []*Application
	edges     []DelegationEdge
	fetchedAt time.Time
}

func NewClient(endpoint string, token TokenSource) *Client {
	return &Client{
		Endpoint:   strings.TrimRight(endpoint, "/"),
		Token:      token,
		HTTPClient: http.DefaultClient,
		TTL:        DefaultCacheTTL,
	}
}

func (c *Client) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *Client) do(ctx context.Context, path string, body any) ([]byte, error) {
	token, err := c.Token(ctx)
	if err != nil {
		return nil, err
	}
	payload, err := httpapi.WrapData(body)
	if err != nil {
		return nil, err
	}
	url := c.Endpoint + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(payload)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if c.AttachDPoP != nil {
		if err := c.AttachDPoP(ctx, request.Header, http.MethodPost, url, token); err != nil {
			return nil, err
		}
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 10<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("%s", httpapi.ErrorMessage(raw, response.StatusCode))
	}
	return httpapi.UnwrapData(raw)
}

func (c *Client) Query(ctx context.Context, query string, variables map[string]any) (json.RawMessage, error) {
	body := map[string]any{"query": query}
	if len(variables) > 0 {
		body["variables"] = variables
	}
	payload, err := c.do(ctx, "/platform/discovery/v1/graphql/queries", body)
	if err != nil {
		return nil, fmt.Errorf("discovery query: %w", err)
	}
	var response struct {
		DataJSON string `json:"dataJson"`
		Errors   []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return nil, fmt.Errorf("discovery query decode: %w", err)
	}
	if len(response.Errors) > 0 {
		messages := make([]string, 0, len(response.Errors))
		for _, queryError := range response.Errors {
			messages = append(messages, queryError.Message)
		}
		return nil, fmt.Errorf("discovery query: %s", strings.Join(messages, "; "))
	}
	if response.DataJSON == "" {
		return nil, fmt.Errorf("discovery query returned no data")
	}
	return json.RawMessage(response.DataJSON), nil
}

func (c *Client) Sync(ctx context.Context) (*SyncState, error) {
	payload, err := c.do(ctx, "/platform/discovery/v1/synchronisations", map[string]any{})
	if err != nil {
		return nil, fmt.Errorf("discovery sync: %w", err)
	}
	state := &SyncState{}
	if err := json.Unmarshal(payload, state); err != nil {
		return nil, fmt.Errorf("discovery sync decode: %w", err)
	}
	c.Invalidate()
	return state, nil
}

func (c *Client) Invalidate() {
	c.mu.Lock()
	c.apps = nil
	c.edges = nil
	c.fetchedAt = time.Time{}
	c.mu.Unlock()
}

type registryDocument struct {
	Applications []struct {
		Name        string `json:"name"`
		Audience    string `json:"audience"`
		Endpoint    string `json:"endpoint"`
		Description string `json:"description"`
		Provider    string `json:"provider"`
		TrustZone   string `json:"trustZone"`
		CreatedAt   int64  `json:"createdAt"`
		UpdatedAt   int64  `json:"updatedAt"`
		Resources   []struct {
			Name    string `json:"name"`
			Methods []struct {
				Name  string `json:"name"`
				Scope string `json:"scope"`
			} `json:"methods"`
		} `json:"resources"`
		Delegations []struct {
			Audience string   `json:"audience"`
			Scopes   []string `json:"scopes"`
		} `json:"delegations"`
	} `json:"applications"`
	DelegationGraph []DelegationEdge `json:"delegationGraph"`
}

func (c *Client) ttl() time.Duration {
	if c.TTL > 0 {
		return c.TTL
	}
	return DefaultCacheTTL
}

func (c *Client) registry(ctx context.Context) ([]*Application, []DelegationEdge, error) {
	c.mu.Lock()
	if c.apps != nil && time.Since(c.fetchedAt) < c.ttl() {
		apps, edges := c.apps, c.edges
		c.mu.Unlock()
		return apps, edges, nil
	}
	c.mu.Unlock()

	data, err := c.Query(ctx, RegistryQuery, nil)
	if err != nil {
		return nil, nil, err
	}
	document := registryDocument{}
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, nil, fmt.Errorf("decode discovery registry: %w", err)
	}
	apps := make([]*Application, 0, len(document.Applications))
	for _, entry := range document.Applications {
		app := &Application{
			Name:        entry.Name,
			Audience:    entry.Audience,
			Endpoint:    entry.Endpoint,
			Description: entry.Description,
			Provider:    entry.Provider,
			TrustZone:   entry.TrustZone,
			CreatedAt:   entry.CreatedAt,
			UpdatedAt:   entry.UpdatedAt,
		}
		for _, resource := range entry.Resources {
			converted := Resource{Name: resource.Name}
			for _, method := range resource.Methods {
				converted.Methods = append(converted.Methods, ResourceMethod{Name: method.Name, Scope: method.Scope})
			}
			app.Resources = append(app.Resources, converted)
		}
		for _, delegation := range entry.Delegations {
			app.Delegations = append(app.Delegations, Delegation{Audience: delegation.Audience, Scopes: delegation.Scopes})
		}
		apps = append(apps, app)
	}

	c.mu.Lock()
	c.apps = apps
	c.edges = document.DelegationGraph
	c.fetchedAt = time.Now()
	c.mu.Unlock()
	c.logger().Debug("discovery registry fetched", "applications", len(apps), "edges", len(document.DelegationGraph))
	return apps, document.DelegationGraph, nil
}

func (c *Client) ListApplications(ctx context.Context) ([]*Application, error) {
	apps, _, err := c.registry(ctx)
	if err != nil {
		return nil, err
	}
	return apps, nil
}

func (c *Client) Application(ctx context.Context, name string) (*Application, error) {
	apps, _, err := c.registry(ctx)
	if err != nil {
		return nil, err
	}
	for _, app := range apps {
		if app.Name == name {
			copied := *app
			return &copied, nil
		}
	}
	return nil, fmt.Errorf("application %s is not registered with the discovery service", name)
}

func (c *Client) DelegationGraph(ctx context.Context) ([]DelegationEdge, error) {
	_, edges, err := c.registry(ctx)
	if err != nil {
		return nil, err
	}
	return edges, nil
}
