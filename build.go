//go:build ignore

package main

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type cli struct {
	module string
}

var clis = map[string]cli{
	"platy": {module: "jsmunro.me/platy/cli"},
	"roo":   {module: "jsmunro.me/platy/roo"},
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))

	root, err := repoRoot()
	if err != nil {
		fail(err)
	}

	names := os.Args[1:]
	if len(names) == 0 {
		names = sortedCLIKeys()
	}
	if err := validate(names); err != nil {
		fail(err)
	}

	for _, name := range names {
		if err := buildCLI(root, name); err != nil {
			fail(err)
		}
	}
	if err := refreshCompdump(); err != nil {
		slog.Warn("zcompdump refresh skipped", "error", err)
	}
}

func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.work not found from %s", dir)
		}
		dir = parent
	}
}

func sortedCLIKeys() []string {
	return []string{"platy", "roo"}
}

func validate(names []string) error {
	var unknown []string
	for _, name := range names {
		if _, ok := clis[name]; !ok {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		return fmt.Errorf("unknown cli(s): %s (choose from: %s)", strings.Join(unknown, ", "), strings.Join(sortedCLIKeys(), ", "))
	}
	return nil
}

func buildCLI(root, name string) error {
	spec := clis[name]
	gopath := os.Getenv("GOPATH")
	if gopath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		gopath = filepath.Join(home, "go")
	}
	targets := []string{
		filepath.Join(gopath, "bin", name),
		filepath.Join(root, name),
	}
	seen := map[string]bool{}
	unique := make([]string, 0, len(targets))
	for _, target := range targets {
		if seen[target] {
			continue
		}
		seen[target] = true
		unique = append(unique, target)
	}
	primary := unique[0]
	slog.Info("building", "cli", name, "output", primary)
	build := exec.Command("go", "build", "-o", primary, spec.module)
	build.Dir = root
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("build %s: %w", name, err)
	}
	for _, target := range unique[1:] {
		if err := copyFile(primary, target); err != nil {
			return fmt.Errorf("install %s to %s: %w", name, target, err)
		}
		slog.Info("installed", "cli", name, "output", target)
	}
	if err := installZshCompletion(primary, name); err != nil {
		return fmt.Errorf("completion %s: %w", name, err)
	}
	slog.Info("installed zsh completion", "cli", name)
	return nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func installZshCompletion(binary, name string) error {
	cmd := exec.Command(binary, "completion", "zsh")
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return fmt.Errorf("%s: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".oh-my-zsh", "completions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, "_"+name)
	return os.WriteFile(path, out, 0o644)
}

func refreshCompdump() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	matches, err := filepath.Glob(filepath.Join(home, ".zcompdump*"))
	if err != nil {
		return err
	}
	for _, path := range matches {
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	if len(matches) > 0 {
		slog.Info("refreshed zsh completion cache", "removed", len(matches))
	}
	return nil
}

func fail(err error) {
	slog.Error(err.Error())
	os.Exit(1)
}
