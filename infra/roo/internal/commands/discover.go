package commands

import (
	"github.com/spf13/cobra"

	"jsmunro.me/platy/roo/internal/output"
)

func DiscoverCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "discover",
		Short: "Refresh the discovery read model and list registered applications",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			s := session()
			document, err := s.Discovery(ctx)
			if err != nil {
				output.Fail("discover: %v", err)
			}
			if state, err := s.SyncDiscovery(ctx); err != nil {
				output.Logger.Warn("discovery sync not performed", "error", err)
			} else {
				output.Logger.Info(
					"discovery synced",
					"applications", state.Applications,
					"delegations", state.Delegations,
					"methods", state.Methods,
				)
			}
			output.PrintLines(
				"issuer            "+document.Issuer,
				"jwks              "+document.JwksURI,
				"token exchange    "+document.Endpoints.TokenExchange,
				"session create    "+document.Endpoints.SessionCreate,
				"session refresh   "+document.Endpoints.SessionRefresh,
				"session revoke    "+document.Endpoints.SessionRevoke,
				"introspect        "+document.Endpoints.Introspect,
				"oidc issuer       "+document.Oidc.Issuer,
				"oidc authorize    "+document.Oidc.AuthorizationEndpoint,
				"oidc token        "+document.Oidc.TokenEndpoint,
				"",
			)
			applications, err := s.Applications(ctx)
			if err != nil {
				output.Fail("list applications: %v", err)
			}
			for index, app := range applications {
				if index > 0 {
					output.PrintLines("")
				}
				printApplicationSummary(app)
			}
			return nil
		},
	}
}

func MetadataCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "metadata [app]",
		Short: "List applications and their callable methods from discovery",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s := session()
			if len(args) == 1 {
				app, err := s.Application(ctx, args[0])
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
				printApplicationMethods(app, "")
				output.PrintLines("", "call with: roo fetch "+app.Name+".<Service>.<Method> [-d <json>]")
				return nil
			}
			applications, err := s.Applications(ctx)
			if err != nil {
				output.Fail("list applications: %v", err)
			}
			for index, app := range applications {
				if index > 0 {
					output.PrintLines("")
				}
				printApplicationSummary(app)
			}
			return nil
		},
	}
}
