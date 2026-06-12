package commands

import (
	"context"

	"github.com/spf13/cobra"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/roo/internal/output"
)

func printIntrospection(response *idpv1.IntrospectResponse) {
	principal := response.GetPrincipal()
	body := map[string]any{
		"scopes": response.Scopes,
	}
	if principal != nil {
		entry := map[string]any{
			"kind": principal.Kind,
			"sub":  principal.Sub,
		}
		if principal.Email != "" {
			entry["email"] = principal.Email
		}
		if len(principal.Act) > 0 {
			entry["act"] = principal.Act
		}
		body["principal"] = entry
	}
	output.PrintJSON(body)
}

func LoginCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Authenticate with the gateway and create a device-bound session",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			s := session()
			if _, err := s.UserToken(ctx, true); err != nil {
				output.Fail("login: %v", err)
			}
			response, err := s.Introspect(ctx)
			if err != nil {
				output.Fail("introspect: %v", err)
			}
			printIntrospection(response)
			return nil
		},
	}
}

func LogoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Revoke the gateway session and clear cached tokens",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			s := session()
			if err := s.Logout(cmd.Context()); err != nil {
				output.Fail("logout: %v", err)
			}
			output.PrintJSON(map[string]any{"ok": true, "cleared": s.GatewayURL})
			return nil
		},
	}
}

func IntrospectCommand() *cobra.Command {
	as := ""
	cmd := &cobra.Command{
		Use:   "introspect",
		Short: "Show the current identity as the gateway sees it",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := withImpersonation(cmd.Context(), as)
			response, err := session().Introspect(ctx)
			if err != nil {
				output.Fail("introspect: %v", err)
			}
			printIntrospection(response)
			return nil
		},
	}
	cmd.Flags().StringVar(&as, "as", "", "introspect while impersonating a service application")
	return cmd
}

func ImpersonateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "impersonate",
		Short: "Manage service application impersonation",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "authorize <app>",
		Short: "Complete the browser authorization required to impersonate an application",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return impersonateAuthorize(cmd.Context(), args[0])
		},
	})
	return cmd
}

func impersonateAuthorize(ctx context.Context, application string) error {
	token, err := session().ImpersonationToken(ctx, application, true)
	if err != nil {
		output.Fail("impersonate authorize: %v", err)
	}
	output.PrintJSON(map[string]any{
		"ok":           true,
		"application":  application,
		"token_prefix": token[:min(12, len(token))] + "...",
	})
	return nil
}
