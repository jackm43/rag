package provider

import (
	"context"
	"fmt"
	"strings"

	"jsmunro.me/platy/cli/internal/provider/cloudflare"
	"jsmunro.me/platy/cli/internal/provider/core"
)

type (
	Name                    = core.Name
	TrustBoundary           = core.TrustBoundary
	TrustBoundaryHints      = core.TrustBoundaryHints
	IdentityProvider        = core.IdentityProvider
	AccessGroup             = core.AccessGroup
	PostureCheck            = core.PostureCheck
	PosturePolicy           = core.PosturePolicy
	ApplicationAccess       = core.ApplicationAccess
	AccessApplicationSpec   = core.AccessApplicationSpec
	AccessApplication       = core.AccessApplication
	BootstrapOptions        = core.BootstrapOptions
	BootstrapResult         = core.BootstrapResult
	ProviderConfig          = core.ProviderConfig
	IdentityProxy           = core.IdentityProxy
	EnsureOrganizationInput = core.EnsureOrganizationInput
	ZeroTrustSettings       = core.ZeroTrustSettings
	ZeroTrustGatewaySettings = core.ZeroTrustGatewaySettings
	ZeroTrustDeviceSettings  = core.ZeroTrustDeviceSettings
	AccessPolicySpec         = core.AccessPolicySpec
	AccessPolicyMFAConfig    = core.AccessPolicyMFAConfig
	EnrollStaffPolicy        = core.EnrollStaffPolicy
	EnrollContractorPolicy  = core.EnrollContractorPolicy
	EnrollOnSuccess         = core.EnrollOnSuccess
	EnrollOnRevoke          = core.EnrollOnRevoke
	EnrollPolicy            = core.EnrollPolicy
	TrustZoneProvisioned    = core.TrustZoneProvisioned
	TrustZoneSpec           = core.TrustZoneSpec
	OrganizationSpec        = core.OrganizationSpec
	OrganizationPolicy      = core.OrganizationPolicy
)

const (
	Cloudflare = core.Cloudflare

	Tier0 = core.Tier0
	Tier1 = core.Tier1
	Tier2 = core.Tier2
	Tier3 = core.Tier3

	GroupAdmins   = core.GroupAdmins
	GroupUsers    = core.GroupUsers
	GroupEnrolled = core.GroupEnrolled

	PolicyPlatformAdmins       = core.PolicyPlatformAdmins
	PolicyWorkersDevBypass     = core.PolicyWorkersDevBypass
	PolicyDevicePosture        = core.PolicyDevicePosture
	PolicyPostureRuleName      = core.PolicyPostureRuleName
	PolicyEnrollStaff          = core.PolicyEnrollStaff
	PolicyEnrollContractorRBI  = core.PolicyEnrollContractorRBI
	PolicyEnrollContractorWarp = core.PolicyEnrollContractorWarp
	PolicyCriticalAccess       = core.PolicyCriticalAccess
	PolicyRootJIT              = core.PolicyRootJIT
	PostureCheckWARP           = core.PostureCheckWARP
	EnrollAppName              = core.EnrollAppName
)

var (
	TierRoles      = core.TierRoles
	StandardGroups = core.StandardGroups
	TrustZones     = core.TrustZones
)

var (
	TierRole           = core.TierRole
	NormalizeTrustZone = core.NormalizeTrustZone
	IsTrustZone        = core.IsTrustZone
	TierPolicyName     = core.TierPolicyName
	LoadOrganization   = core.LoadOrganization
	OrganizationPath   = core.OrganizationPath
)

const OrganizationRelativePath = core.OrganizationRelativePath

func ParseName(raw string) (Name, error) {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return Cloudflare, nil
	}
	switch Name(raw) {
	case Cloudflare:
		return Cloudflare, nil
	default:
		return "", fmt.Errorf("unknown identity proxy provider %q", raw)
	}
}

func Resolve(ctx context.Context, name Name, apiToken string) (IdentityProxy, error) {
	switch name {
	case Cloudflare:
		return cloudflare.New(apiToken)
	default:
		return nil, fmt.Errorf("no implementation for provider %q", name)
	}
}

func ProviderConfigFromBootstrap(result *BootstrapResult, organization OrganizationPolicy) ProviderConfig {
	return ProviderConfig{
		Boundary:          result.Boundary,
		IdentityProviders: result.IdentityProviders,
		Groups:            result.Groups,
		EmailAllowlist:    result.EmailAllowlist,
		Posture:           result.Posture,
		Organization:      organization,
	}
}

func ParseEmailAllowlist(raw string) []string {
	if raw == "" {
		return nil
	}
	emails := []string{}
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' }) {
		part = strings.TrimSpace(part)
		if part != "" {
			emails = append(emails, part)
		}
	}
	return emails
}
