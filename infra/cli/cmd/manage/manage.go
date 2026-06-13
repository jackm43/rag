package manage

import (
	"fmt"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/cli/internal/provider"
)

func Command() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "manage",
		Short: "Manage the identity proxy provider configuration",
	}
	cmd.AddCommand(providerCommand())
	return cmd
}

func providerCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "provider",
		Short: "Manage the identity proxy provider configuration",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "sync",
		Short: "Upload the terraform-generated provider config to the gateway registry",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			config := provider.LoadConfig(platform.RepoRoot())
			if err := provider.SyncToGateway(cmd.Context(), config); err != nil {
				return fmt.Errorf("sync provider config: %w", err)
			}
			output.PrintJSON(config)
			return nil
		},
	})
	return cmd
}
