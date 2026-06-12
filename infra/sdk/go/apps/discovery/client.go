package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"

	discoveryv1 "jsmunro.me/platy/applications/discovery/client/discovery/v1"
	"jsmunro.me/platy/applications/discovery/client/discovery/v1/discoveryv1connect"
)

const DefaultCacheTTL = 5 * time.Minute

// TokenSource supplies an STS token with the discovery audience for each
// request the client makes.
type TokenSource func(ctx context.Context) (string, error)

type DelegationEdge struct {
	Application string   `json:"application"`
	Audience    string   `json:"audience"`
	Scopes      []string `json:"scopes"`
}

type SyncState struct {
	Applications int32 `json:"applications"`
	Delegations  int32 `json:"delegations"`
	Methods      int32 `json:"methods"`
	SyncedAt     int64 `json:"synced_at"`
}

// Client reads the platform registry through the discovery application's
// GraphQL Query RPC. Results are cached in process so one CLI invocation
// performs at most one query.
type Client struct {
	Endpoint   string
	Token      TokenSource
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

type bearerInterceptor struct {
	token TokenSource
}

func (i *bearerInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		token, err := i.token(ctx)
		if err != nil {
			return nil, err
		}
		request.Header().Set("Authorization", "Bearer "+token)
		return next(ctx, request)
	}
}

func (i *bearerInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (i *bearerInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func (c *Client) rpc() discoveryv1connect.DiscoveryServiceClient {
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return discoveryv1connect.NewDiscoveryServiceClient(
		httpClient,
		c.Endpoint,
		connect.WithProtoJSON(),
		connect.WithInterceptors(&bearerInterceptor{token: c.Token}),
	)
}

// Query executes one GraphQL request and returns the raw data document.
// GraphQL-level errors come back as one Go error.
func (c *Client) Query(ctx context.Context, query string, variables map[string]any) (json.RawMessage, error) {
	request := &discoveryv1.QueryRequest{Query: query}
	if len(variables) > 0 {
		encoded, err := json.Marshal(variables)
		if err != nil {
			return nil, fmt.Errorf("encode query variables: %w", err)
		}
		request.VariablesJson = string(encoded)
	}
	response, err := c.rpc().Query(ctx, connect.NewRequest(request))
	if err != nil {
		return nil, fmt.Errorf("discovery query: %w", err)
	}
	if len(response.Msg.Errors) > 0 {
		messages := make([]string, 0, len(response.Msg.Errors))
		for _, queryError := range response.Msg.Errors {
			messages = append(messages, queryError.GetMessage())
		}
		return nil, fmt.Errorf("discovery query: %s", strings.Join(messages, "; "))
	}
	if response.Msg.DataJson == "" {
		return nil, fmt.Errorf("discovery query returned no data")
	}
	return json.RawMessage(response.Msg.DataJson), nil
}

// Sync asks the discovery application to re-ingest the gateway registry.
func (c *Client) Sync(ctx context.Context) (*SyncState, error) {
	response, err := c.rpc().Sync(ctx, connect.NewRequest(&discoveryv1.SyncRequest{}))
	if err != nil {
		return nil, fmt.Errorf("discovery sync: %w", err)
	}
	c.Invalidate()
	return &SyncState{
		Applications: response.Msg.Applications,
		Delegations:  response.Msg.Delegations,
		Methods:      response.Msg.Methods,
		SyncedAt:     response.Msg.SyncedAt,
	}, nil
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

// ListApplications returns every registered application with its audience,
// endpoint, and resources/methods (scope and qualified name).
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

// DelegationGraph returns every delegation edge in the registry.
func (c *Client) DelegationGraph(ctx context.Context) ([]DelegationEdge, error) {
	_, edges, err := c.registry(ctx)
	if err != nil {
		return nil, err
	}
	return edges, nil
}
