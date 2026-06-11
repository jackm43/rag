package display

import (
	"context"
	"fmt"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
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

func PrintFetchAppHelp(app *discovery.Application) {
	output.PrintLines(fmt.Sprintf("usage: platy fetch %s.<Service>.<Method> [-d <json>|@file|@-]", app.Name), "")
	for _, method := range app.Methods() {
		output.PrintLines("  platy fetch " + method)
	}
}

func LocalApplications(ctx context.Context) []*discovery.Application {
	service := platform.DiscoveryService()
	applications, err := service.List()
	if err != nil {
		output.Fail("list application documents: %v", err)
	}
	if len(applications) == 0 {
		if _, err := platform.Session().Discovery(ctx); err != nil {
			output.Fail("discover: %v", err)
		}
		if applications, err = service.List(); err != nil {
			output.Fail("list application documents: %v", err)
		}
	}
	if len(applications) == 0 {
		output.Fail("no applications registered; run platy discover")
	}
	return applications
}
