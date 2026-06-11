package fetch

import (
	"context"
	"fmt"
	"os"
	"strings"

	"jsmunro.me/platy/cli/internal/args"
	"jsmunro.me/platy/cli/internal/display"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
	"jsmunro.me/platy/sdk/client"
	"jsmunro.me/platy/sdk/gateway"
)

const usage = `usage: platy fetch <app>.<Service>.<Method> [-d <json>|@file|@-] [--stream] [--stream-json] [--as <service-app>]

The request message is sent as Connect JSON; -d defaults to {}.
Use --stream for server-streaming RPCs such as ragbot.ChatService.StreamChat.
Streaming chat prints token text to stdout; use --stream-json for one JSON object per chunk.
Run "platy fetch <app> --help" to list the callable methods of an application.`

func Run(ctx context.Context, cmdArgs []string) {
	if len(cmdArgs) == 0 || (args.HasHelpFlag(cmdArgs) && len(cmdArgs) == 1) {
		output.PrintLines(usage)
		return
	}
	as, remaining := args.ParseAsFlag(args.StripHelpFlag(cmdArgs))
	target, data, stream, streamJSON := parseArgs(remaining)
	if as != "" {
		ctx = gateway.WithImpersonate(ctx, as)
	}
	parsed, err := client.ParseTarget(target)
	if err != nil {
		output.Fail("%v", err)
	}

	c := platform.Client()
	if parsed.AppOnly() || args.HasHelpFlag(cmdArgs) {
		app, err := c.Session.Application(ctx, parsed.Application)
		if err != nil {
			output.Fail("%v", err)
		}
		display.PrintFetchAppHelp(app)
		return
	}
	if !parsed.Complete() {
		output.Fail("target must be <app>.<Service>.<Method>; run: platy fetch %s --help", parsed.Application)
	}

	body, err := client.ReadRequestBody(data, os.Stdin)
	if err != nil {
		output.Fail("%v", err)
	}
	if stream {
		err = c.StreamInvoke(ctx, target, body, func(chunk any) error {
			return printStreamChunk(chunk, streamJSON)
		})
		if err != nil {
			output.Fail("%v; run: platy fetch %s --help", err, parsed.Application)
		}
		return
	}
	decoded, err := c.Invoke(ctx, target, body)
	if err != nil {
		output.Fail("%v; run: platy fetch %s --help", err, parsed.Application)
	}
	output.PrintJSON(decoded)
}

func Metadata(ctx context.Context, cmdArgs []string) {
	if args.HasHelpFlag(cmdArgs) {
		output.PrintLines(
			"usage: platy metadata [app]",
			"",
			"Lists applications and their callable methods from local metadata,",
			"falling back to gateway discovery when nothing is registered locally.",
		)
		return
	}
	if len(cmdArgs) > 1 {
		output.UsageExit()
	}
	if len(cmdArgs) == 1 {
		app, err := platform.Session().Application(ctx, cmdArgs[0])
		if err != nil {
			output.Fail("%v", err)
		}
		output.PrintLines(
			app.Name,
			"  audience  "+app.Audience,
			"  endpoint  "+app.Endpoint,
			"  gateway   "+app.GatewayURL,
			"",
		)
		display.PrintApplicationMethods(app, "")
		output.PrintLines("", "call with: platy fetch "+app.Name+".<Service>.<Method> [-d <json>]")
		return
	}

	applications := display.LocalApplications(ctx)
	for index, app := range applications {
		if index > 0 {
			output.PrintLines("")
		}
		display.PrintApplicationSummary(app)
	}
}

func parseArgs(cmdArgs []string) (target, data string, stream, streamJSON bool) {
	data = "{}"
	positionals := []string{}
	for index := 0; index < len(cmdArgs); index++ {
		arg := cmdArgs[index]
		switch arg {
		case "-d", "--data":
			if index+1 >= len(cmdArgs) {
				output.Fail("%s requires a value", arg)
			}
			index++
			data = cmdArgs[index]
		case "--stream":
			stream = true
		case "--stream-json":
			stream = true
			streamJSON = true
		default:
			if strings.HasPrefix(arg, "-") {
				output.Fail("unknown flag %s", arg)
			}
			positionals = append(positionals, arg)
		}
	}
	if len(positionals) != 1 {
		output.PrintLines(usage)
		os.Exit(2)
	}
	return positionals[0], data, stream, streamJSON
}

func printStreamChunk(chunk any, streamJSON bool) error {
	if streamJSON {
		output.PrintJSON(chunk)
		return nil
	}

	record, ok := chunk.(map[string]any)
	if !ok {
		output.PrintJSON(chunk)
		return nil
	}

	done, _ := record["done"].(bool)
	if done {
		fmt.Fprintln(os.Stdout)
		if model, ok := record["model"].(string); ok && model != "" {
			output.Logger.Info(
				"stream complete",
				"model", model,
				"ai_duration_ms", streamField(record, "aiDurationMs", "ai_duration_ms"),
				"total_duration_ms", streamField(record, "totalDurationMs", "total_duration_ms"),
			)
		}
		return nil
	}

	delta, _ := record["delta"].(string)
	if delta != "" {
		output.PrintStreamText(delta)
		return nil
	}

	output.PrintJSON(chunk)
	return nil
}

func streamField(record map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := record[key]; ok && value != nil {
			return value
		}
	}
	return nil
}
