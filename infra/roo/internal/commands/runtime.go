package commands

import (
	"context"

	"jsmunro.me/platy/roo/internal/output"
	"jsmunro.me/platy/sdk/client"
	"jsmunro.me/platy/sdk/gateway"
	"jsmunro.me/platy/sdk/platform"
)

func session() *gateway.Session {
	s, err := platform.NewSession(context.Background(), output.Logger)
	if err != nil {
		output.Fail("gateway session: %v", err)
	}
	return s
}

func requestClient() *client.Client {
	c, err := platform.NewClient(context.Background(), output.Logger)
	if err != nil {
		output.Fail("request client: %v", err)
	}
	return c
}

func withImpersonation(ctx context.Context, as string) context.Context {
	if as == "" {
		return ctx
	}
	return gateway.WithImpersonate(ctx, as)
}
