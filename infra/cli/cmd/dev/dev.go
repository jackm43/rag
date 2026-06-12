package dev

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
)

// protoApps lists every application with a proto package, matching
// generate.sh's own default.
func protoApps() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root(), "infra", "proto"))
	if err != nil {
		return nil, fmt.Errorf("list proto packages: %w", err)
	}
	var apps []string
	for _, entry := range entries {
		if entry.IsDir() && entry.Name() != "platy" {
			apps = append(apps, entry.Name())
		}
	}
	return apps, nil
}

var goPackages = []string{
	"jsmunro.me/platy/cli/...",
	"jsmunro.me/platy/sdk/...",
	"jsmunro.me/platy/applications/...",
}

func Command() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "dev",
		Short: "Development workflows: codegen, builds, checks, tests, local config",
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "generate [app...]",
			Short: "Regenerate protobuf code and typed client bindings (default: all proto packages)",
			RunE: func(cmd *cobra.Command, args []string) error {
				return generate(args)
			},
		},
		&cobra.Command{
			Use:   "platy",
			Short: "Build ./platy CLI binary",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return buildPlaty()
			},
		},
		&cobra.Command{
			Use:   "check",
			Short: "go vet, go build, and npm run check",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				if err := vet(); err != nil {
					return err
				}
				if err := buildGo(); err != nil {
					return err
				}
				return npmRun("check")
			},
		},
		&cobra.Command{
			Use:   "test",
			Short: "npm test and Go provider tests",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				if err := npmRun("test"); err != nil {
					return err
				}
				return goTest("./infra/cli/internal/provider/...")
			},
		},
		&cobra.Command{
			Use:   "install",
			Short: "npm install",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return runCommand("npm", "install")
			},
		},
		&cobra.Command{
			Use:   "migrate",
			Short: "Apply local D1 schemas for ragbot and gateway",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				if err := npmRun("run", "d1:migrate:local"); err != nil {
					return err
				}
				return npmRun("run", "gw:d1:migrate:local")
			},
		},
		&cobra.Command{
			Use:   "vet",
			Short: "go vet on CLI, SDK, and application clients",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return vet()
			},
		},
		&cobra.Command{
			Use:   "build-go",
			Short: "go build on CLI, SDK, and application clients",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return buildGo()
			},
		},
		&cobra.Command{
			Use:   "vars [app]",
			Short: "Write .dev.vars from application secrets (default: ragbot)",
			Args:  cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return writeDevVars(cmd.Context(), args)
			},
		},
		&cobra.Command{
			Use:   "register-commands",
			Short: "Register Discord slash commands using ragbot secrets",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return registerCommands(cmd.Context())
			},
		},
	)
	return cmd
}

func root() string {
	return platform.RepoRoot()
}

func runCommand(name string, commandArgs ...string) error {
	cmd := exec.Command(name, commandArgs...)
	cmd.Dir = root()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func generate(apps []string) error {
	if len(apps) == 0 {
		all, err := protoApps()
		if err != nil {
			return err
		}
		apps = all
	}
	script := filepath.Join(root(), "infra", "scripts", "generate.sh")
	cmd := exec.Command(script, apps...)
	cmd.Dir = root()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("generate: %w", err)
	}
	output.Logger.Info("generated protobuf code", "apps", apps)
	return nil
}

func buildPlaty() error {
	if err := runCommand("go", "build", "-o", "platy", "jsmunro.me/platy/cli"); err != nil {
		return err
	}
	output.Logger.Info("built platy binary", "path", filepath.Join(root(), "platy"))
	return nil
}

func vet() error {
	for _, pkg := range goPackages {
		if err := runCommand("go", "vet", pkg); err != nil {
			return err
		}
	}
	return nil
}

func buildGo() error {
	for _, pkg := range goPackages {
		if err := runCommand("go", "build", pkg); err != nil {
			return err
		}
	}
	return nil
}

func npmRun(scriptArgs ...string) error {
	return runCommand("npm", append([]string{"run"}, scriptArgs...)...)
}

func goTest(pattern string) error {
	return runCommand("go", "test", pattern)
}

func writeDevVars(ctx context.Context, cmdArgs []string) error {
	appName := "ragbot"
	if len(cmdArgs) > 0 {
		appName = cmdArgs[0]
	}
	loaded := manifest.Load(root())
	app := loaded.Application(appName)
	dir := root()
	if app.Config != "" {
		dir = filepath.Dir(filepath.Join(root(), filepath.FromSlash(app.Config)))
	}
	resolved, err := app.ResolveSecrets(ctx)
	if err != nil {
		return err
	}
	manifest.WriteDevVars(dir, resolved)
	return nil
}

func registerCommands(ctx context.Context) error {
	loaded := manifest.Load(root())
	app := loaded.Application("ragbot")
	resolved, err := app.ResolveSecrets(ctx)
	if err != nil {
		return err
	}
	applicationID := resolved["DISCORD_APPLICATION_ID"]
	botToken := resolved["DISCORD_BOT_TOKEN"]
	if applicationID == "" || botToken == "" {
		return fmt.Errorf("ragbot secrets must include DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN")
	}
	cmd := exec.Command("npx", "tsx", "infra/applications/ragbot/worker/scripts/register-commands.ts")
	cmd.Dir = root()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(),
		"DISCORD_APPLICATION_ID="+applicationID,
		"DISCORD_BOT_TOKEN="+botToken,
	)
	if guildIDs := wranglerVar(app.Config, "ALLOWED_GUILD_IDS"); guildIDs != "" {
		cmd.Env = append(cmd.Env, "ALLOWED_GUILD_IDS="+guildIDs)
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("register commands: %w", err)
	}
	output.Logger.Info("registered discord slash commands")
	return nil
}

func wranglerVar(configPath, key string) string {
	if configPath == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(root(), filepath.FromSlash(configPath)))
	if err != nil {
		return ""
	}
	match := regexp.MustCompile(`"` + regexp.QuoteMeta(key) + `"\s*:\s*"([^"]*)"`).FindSubmatch(data)
	if match == nil {
		return ""
	}
	return string(match[1])
}
