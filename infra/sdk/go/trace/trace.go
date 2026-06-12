// Package trace carries W3C trace context for the Go SDK, so CLI- and
// service-originated requests root the same traces the platform's workers
// continue and record.
package trace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

type contextKey struct{}

// Header is the W3C trace context header name.
const Header = "traceparent"

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return hex.EncodeToString(buffer)
}

// NewTraceparent mints a fresh sampled trace context: the caller becomes the
// root of the request flow.
func NewTraceparent() string {
	return fmt.Sprintf("00-%s-%s-01", randomHex(16), randomHex(8))
}

// WithTraceparent pins an explicit trace context on the context, e.g. to span
// several requests of one logical operation.
func WithTraceparent(ctx context.Context, traceparent string) context.Context {
	return context.WithValue(ctx, contextKey{}, traceparent)
}

// FromContext returns the pinned trace context, or "" when the request
// should root its own trace.
func FromContext(ctx context.Context) string {
	value, _ := ctx.Value(contextKey{}).(string)
	return value
}
