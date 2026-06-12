package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/roo/internal/commands"
	"jsmunro.me/platy/roo/internal/output"
)

func main() {
	slog.SetDefault(output.Logger)
	root := &cobra.Command{
		Use:           "roo",
		Short:         "Consumer CLI for authenticating with the platform and invoking registered applications",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(
		commands.LoginCommand(),
		commands.LogoutCommand(),
		commands.IntrospectCommand(),
		commands.ImpersonateCommand(),
		commands.DiscoverCommand(),
		commands.MetadataCommand(),
		commands.FetchCommand(),
	)
	if err := root.ExecuteContext(context.Background()); err != nil {
		output.Logger.Error(err.Error())
		os.Exit(1)
	}
}
