package client

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

type Target struct {
	Application string
	Service     string
	Method      string
}

func (t Target) Complete() bool {
	return t.Application != "" && t.Service != "" && t.Method != ""
}

func (t Target) AppOnly() bool {
	return t.Service == "" && t.Method == ""
}

func ParseTarget(raw string) (Target, error) {
	parts := strings.Split(raw, ".")
	switch len(parts) {
	case 1:
		if parts[0] == "" {
			return Target{}, fmt.Errorf("empty target")
		}
		return Target{Application: parts[0]}, nil
	case 3:
		return Target{Application: parts[0], Service: parts[1], Method: parts[2]}, nil
	default:
		return Target{}, fmt.Errorf("target must be <app> or <app>.<Service>.<Method>")
	}
}

func ReadRequestBody(source string, stdin io.Reader) (string, error) {
	path, ok := strings.CutPrefix(source, "@")
	if !ok {
		return source, nil
	}
	if path == "-" {
		if stdin == nil {
			stdin = os.Stdin
		}
		content, err := io.ReadAll(stdin)
		if err != nil {
			return "", fmt.Errorf("read request body from stdin: %w", err)
		}
		return string(content), nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read request body: %w", err)
	}
	return string(content), nil
}

type ClientError struct {
	Target string
	Status int
	Body   any
}

func (e *ClientError) Error() string {
	if record, ok := e.Body.(map[string]any); ok {
		if message, ok := record["message"].(string); ok && message != "" {
			return fmt.Sprintf("%s failed with status %d: %s", e.Target, e.Status, message)
		}
	}
	return fmt.Sprintf("%s failed with status %d", e.Target, e.Status)
}

// IsProviderAuthorizationError recognizes a provider-connector refusal that
// carries an authorize URL the caller must visit to store a provider grant.
func IsProviderAuthorizationError(err error) (string, bool) {
	clientErr, ok := err.(*ClientError)
	if !ok {
		return "", false
	}
	record, _ := clientErr.Body.(map[string]any)
	message, _ := record["message"].(string)
	const prefix = "provider authorization required: "
	if !strings.HasPrefix(message, prefix) {
		return "", false
	}
	return strings.TrimSpace(strings.TrimPrefix(message, prefix)), true
}

func (c *Client) Invoke(ctx context.Context, target, body string) (any, error) {
	parsed, err := ParseTarget(target)
	if err != nil {
		return nil, err
	}
	if !parsed.Complete() {
		return nil, fmt.Errorf("target must be <app>.<Service>.<Method>")
	}
	response, err := c.Call(ctx, parsed.Application, parsed.Service, parsed.Method, body)
	if err != nil {
		return nil, err
	}
	decoded := response.Decoded()
	if !response.OK() {
		return nil, &ClientError{Target: target, Status: response.StatusCode, Body: decoded}
	}
	return decoded, nil
}

func (c *Client) StreamInvoke(
	ctx context.Context,
	target, body string,
	onMessage func(any) error,
) error {
	parsed, err := ParseTarget(target)
	if err != nil {
		return err
	}
	if !parsed.Complete() {
		return fmt.Errorf("target must be <app>.<Service>.<Method>")
	}
	return c.StreamCall(ctx, parsed.Application, parsed.Service, parsed.Method, body, func(payload []byte) error {
		decoded := any(nil)
		if len(payload) > 0 && json.Unmarshal(payload, &decoded) != nil {
			decoded = strings.TrimSpace(string(payload))
		}
		return onMessage(decoded)
	})
}
