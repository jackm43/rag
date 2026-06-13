package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"jsmunro.me/platy/sdk/secrets"
)

type OidcProvider struct {
	Issuer                string `json:"issuer"`
	ClientID              string `json:"client_id"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	JwksEndpoint          string `json:"jwks_endpoint"`
}

type Endpoints struct {
	TokenExchange string `json:"token_exchange"`
	TokenRevoke   string `json:"token_revoke"`
	Introspect    string `json:"introspect"`
	Discovery     string `json:"discovery"`
	Jwks          string `json:"jwks"`
}

type TrustBoundary struct {
	Provider   string `json:"provider,omitempty"`
	AccountID  string `json:"accountId,omitempty"`
	TeamID     string `json:"teamId,omitempty"`
	TeamName   string `json:"teamName,omitempty"`
	TeamDomain string `json:"teamDomain,omitempty"`
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
	PostureRequired bool     `json:"postureRequired,omitempty"`
}

type AccessPolicyMFAConfig struct {
	SessionDuration string `json:"sessionDuration,omitempty"`
}

type AccessPolicySpec struct {
	ApprovalRequired             bool                   `json:"approvalRequired,omitempty"`
	PurposeJustificationRequired bool                   `json:"purposeJustificationRequired,omitempty"`
	SessionDuration              string                 `json:"sessionDuration,omitempty"`
	IsolationRequired            bool                   `json:"isolationRequired,omitempty"`
	RequirePosture               bool                   `json:"requirePosture,omitempty"`
	MFAConfig                    *AccessPolicyMFAConfig `json:"mfaConfig,omitempty"`
}

type ZeroTrustGatewaySettings struct {
	TLSDecrypt     bool   `json:"tlsDecrypt,omitempty"`
	InspectionMode string `json:"inspectionMode,omitempty"`
}

type ZeroTrustDeviceSettings struct {
	GatewayProxyEnabled    bool `json:"gatewayProxyEnabled,omitempty"`
	GatewayUdpProxyEnabled bool `json:"gatewayUdpProxyEnabled,omitempty"`
}

type PostureCheckSpec struct {
	Type string `json:"type,omitempty"`
	Name string `json:"name,omitempty"`
}

type ZeroTrustPostureSpec struct {
	Checks []PostureCheckSpec `json:"checks,omitempty"`
}

type ZeroTrustSettings struct {
	Gateway ZeroTrustGatewaySettings `json:"gateway,omitempty"`
	Devices ZeroTrustDeviceSettings  `json:"devices,omitempty"`
	Posture ZeroTrustPostureSpec     `json:"posture,omitempty"`
}

type EnrollPolicy struct {
	Staff      EnrollStaffPolicy      `json:"staff,omitempty"`
	Contractor EnrollContractorPolicy `json:"contractor,omitempty"`
	OnSuccess  EnrollOnSuccess        `json:"onSuccess,omitempty"`
	OnRevoke   EnrollOnRevoke         `json:"onRevoke,omitempty"`
}

type EnrollStaffPolicy struct {
	IdPTypes       []string `json:"idpTypes,omitempty"`
	RequirePosture bool     `json:"requirePosture,omitempty"`
}

type EnrollContractorPolicy struct {
	IdPTypes         []string `json:"idpTypes,omitempty"`
	RequireWarpOrRBI bool     `json:"requireWarpOrRbi,omitempty"`
}

type EnrollOnSuccess struct {
	GrantGroup     string `json:"grantGroup,omitempty"`
	GatewaySession bool   `json:"gatewaySession,omitempty"`
}

type EnrollOnRevoke struct {
	RequireReenroll bool `json:"requireReenroll,omitempty"`
}

type TrustZoneSpec struct {
	Name         string           `json:"name"`
	Role         string           `json:"role,omitempty"`
	Description  string           `json:"description,omitempty"`
	TeamLabel    string           `json:"teamLabel,omitempty"`
	Groups       []string         `json:"groups,omitempty"`
	AccessPolicy AccessPolicySpec `json:"accessPolicy,omitempty"`
	Enroll       EnrollPolicy     `json:"enroll,omitempty"`
}

type OrganizationPolicy struct {
	Organization OrganizationSpec  `json:"organization"`
	ZeroTrust    ZeroTrustSettings `json:"zeroTrust,omitempty"`
	TrustZones   []TrustZoneSpec   `json:"trustZones"`
}

type OrganizationSpec struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

type ProviderConfig struct {
	Boundary          TrustBoundary      `json:"boundary"`
	IdentityProviders []IdentityProvider `json:"identityProviders"`
	Groups            []AccessGroup      `json:"groups"`
	EmailAllowlist    []string           `json:"emailAllowlist"`
	Posture           PosturePolicy      `json:"posture"`
	Organization      OrganizationPolicy `json:"organization,omitempty"`
}

type Delegation struct {
	Audience string   `json:"audience"`
	Scopes   []string `json:"scopes"`
}

type ResourceMethod struct {
	Name  string `json:"name"`
	Scope string `json:"scope"`
}

type Resource struct {
	Name     string           `json:"name"`
	FullName string           `json:"full_name,omitempty"`
	Methods  []ResourceMethod `json:"methods"`
}

type Application struct {
	Name                        string                    `json:"name"`
	Audience                    string                    `json:"audience"`
	Endpoint                    string                    `json:"endpoint"`
	Description                 string                    `json:"description"`
	Resources                   []Resource                `json:"resources"`
	Delegations                 []Delegation              `json:"delegations,omitempty"`
	Provider                    string                    `json:"provider,omitempty"`
	TrustZone                   string                    `json:"trustZone,omitempty"`
	TrustBoundary               TrustBoundary             `json:"trustBoundary,omitempty"`
	Access                      ApplicationAccess         `json:"access,omitempty"`
	CreatedAt                   int64                     `json:"created_at"`
	UpdatedAt                   int64                     `json:"updated_at"`
	GatewayURL                  string                    `json:"gateway_url,omitempty"`
	ImpersonationAccessClientID string                    `json:"impersonation_access_client_id,omitempty"`
	ProviderOAuthClientID       string                    `json:"provider_oauth_client_id,omitempty"`
	Credential                  *secrets.ClientCredential `json:"credential,omitempty"`
	ProviderOAuth               *secrets.ClientCredential `json:"provider_oauth,omitempty"`
}

type Document struct {
	Issuer                string         `json:"issuer"`
	JwksURI               string         `json:"jwks_uri"`
	TokenExchangeEndpoint string         `json:"token_exchange_endpoint"`
	Endpoints             Endpoints      `json:"endpoints"`
	Oidc                  OidcProvider   `json:"oidc"`
	Applications          []Application  `json:"applications"`
	Provider              ProviderConfig `json:"provider,omitempty"`
}

func (r *Resource) QualifiedName(application string) string {
	if r.FullName != "" {
		return r.FullName
	}
	return fmt.Sprintf("%s.v1.%s", application, r.Name)
}

func (a *Application) Resource(name string) (*Resource, error) {
	for index := range a.Resources {
		if a.Resources[index].Name == name {
			return &a.Resources[index], nil
		}
	}
	return nil, fmt.Errorf("application %s has no service %s", a.Name, name)
}

func (a *Application) MethodPath(service, method string) (string, error) {
	resource, err := a.Resource(service)
	if err != nil {
		return "", err
	}
	for _, candidate := range resource.Methods {
		if candidate.Name == method {
			return "/" + resource.QualifiedName(a.Name) + "/" + method, nil
		}
	}
	return "", fmt.Errorf("service %s.%s has no method %s", a.Name, service, method)
}

func (a *Application) Methods() []string {
	methods := []string{}
	for _, resource := range a.Resources {
		for _, method := range resource.Methods {
			methods = append(methods, fmt.Sprintf("%s.%s.%s", a.Name, resource.Name, method.Name))
		}
	}
	return methods
}

func (d *Document) Application(name string) (*Application, error) {
	for _, app := range d.Applications {
		if app.Name == name {
			return &app, nil
		}
	}
	return nil, fmt.Errorf("application %s is not registered with the gateway", name)
}

func Fetch(ctx context.Context, client *http.Client, gatewayURL string) (*Document, error) {
	url := strings.TrimRight(gatewayURL, "/") + "/api/discovery"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("gateway discovery: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		detail := strings.TrimSpace(string(body))
		if detail == "" {
			return nil, fmt.Errorf("gateway discovery failed with status %d", response.StatusCode)
		}
		if response.StatusCode == http.StatusNotFound && strings.Contains(detail, "1042") {
			return nil, fmt.Errorf(
				"gateway worker is not deployed at %s; run platy deploy idp",
				gatewayURL,
			)
		}
		if response.StatusCode == http.StatusForbidden && strings.Contains(detail, "1050") {
			return nil, fmt.Errorf(
				"gateway discovery blocked by Cloudflare Access (error 1050); run platy bootstrap to create workers.dev bypass Access apps, or disable deny_unmatched_requests",
			)
		}
		return nil, fmt.Errorf("gateway discovery failed with status %d: %s", response.StatusCode, detail)
	}
	document := &Document{}
	if err := json.NewDecoder(response.Body).Decode(document); err != nil {
		return nil, fmt.Errorf("gateway discovery decode: %w", err)
	}
	return document, nil
}
