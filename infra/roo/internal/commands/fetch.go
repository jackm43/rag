package commands

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"jsmunro.me/platy/roo/internal/output"
	"jsmunro.me/platy/sdk/client"
	"jsmunro.me/platy/sdk/oauth2/oauthclient"
)

func FetchCommand() *cobra.Command {
	data := "{}"
	stream := false
	streamJSON := false
	as := ""
	cmd := &cobra.Command{
		Use:   "fetch <app>[.<Service>.<Method>]",
		Short: "Invoke a registered application method as Connect JSON",
		Long: `Invoke <app>.<Service>.<Method> as a Connect JSON request.

The request message is sent as Connect JSON; -d defaults to {} and accepts
inline JSON, @file, or @- for stdin. Use --stream for server-streaming RPCs;
streaming chat prints token text to stdout, --stream-json prints one JSON
object per chunk. Run "roo fetch <app>" to list the callable methods of an
application.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			runFetch(withImpersonation(cmd.Context(), as), args[0], data, stream, streamJSON)
			return nil
		},
	}
	cmd.Flags().StringVarP(&data, "data", "d", "{}", "request body: inline JSON, @file, or @- for stdin")
	cmd.Flags().BoolVar(&stream, "stream", false, "treat the method as a server-streaming RPC")
	cmd.Flags().BoolVar(&streamJSON, "stream-json", false, "stream one JSON object per chunk")
	cmd.Flags().StringVar(&as, "as", "", "invoke while impersonating a service application")
	return cmd
}

func runFetch(ctx context.Context, target, data string, stream, streamJSON bool) {
	if streamJSON {
		stream = true
	}
	parsed, err := client.ParseTarget(target)
	if err != nil {
		output.Fail("%v", err)
	}
	c := requestClient(ctx)
	if parsed.AppOnly() {
		app, err := c.Session.Application(ctx, parsed.Application)
		if err != nil {
			output.Fail("%v", err)
		}
		printFetchAppHelp(app)
		return
	}
	if !parsed.Complete() {
		output.Fail("target must be <app>.<Service>.<Method>; run: roo fetch %s", parsed.Application)
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
			output.Fail("%v; run: roo fetch %s", err, parsed.Application)
		}
		return
	}
	decoded, err := invokeWithProviderAuth(ctx, c, parsed.Application, target, body)
	if err != nil {
		output.Fail("%v; run: roo fetch %s", err, parsed.Application)
	}
	output.PrintJSON(decoded)
}

func invokeWithProviderAuth(ctx context.Context, c *client.Client, application, target, body string) (any, error) {
	decoded, err := c.Invoke(ctx, target, body)
	if err == nil {
		return decoded, nil
	}
	var provErr *client.ProviderAuthorizationError
	if !errors.As(err, &provErr) {
		return nil, err
	}
	if _, err := c.Session.UserToken(ctx, false); err != nil {
		return nil, fmt.Errorf("gateway authentication: %w", err)
	}
	output.Logger.Info("provider authorization required", "application", application, "url", provErr.AuthorizeURL)
	oauthclient.OpenBrowser(output.Logger, provErr.AuthorizeURL)
	output.Logger.Info("complete authorization in the browser; waiting for provider grant")
	const attempts = 90
	for attempt := 1; attempt <= attempts; attempt++ {
		time.Sleep(2 * time.Second)
		decoded, err := c.Invoke(ctx, target, body)
		if err == nil {
			return decoded, nil
		}
		if !errors.As(err, &provErr) {
			return nil, err
		}
		if attempt%15 == 0 {
			output.Logger.Info("still waiting for provider authorization", "attempt", attempt)
		}
	}
	return nil, fmt.Errorf("provider authorization was not completed in time; finish the browser flow and run the command again")
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
