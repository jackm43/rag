package display

import (
	"fmt"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/sdk/discovery"
)

func PrintApplicationMethods(app *discovery.Application, indent string) {
	for _, method := range app.Methods() {
		output.PrintLines(indent + method)
	}
}

func PrintApplicationSummary(app *discovery.Application) {
	output.PrintLines(fmt.Sprintf("%s %s", app.Name, app.Endpoint))
	PrintApplicationMethods(app, "  ")
}
