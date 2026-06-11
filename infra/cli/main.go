package main

import (
	"context"
	"log/slog"
	"os"

	cmdapp "jsmunro.me/platy/cli/cmd/app"
	cmdauth "jsmunro.me/platy/cli/cmd/auth"
	cmdbootstrap "jsmunro.me/platy/cli/cmd/bootstrap"
	cmddeploy "jsmunro.me/platy/cli/cmd/deploy"
	cmdfetch "jsmunro.me/platy/cli/cmd/fetch"
	cmdmanage "jsmunro.me/platy/cli/cmd/manage"
	cmddev "jsmunro.me/platy/cli/cmd/dev"
	"jsmunro.me/platy/cli/internal/output"
)

func main() {
	slog.SetDefault(output.Logger)
	args := os.Args[1:]
	if len(args) == 0 {
		output.UsageExit()
	}

	ctx := context.Background()
	command, rest := args[0], args[1:]

	switch command {
	case "login":
		cmdauth.Login(ctx)
	case "logout":
		cmdauth.Logout(ctx)
	case "whoami":
		cmdauth.WhoAmI(ctx)
	case "discover":
		cmdauth.Discover(ctx)
	case "metadata":
		cmdfetch.Metadata(ctx, rest)
	case "fetch":
		cmdfetch.Run(ctx, rest)
	case "app":
		cmdapp.Run(ctx, rest)
	case "deploy":
		cmddeploy.Run(ctx, rest)
	case "cloudflare":
		cmdauth.Cloudflare(ctx, rest)
	case "bootstrap":
		cmdbootstrap.Run(ctx, rest)
	case "manage":
		cmdmanage.Run(ctx, rest)
	case "dev":
		cmddev.Run(ctx, rest)
	default:
		output.UsageExit()
	}
}
