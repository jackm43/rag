package core

import "context"

type Name string

const Cloudflare Name = "cloudflare"

type TrustBoundary struct {
	Provider     Name           `json:"provider"`
	AccountID    string         `json:"accountId,omitempty"`
	AccountName  string         `json:"accountName,omitempty"`
	TeamID       string         `json:"teamId,omitempty"`
	TeamName     string         `json:"teamName,omitempty"`
	TeamDomain   string         `json:"teamDomain,omitempty"`
	Organization map[string]any `json:"organization,omitempty"`
}

type IdentityProvider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type AccessGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type PostureCheck struct {
	Type string `json:"type"`
}

type PosturePolicy struct {
	Enabled bool           `json:"enabled"`
	RuleID  string         `json:"ruleId,omitempty"`
	Checks  []PostureCheck `json:"checks,omitempty"`
}

type ProviderConfig struct {
	Boundary             TrustBoundary                   `json:"boundary"`
	IdentityProviders    []IdentityProvider              `json:"identityProviders"`
	Groups               map[string]AccessGroup          `json:"groups"`
	EmailAllowlist       []string                        `json:"emailAllowlist"`
	Posture              PosturePolicy                   `json:"posture"`
	AccessOIDCClientID   string                          `json:"accessOidcClientId,omitempty"`
	ImpersonationClients map[string]string               `json:"impersonationClients,omitempty"`
	TrustZoneProvisioned map[string]TrustZoneProvisioned `json:"trustZoneProvisioned,omitempty"`
	Organization         OrganizationPolicy              `json:"organization,omitempty"`
}

// OAuthClientProvisioner is the dynamic, post-Terraform provider surface the
// CLI still owns: per-application confidential OAuth client lifecycle. All
// static Cloudflare configuration now lives in infra/terraform.
type OAuthClientProvisioner interface {
	EnsureApplicationOAuthClient(
		ctx context.Context,
		boundary TrustBoundary,
		application string,
		scopes []string,
		callbackURL string,
	) (clientID, clientSecret string, grantedScopes []string, err error)
	RotateApplicationOAuthClientSecret(ctx context.Context, boundary TrustBoundary, clientID string) (string, error)
	FinalizeApplicationOAuthClientRotation(ctx context.Context, boundary TrustBoundary, clientID string) error
	DeleteApplicationOAuthClient(ctx context.Context, boundary TrustBoundary, clientID string) error
}
