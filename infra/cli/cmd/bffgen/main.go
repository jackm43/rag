package main

import (
	"fmt"
	"os"

	"jsmunro.me/platy/cli/internal/bffgen"
	"jsmunro.me/platy/cli/internal/platform"
)

func main() {
	root := platform.RepoRoot()
	if len(os.Args) == 2 && os.Args[1] == "--all" {
		for _, app := range bffgen.ClientOnlyApps(root) {
			if err := bffgen.Generate(root, app); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		return
	}
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: bffgen <app>|--all")
		os.Exit(2)
	}
	if err := bffgen.Generate(root, os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
