package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/spf13/cobra"

	cmdapp "jsmunro.me/platy/cli/cmd/app"
	cmddeploy "jsmunro.me/platy/cli/cmd/deploy"
	cmddev "jsmunro.me/platy/cli/cmd/dev"
	cmdmanage "jsmunro.me/platy/cli/cmd/manage"
	"jsmunro.me/platy/cli/internal/output"
)

func main() {
	slog.SetDefault(output.Logger)
	root := &cobra.Command{
		Use:           "platy",
		Short:         "Platform management CLI for the application registry and deploys",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(
		cmdmanage.Command(),
		cmdapp.Command(),
		cmddeploy.Command(),
		cmddev.Command(),
	)
	if err := root.ExecuteContext(context.Background()); err != nil {
		output.Logger.Error(err.Error())
		os.Exit(1)
	}
}
