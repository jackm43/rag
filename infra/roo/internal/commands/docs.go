package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/spf13/cobra/doc"

	"jsmunro.me/platy/roo/internal/output"
	"jsmunro.me/platy/sdk/platform"
)

// DocsCommand generates the roo CLI reference docs (markdown) into
// infra/roo/docs from the live command tree. Hidden: it is a maintenance
// command, not part of the user-facing surface.
func DocsCommand() *cobra.Command {
	return &cobra.Command{
		Use:    "docs",
		Short:  "Generate the roo CLI reference docs (markdown) into infra/roo/docs",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			root, err := platform.RepoRoot()
			if err != nil {
				return err
			}
			dir := filepath.Join(root, "infra", "roo", "docs")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return fmt.Errorf("create docs dir: %w", err)
			}
			if err := doc.GenMarkdownTree(cmd.Root(), dir); err != nil {
				return fmt.Errorf("generate cli docs: %w", err)
			}
			output.Logger.Info("generated cli reference docs", "dir", dir)
			return nil
		},
	}
}
