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

	"jsmunro.me/platy/sdk/gateway"
	"jsmunro.me/platy/sdk/trace"
)

const maxResponseBytes = 10 << 20

// Client is the standard outbound request client for platform applications.
// It resolves endpoints and method paths from discovery metadata, acquires
// audience-scoped tokens through the gateway session (refreshing and proving
// possession as needed), and executes the request.
type Client struct {
	Session    *gateway.Session
	HTTPClient *http.Client
}

func New(session *gateway.Session) *Client {
	return &Client{
		Session:    session,
		HTTPClient: http.DefaultClient,
	}
}

type Response struct {
	StatusCode int
	Body       []byte
}

// Decoded returns the response body as JSON when possible, otherwise as a
// trimmed string.
func (r *Response) Decoded() any {
	decoded := any(nil)
	if len(r.Body) > 0 && json.Unmarshal(r.Body, &decoded) != nil {
		decoded = strings.TrimSpace(string(r.Body))
	}
	return decoded
}

func (r *Response) OK() bool {
	return r.StatusCode == http.StatusOK
}

// Fetch performs an authenticated HTTP request against an application
// endpoint path. The caller owns the returned response body.
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
	// Identity-boundary standard: this client roots (or continues) the trace
	// and logs every outbound crossing — same contract as the worker SDK.
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

// Call invokes <application>.<service>.<method> as a Connect JSON unary
// request, resolving the method path from discovery metadata.
func (c *Client) Call(ctx context.Context, application, service, method, body string) (*Response, error) {
	app, err := c.Session.Application(ctx, application)
	if err != nil {
		return nil, err
	}
	path, err := app.MethodPath(service, method)
	if err != nil {
		return nil, err
	}
	if body == "" {
		body = "{}"
	}

	header := http.Header{}
	header.Set("Content-Type", "application/json")
	header.Set("Connect-Protocol-Version", "1")
	response, err := c.Fetch(ctx, application, http.MethodPost, path, strings.NewReader(body), header)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	return &Response{StatusCode: response.StatusCode, Body: payload}, nil
}

func (c *Client) StreamCall(
	ctx context.Context,
	application, service, method, body string,
	onMessage func([]byte) error,
) error {
	app, err := c.Session.Application(ctx, application)
	if err != nil {
		return err
	}
	path, err := app.MethodPath(service, method)
	if err != nil {
		return err
	}
	if body == "" {
		body = "{}"
	}
	requestBody := envelopConnectJSON([]byte(body))

	header := http.Header{}
	header.Set("Content-Type", "application/connect+json")
	header.Set("Connect-Protocol-Version", "1")
	header.Set("Connect-Content-Encoding", "identity")
	header.Set("Connect-Accept-Encoding", "identity")
	response, err := c.Fetch(ctx, application, http.MethodPost, path, bytes.NewReader(requestBody), header)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
		if readErr != nil {
			return fmt.Errorf("stream request failed with status %d", response.StatusCode)
		}
		return &ClientError{
			Target: fmt.Sprintf("%s.%s.%s", application, service, method),
			Status: response.StatusCode,
			Body:   (&Response{StatusCode: response.StatusCode, Body: payload}).Decoded(),
		}
	}
	return readConnectStream(response.Body, onMessage)
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}
