package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"jsmunro.me/platy/sdk/catalog"
	"jsmunro.me/platy/sdk/gateway"
	"jsmunro.me/platy/sdk/httpapi"
	"jsmunro.me/platy/sdk/httpclient"
	"jsmunro.me/platy/sdk/trace"
)

const maxResponseBytes = 10 << 20

type Client struct {
	Session    *gateway.Session
	HTTPClient *http.Client
	Catalog    *catalog.Catalog
}

func New(session *gateway.Session) *Client {
	return &Client{
		Session:    session,
		HTTPClient: httpclient.Default(),
	}
}

type Response struct {
	StatusCode int
	Body       []byte
}

func (r *Response) Decoded() any {
	decoded := any(nil)
	if len(r.Body) > 0 && json.Unmarshal(r.Body, &decoded) != nil {
		decoded = strings.TrimSpace(string(r.Body))
	}
	return decoded
}

func (r *Response) OK() bool {
	return r.StatusCode >= 200 && r.StatusCode < 300
}

func (c *Client) Fetch(ctx context.Context, application, method, path string, body io.Reader, header http.Header) (*http.Response, error) {
	app, err := c.Session.Application(ctx, application)
	if err != nil {
		return nil, err
	}
	if app.Endpoint == "" {
		return nil, fmt.Errorf("application %s has no endpoint registered", application)
	}
	audience := app.Audience
	if audience == "" {
		audience = app.Name
	}
	token, err := c.Session.AppToken(ctx, audience)
	if err != nil {
		return nil, fmt.Errorf("authentication for %s: %w", application, err)
	}

	url := strings.TrimRight(app.Endpoint, "/") + path
	request, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	for key, values := range header {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	traceparent := trace.FromContext(ctx)
	if traceparent == "" {
		traceparent = trace.NewTraceparent()
	}
	request.Header.Set(trace.Header, traceparent)
	start := time.Now()
	response, err := c.httpClient().Do(request)
	if err != nil {
		slog.Warn("rpc_client_failed", "application", application, "path", path, "error", err.Error())
		return nil, err
	}
	slog.Info("rpc_client",
		"application", application,
		"path", path,
		"status", response.StatusCode,
		"duration_ms", time.Since(start).Milliseconds(),
	)
	return response, nil
}

func (c *Client) Call(ctx context.Context, application, service, method, body string) (*Response, error) {
	if c.Catalog == nil {
		return nil, fmt.Errorf("platform catalog is unavailable")
	}
	route, err := c.Catalog.Route(application, service, method)
	if err != nil {
		return nil, err
	}
	app, err := c.Session.Application(ctx, application)
	if err != nil {
		return nil, err
	}
	if app.Endpoint == "" {
		return nil, fmt.Errorf("application %s has no endpoint registered", application)
	}
	audience := app.Audience
	if audience == "" {
		audience = app.Name
	}
	requestBody := any(nil)
	if route.HTTPMethod != http.MethodGet && route.HTTPMethod != http.MethodDelete {
		if body == "" {
			body = "{}"
		}
		if err := json.Unmarshal([]byte(body), &requestBody); err != nil {
			return nil, fmt.Errorf("request body must be JSON: %w", err)
		}
	}
	path := catalog.SubstitutePath(route.Path, pathParamsFromBody(body, route.PathParams))
	payload, status, err := c.Session.AppRequestHTTP(
		ctx,
		app.Endpoint,
		route.HTTPMethod,
		path,
		requestBody,
		route.IdentityDPoP,
		func(ctx context.Context) (string, error) {
			return c.Session.AppToken(ctx, audience)
		},
	)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		decoded, _ := httpapi.UnwrapData(payload)
		return nil, &ClientError{
			Target: fmt.Sprintf("%s.%s.%s", application, service, method),
			Status: status,
			Body:   decodeJSON(decoded),
		}
	}
	data, err := httpapi.UnwrapData(payload)
	if err != nil {
		return nil, err
	}
	return &Response{StatusCode: status, Body: data}, nil
}

func (c *Client) StreamCall(
	ctx context.Context,
	application, service, method, body string,
	onMessage func([]byte) error,
) error {
	if c.Catalog == nil {
		return fmt.Errorf("platform catalog is unavailable")
	}
	route, err := c.Catalog.Route(application, service, method)
	if err != nil {
		return err
	}
	app, err := c.Session.Application(ctx, application)
	if err != nil {
		return err
	}
	if app.Endpoint == "" {
		return fmt.Errorf("application %s has no endpoint registered", application)
	}
	audience := app.Audience
	if audience == "" {
		audience = app.Name
	}
	if body == "" {
		body = "{}"
	}
	var requestBody any
	if err := json.Unmarshal([]byte(body), &requestBody); err != nil {
		return fmt.Errorf("request body must be JSON: %w", err)
	}
	path := catalog.SubstitutePath(route.Path, pathParamsFromBody(body, route.PathParams))
	payload, status, err := c.Session.AppRequestHTTP(
		ctx,
		app.Endpoint,
		route.HTTPMethod,
		path,
		requestBody,
		route.IdentityDPoP,
		func(ctx context.Context) (string, error) {
			return c.Session.AppToken(ctx, audience)
		},
	)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return &ClientError{
			Target: fmt.Sprintf("%s.%s.%s", application, service, method),
			Status: status,
			Body:   decodeJSON(payload),
		}
	}
	return httpapi.ReadNDJSON(bytes.NewReader(payload), onMessage)
}

func pathParamsFromBody(body string, names []string) map[string]string {
	params := map[string]string{}
	if len(names) == 0 || strings.TrimSpace(body) == "" {
		return params
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return params
	}
	for _, name := range names {
		if value, ok := parsed[name]; ok {
			params[name] = fmt.Sprint(value)
		}
	}
	return params
}

func decodeJSON(raw json.RawMessage) any {
	decoded := any(nil)
	if len(raw) > 0 && json.Unmarshal(raw, &decoded) != nil {
		decoded = strings.TrimSpace(string(raw))
	}
	return decoded
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}
