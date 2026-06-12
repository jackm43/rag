package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"jsmunro.me/platy/cli/internal/output"
)

const OrganizationRelativePath = "infra/applications/organization.yaml"

type ZeroTrustGatewaySettings struct {
	TLSDecrypt     bool   `json:"tlsDecrypt,omitempty" yaml:"tls_decrypt,omitempty"`
	InspectionMode string `json:"inspectionMode,omitempty" yaml:"inspection_mode,omitempty"`
}

type ZeroTrustDeviceSettings struct {
	GatewayProxyEnabled    bool `json:"gatewayProxyEnabled,omitempty" yaml:"gateway_proxy_enabled,omitempty"`
	GatewayUdpProxyEnabled bool `json:"gatewayUdpProxyEnabled,omitempty" yaml:"gateway_udp_proxy_enabled,omitempty"`
}

type PostureCheckSpec struct {
	Type string `json:"type,omitempty" yaml:"type,omitempty"`
	Name string `json:"name,omitempty" yaml:"name,omitempty"`
}

type ZeroTrustPostureSpec struct {
	Checks []PostureCheckSpec `json:"checks,omitempty" yaml:"checks,omitempty"`
}

type ZeroTrustSettings struct {
	Gateway ZeroTrustGatewaySettings `json:"gateway,omitempty" yaml:"gateway,omitempty"`
	Devices ZeroTrustDeviceSettings  `json:"devices,omitempty" yaml:"devices,omitempty"`
	Posture ZeroTrustPostureSpec     `json:"posture,omitempty" yaml:"posture,omitempty"`
}

type AccessPolicyMFAConfig struct {
	SessionDuration string `json:"sessionDuration,omitempty" yaml:"session_duration,omitempty"`
}

type AccessPolicySpec struct {
	ApprovalRequired             bool                   `json:"approvalRequired,omitempty" yaml:"approval_required,omitempty"`
	PurposeJustificationRequired bool                   `json:"purposeJustificationRequired,omitempty" yaml:"purpose_justification_required,omitempty"`
	SessionDuration              string                 `json:"sessionDuration,omitempty" yaml:"session_duration,omitempty"`
	IsolationRequired            bool                   `json:"isolationRequired,omitempty" yaml:"isolation_required,omitempty"`
	RequirePosture               bool                   `json:"requirePosture,omitempty" yaml:"require_posture,omitempty"`
	MFAConfig                    *AccessPolicyMFAConfig `json:"mfaConfig,omitempty" yaml:"mfa_config,omitempty"`
}

type EnrollStaffPolicy struct {
	IdPTypes       []string `json:"idpTypes,omitempty" yaml:"idp_types,omitempty"`
	RequirePosture bool     `json:"requirePosture,omitempty" yaml:"require_posture,omitempty"`
}

type EnrollContractorPolicy struct {
	IdPTypes         []string `json:"idpTypes,omitempty" yaml:"idp_types,omitempty"`
	RequireWarpOrRBI bool     `json:"requireWarpOrRbi,omitempty" yaml:"require_warp_or_rbi,omitempty"`
}

type EnrollOnSuccess struct {
	GrantGroup     string `json:"grantGroup,omitempty" yaml:"grant_group,omitempty"`
	GatewaySession bool   `json:"gatewaySession,omitempty" yaml:"gateway_session,omitempty"`
}

type EnrollOnRevoke struct {
	RequireReenroll bool `json:"requireReenroll,omitempty" yaml:"require_reenroll,omitempty"`
}

type EnrollPolicy struct {
	Staff      EnrollStaffPolicy      `json:"staff,omitempty" yaml:"staff,omitempty"`
	Contractor EnrollContractorPolicy `json:"contractor,omitempty" yaml:"contractor,omitempty"`
	OnSuccess  EnrollOnSuccess        `json:"onSuccess,omitempty" yaml:"on_success,omitempty"`
	OnRevoke   EnrollOnRevoke         `json:"onRevoke,omitempty" yaml:"on_revoke,omitempty"`
}

type TrustZoneProvisioned struct {
	PolicyID    string `json:"policyId,omitempty"`
	AccessAppID string `json:"accessAppId,omitempty"`
	Domain      string `json:"domain,omitempty"`
}

type TrustZoneSpec struct {
	Role         string               `json:"role,omitempty" yaml:"role,omitempty"`
	Description  string               `json:"description,omitempty" yaml:"description,omitempty"`
	TeamLabel    string               `json:"teamLabel,omitempty" yaml:"team_label,omitempty"`
	Groups       []string             `json:"groups,omitempty" yaml:"groups,omitempty"`
	AccessPolicy AccessPolicySpec     `json:"accessPolicy,omitempty" yaml:"access_policy,omitempty"`
	Enroll       EnrollPolicy         `json:"enroll,omitempty" yaml:"enroll,omitempty"`
	Provisioned  TrustZoneProvisioned `json:"provisioned,omitempty"`
}

type OrganizationSpec struct {
	Name     string            `json:"name,omitempty" yaml:"name,omitempty"`
	Provider string            `json:"provider,omitempty" yaml:"provider,omitempty"`
	Secrets  map[string]string `json:"secrets,omitempty" yaml:"secrets,omitempty"`
}

type OrganizationDocument struct {
	Organization OrganizationSpec         `yaml:"organization"`
	ZeroTrust    ZeroTrustSettings        `yaml:"zero_trust"`
	TrustZones   map[string]TrustZoneSpec `yaml:"trust_zones"`
}

type OrganizationPolicy struct {
	Organization OrganizationSpec         `json:"organization"`
	ZeroTrust    ZeroTrustSettings        `json:"zeroTrust"`
	TrustZones   map[string]TrustZoneSpec `json:"trustZones"`
}

func OrganizationPath(root string) string {
	return filepath.Join(root, filepath.FromSlash(OrganizationRelativePath))
}

func LoadOrganization(root string) OrganizationPolicy {
	path := OrganizationPath(root)
	data, err := os.ReadFile(path)
	if err != nil {
		output.Fail("read %s: %v", OrganizationRelativePath, err)
	}
	document := OrganizationDocument{}
	if err := yaml.Unmarshal(data, &document); err != nil {
		output.Fail("decode %s: %v", OrganizationRelativePath, err)
	}
	policy := OrganizationPolicy{
		Organization: document.Organization,
		ZeroTrust:    document.ZeroTrust,
		TrustZones:   document.TrustZones,
	}
	policy.normalize()
	if err := policy.validate(); err != nil {
		output.Fail("%v", err)
	}
	return policy
}

func (p *OrganizationPolicy) normalize() {
	if p.Organization.Provider == "" {
		p.Organization.Provider = string(Cloudflare)
	}
	if p.TrustZones == nil {
		p.TrustZones = map[string]TrustZoneSpec{}
	}
	for name, zone := range p.TrustZones {
		tier := NormalizeTrustZone(name)
		zone.Role = TierRole(tier)
		if zone.Enroll.OnSuccess.GrantGroup == "" && tier == Tier3 {
			zone.Enroll.OnSuccess.GrantGroup = GroupEnrolled
		}
		p.TrustZones[name] = zone
	}
}

func (p *OrganizationPolicy) validate() error {
	if strings.TrimSpace(p.Organization.Name) == "" {
		return fmt.Errorf("%s: organization.name is required", OrganizationRelativePath)
	}
	for _, zone := range TrustZones {
		if _, ok := p.TrustZones[zone]; !ok {
			return fmt.Errorf("%s: trust_zones.%s is required", OrganizationRelativePath, zone)
		}
	}
	for name := range p.TrustZones {
		if !IsTrustZone(name) {
			return fmt.Errorf("%s: unknown trust zone %q", OrganizationRelativePath, name)
		}
	}
	return nil
}

func (p *OrganizationPolicy) Zone(name string) (TrustZoneSpec, bool) {
	tier := NormalizeTrustZone(name)
	zone, ok := p.TrustZones[tier]
	return zone, ok
}

func (p *OrganizationPolicy) PostureRequiredForZone(name string) bool {
	zone, ok := p.Zone(name)
	if !ok {
		return false
	}
	return zone.AccessPolicy.RequirePosture
}

func (p *OrganizationPolicy) NeedsPosture() bool {
	for _, check := range p.ZeroTrust.Posture.Checks {
		if strings.TrimSpace(check.Type) != "" {
			return true
		}
	}
	for _, zone := range p.TrustZones {
		if zone.AccessPolicy.RequirePosture || zone.Enroll.Staff.RequirePosture {
			return true
		}
	}
	return false
}

func (p *OrganizationPolicy) PrimaryPostureCheckName() string {
	for _, check := range p.ZeroTrust.Posture.Checks {
		if strings.TrimSpace(check.Name) != "" {
			return check.Name
		}
	}
	return PolicyPostureRuleName
}

func (p *OrganizationPolicy) CloudflareAPITokenRef() string {
	if p.Organization.Secrets == nil {
		return ""
	}
	return strings.TrimSpace(p.Organization.Secrets["cloudflare_api_token"])
}

func (p *OrganizationPolicy) GroupSpecs() map[string][]string {
	specs := map[string][]string{}
	for _, zone := range p.TrustZones {
		for _, group := range zone.Groups {
			if _, exists := specs[group]; !exists {
				specs[group] = StandardGroups[group]
			}
		}
	}
	for name, members := range StandardGroups {
		if _, exists := specs[name]; !exists {
			specs[name] = members
		}
	}
	return specs
}

func (p *OrganizationPolicy) EnrollPolicy() *EnrollPolicy {
	zone, ok := p.Zone(Tier3)
	if !ok {
		return nil
	}
	return &zone.Enroll
}
