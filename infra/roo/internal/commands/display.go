package commands

import (
	"fmt"

	"jsmunro.me/platy/roo/internal/output"
	"jsmunro.me/platy/sdk/apps/discovery"
)

func printApplicationMethods(app *discovery.Application, indent string) {
	for _, method := range app.Methods() {
		output.PrintLines(indent + method)
	}
}

func printApplicationSummary(app *discovery.Application) {
	output.PrintLines(fmt.Sprintf("%s %s", app.Name, app.Endpoint))
	printApplicationMethods(app, "  ")
}

func printFetchAppHelp(app *discovery.Application) {
	output.PrintLines(fmt.Sprintf("usage: roo fetch %s.<Service>.<Method> [-d <json>|@file|@-]", app.Name), "")
	for _, method := range app.Methods() {
		output.PrintLines("  roo fetch " + method)
	}
}
