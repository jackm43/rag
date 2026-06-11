package dev

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"jsmunro.me/platy/cli/internal/args"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
)

var defaultApps = []string{"idp", "ragbot", "deploy"}

var goPackages = []string{
	"jsmunro.me/platy/cli/...",
	"jsmunro.me/platy/sdk/...",
	"jsmunro.me/platy/applications/...",
}

func Run(ctx context.Context, cmdArgs []string) {
	if len(cmdArgs) == 0 || args.HasHelpFlag(cmdArgs) {
		printUsage()
		return
	}
	cmdArgs = args.StripHelpFlag(cmdArgs)
	switch cmdArgs[0] {
	case "generate":
		generate(cmdArgs[1:])
	case "platy":
		buildPlaty()
	case "check":
		vet()
		buildGo()
		npmRun("check")
	case "test":
		npmRun("test")
		goTest("./infra/cli/internal/provider/...")
	case "install":
		runCommand("npm", "install")
	case "migrate":
		npmRun("run", "d1:migrate:local")
		npmRun("run", "gw:d1:migrate:local")
	case "vet":
		vet()
	case "build-go":
		buildGo()
	default:
		output.Fail("unknown dev command %q", cmdArgs[0])
	}
}

func printUsage() {
	output.PrintLines(
		"usage: platy dev <command>",
		"",
		"commands:",
		"  generate [app...]     regenerate protobuf code (default: idp ragbot deploy)",
		"  platy                 build ./platy CLI binary",
		"  check                 go vet, go build, and npm run check",
		"  test                  npm test and Go provider tests",
		"  install               npm install",
		"  migrate               apply local D1 schemas for ragbot and gateway",
		"  vet                   go vet on CLI, SDK, and application clients",
		"  build-go              go build on CLI, SDK, and application clients",
	)
}

func root() string {
	return platform.RepoRoot()
}

func runCommand(name string, commandArgs ...string) {
	cmd := exec.Command(name, commandArgs...)
	cmd.Dir = root()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		output.Fail("%s: %v", name, err)
	}
}

func generate(apps []string) {
	if len(apps) == 0 {
		apps = defaultApps
	}
	script := filepath.Join(root(), "infra", "scripts", "generate.sh")
	cmd := exec.Command(script, apps...)
	cmd.Dir = root()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		output.Fail("generate: %v", err)
	}
	output.Logger.Info("generated protobuf code", "apps", apps)
}

func buildPlaty() {
	runCommand("go", "build", "-o", "platy", "jsmunro.me/platy/cli")
	output.Logger.Info("built platy binary", "path", filepath.Join(root(), "platy"))
}

func vet() {
	for _, pkg := range goPackages {
		runCommand("go", "vet", pkg)
	}
}

func buildGo() {
	for _, pkg := range goPackages {
		runCommand("go", "build", pkg)
	}
}

func npmRun(scriptArgs ...string) {
	runCommand("npm", append([]string{"run"}, scriptArgs...)...)
}

func goTest(pattern string) {
	runCommand("go", "test", pattern)
}
