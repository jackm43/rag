package main

import (
	"flag"
	"fmt"

	"google.golang.org/protobuf/compiler/protogen"

	"jsmunro.me/platy/cli/internal/clientgen"
)

func main() {
	var flags flag.FlagSet
	app := flags.String("app", "", "application name")
	root := flags.String("root", "", "repository root")
	protogen.Options{ParamFunc: flags.Set}.Run(func(gen *protogen.Plugin) error {
		if *app == "" || *root == "" {
			return fmt.Errorf("protoc-gen-platy-clients: app and root options are required")
		}
		return clientgen.Generate(gen, *app, *root)
	})
}
