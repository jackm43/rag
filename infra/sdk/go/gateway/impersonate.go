package gateway

import "context"

type impersonateKey struct{}

func WithImpersonate(ctx context.Context, application string) context.Context {
	return context.WithValue(ctx, impersonateKey{}, application)
}

func impersonate(ctx context.Context) string {
	value, _ := ctx.Value(impersonateKey{}).(string)
	return value
}
