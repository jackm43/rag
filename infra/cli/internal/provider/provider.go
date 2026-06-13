package provider

import (
	"context"
	"fmt"
	"strings"

	"jsmunro.me/platy/cli/internal/provider/cloudflare"
	"jsmunro.me/platy/cli/internal/provider/core"
)

type (
	Name                 = core.Name
	TrustBoundary        = core.TrustBoundary
	IdentityProvider     = core.IdentityProvider
	AccessGroup          = core.AccessGroup
	PostureCheck         = core.PostureCheck
	PosturePolicy        = core.PosturePolicy
	ProviderConfig       = core.ProviderConfig
	IdentityProxy        = core.IdentityProxy
	TrustZoneProvisioned = core.TrustZoneProvisioned
	TrustZoneSpec        = core.TrustZoneSpec
	OrganizationSpec     = core.OrganizationSpec
	OrganizationPolicy   = core.OrganizationPolicy
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
