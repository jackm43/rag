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

type TrustBoundaryHints struct {
	Provider   Name
	AccountID  string
	TeamID     string
	TeamName   string
	TeamDomain string
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

type ApplicationAccess struct {
	AllowedGroups   []string `json:"allowedGroups,omitempty"`
	AllowedIdPs     []string `json:"allowedIdps,omitempty"`
	PostureRequired *bool    `json:"postureRequired,omitempty"`
}

type AccessApplicationSpec struct {
	Name                  string
	AllowedIdPIDs         []string
	AllowedGroupIDs       []string
	PolicyIDs             []string
	PostureRequired       bool
	WebClientCallbackURIs []string
}

type AccessApplication struct {
	ID       string
	ClientID string
}

type BootstrapOptions struct {
	EmailAllowlist        []string
	DefaultIdPType        string
	AccessAppName         string
	WorkersDevSubdomain   string
	PostureEnabled        bool
	PostureCheckName      string
	WebClientCallbackURIs []string
}

type BootstrapResult struct {
	Boundary           TrustBoundary
	IdentityProviders  []IdentityProvider
	Groups             map[string]AccessGroup
	EmailAllowlist     []string
	AdminPolicyID      string
	Posture            PosturePolicy
	AccessOIDCClientID string
}

type ProviderConfig struct {
	Boundary          TrustBoundary          `json:"boundary"`
	IdentityProviders []IdentityProvider     `json:"identityProviders"`
	Groups            map[string]AccessGroup `json:"groups"`
	EmailAllowlist    []string               `json:"emailAllowlist"`
	Posture           PosturePolicy          `json:"posture"`
	Organization      OrganizationPolicy     `json:"organization,omitempty"`
}

type EnsureOrganizationInput struct {
	Organization        OrganizationPolicy
	Groups              map[string]AccessGroup
	IdentityProviders   []IdentityProvider
	EmailAllowlist      []string
	PostureRuleID       string
	WorkersDevSubdomain string
}

type IdentityProxy interface {
	ResolveTrustBoundary(ctx context.Context, hints TrustBoundaryHints) (TrustBoundary, error)
	Bootstrap(ctx context.Context, boundary TrustBoundary, opts BootstrapOptions) (*BootstrapResult, error)
	ListIdentityProviders(ctx context.Context, boundary TrustBoundary) ([]IdentityProvider, error)
	EnsureGroups(ctx context.Context, boundary TrustBoundary, specs map[string][]string) (map[string]AccessGroup, error)
	EnsureEmailAllowlistPolicy(ctx context.Context, boundary TrustBoundary, emails []string, groupIDs []string) (string, error)
	EnsureDevicePosture(ctx context.Context, boundary TrustBoundary, enabled bool, ruleName string) (PosturePolicy, error)
	SetPostureEnabled(ctx context.Context, boundary TrustBoundary, enabled bool, ruleName string) (PosturePolicy, error)
	CreateAccessApplication(ctx context.Context, boundary TrustBoundary, spec AccessApplicationSpec) (*AccessApplication, error)
	EnsureAuthGatewayOIDCRedirectURIs(
		ctx context.Context,
		boundary TrustBoundary,
		accessAppName string,
		webClientCallbackURIs []string,
	) error
	ImpersonationAccessSpec(
		ctx context.Context,
		boundary TrustBoundary,
		access ApplicationAccess,
		groups map[string]AccessGroup,
		identityProviders []IdentityProvider,
		emailAllowlist []string,
		posture PosturePolicy,
	) (AccessApplicationSpec, error)
	EnsureImpersonationAccessApplication(ctx context.Context, boundary TrustBoundary, application string, spec AccessApplicationSpec) (*AccessApplication, error)
	EnsureWorkersDevBypassApps(ctx context.Context, boundary TrustBoundary, subdomain string) error
	EnsureWebClientBypassAccess(ctx context.Context, boundary TrustBoundary, application, domain string) error
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
	EnsureOrganization(ctx context.Context, boundary TrustBoundary, input EnsureOrganizationInput) (OrganizationPolicy, error)
}
