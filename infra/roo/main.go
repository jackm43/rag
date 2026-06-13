package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/roo/internal/commands"
	"jsmunro.me/platy/roo/internal/output"
)

// RootCommand assembles the full roo command tree. Exposed so docs generation
// (roo docs) and tests can build the same tree main() runs.
func RootCommand() *cobra.Command {
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
		commands.DocsCommand(),
	)
	return root
}

func main() {
	slog.SetDefault(output.Logger)
	if err := RootCommand().ExecuteContext(context.Background()); err != nil {
		output.Logger.Error(err.Error())
		os.Exit(1)
	}
}
