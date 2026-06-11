package auth

import (
	"context"

	"jsmunro.me/platy/cli/internal/args"
	"jsmunro.me/platy/cli/internal/display"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/sdk/gateway"
)

func Login(ctx context.Context) {
	s := platform.Session()
	if _, err := s.UserToken(ctx, true); err != nil {
		output.Fail("login: %v", err)
	}
	response, err := s.WhoAmI(ctx)
	if err != nil {
		output.Fail("whoami: %v", err)
	}
	output.PrintJSON(map[string]any{
		"subject":     response.Subject,
		"email":       response.Email,
		"token_kind":  response.TokenKind,
		"scopes":      response.Scopes,
		"actor_chain": response.ActorChain,
	})
}

func Logout(ctx context.Context) {
	s := platform.Session()
	if err := s.Logout(ctx); err != nil {
		output.Fail("logout: %v", err)
	}
	output.PrintJSON(map[string]any{"ok": true, "cleared": s.GatewayURL})
}

func ImpersonateAuthorize(ctx context.Context, cmdArgs []string) {
	if len(cmdArgs) != 1 {
		output.Fail("usage: platy impersonate authorize <app>")
	}
	application := cmdArgs[0]
	token, err := platform.Session().ImpersonationToken(ctx, application, true)
	if err != nil {
		output.Fail("impersonate authorize: %v", err)
	}
	output.PrintJSON(map[string]any{
		"ok":          true,
		"application": application,
		"token_prefix": token[:min(12, len(token))] + "...",
	})
}

func WhoAmI(ctx context.Context, cmdArgs []string) {
	as, _ := args.ParseAsFlag(cmdArgs)
	if as != "" {
		ctx = gateway.WithImpersonate(ctx, as)
	}
	response, err := platform.Session().WhoAmI(ctx)
	if err != nil {
		output.Fail("whoami: %v", err)
	}
	output.PrintJSON(map[string]any{
		"subject":     response.Subject,
		"email":       response.Email,
		"token_kind":  response.TokenKind,
		"scopes":      response.Scopes,
		"actor_chain": response.ActorChain,
	})
}

func Discover(ctx context.Context) {
	s := platform.Session()
	document, err := s.Discovery(ctx)
	if err != nil {
		output.Fail("discover: %v", err)
	}
	output.PrintLines(
		"issuer            "+document.Issuer,
		"jwks              "+document.JwksURI,
		"token exchange    "+document.Endpoints.TokenExchange,
		"session create    "+document.Endpoints.SessionCreate,
		"session refresh   "+document.Endpoints.SessionRefresh,
		"session revoke    "+document.Endpoints.SessionRevoke,
		"whoami            "+document.Endpoints.WhoAmI,
		"oidc issuer       "+document.Oidc.Issuer,
		"oidc authorize    "+document.Oidc.AuthorizationEndpoint,
		"oidc token        "+document.Oidc.TokenEndpoint,
		"",
	)
	applications, err := platform.DiscoveryService().List()
	if err != nil {
		output.Fail("list application documents: %v", err)
	}
	for index, app := range applications {
		if index > 0 {
			output.PrintLines("")
		}
		display.PrintApplicationSummary(app)
	}
}

func Cloudflare(ctx context.Context, args []string) {
	if len(args) != 1 {
		output.UsageExit()
	}
	switch args[0] {
	case "login":
		token, err := platform.DelegatedCloudflare().Token(ctx, true)
		if err != nil {
			output.Fail("cloudflare login: %v", err)
		}
		output.PrintJSON(map[string]any{"ok": true, "token_prefix": token[:min(12, len(token))] + "..."})
	case "logout":
		if err := platform.DelegatedCloudflare().Logout(ctx); err != nil {
			output.Fail("cloudflare logout: %v", err)
		}
		output.PrintJSON(map[string]any{"ok": true})
	default:
		output.UsageExit()
	}
}
