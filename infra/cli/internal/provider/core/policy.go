package core

import (
	"fmt"
	"strings"
)

const (
	Tier0 = "tier0"
	Tier1 = "tier1"
	Tier2 = "tier2"
	Tier3 = "tier3"
)

const (
	GroupAdmins   = "admins"
	GroupUsers    = "users"
	GroupEnrolled = "enrolled"

	PolicyPlatformAdmins       = "Platform admins"
	PolicyWorkersDevBypass     = "workers-dev-bypass"
	PolicyDevicePosture        = "Platform device posture"
	PolicyPostureRuleName      = "Platform WARP connected"
	PolicyEnrollStaff          = "enroll-staff"
	PolicyEnrollContractorRBI  = "enroll-contractor-rbi"
	PolicyEnrollContractorWarp = "enroll-contractor-warp"
	PolicyCriticalAccess       = "critical-access"
	PolicyRootJIT              = "root-jit"

	PostureCheckWARP = "warp"
)

var TierRoles = map[string]string{
	Tier0: "root",
	Tier1: "critical",
	Tier2: "internal",
	Tier3: "enroll",
}

var StandardGroups = map[string][]string{
	GroupAdmins:   nil,
	GroupUsers:    nil,
	GroupEnrolled: nil,
}

var TrustZones = []string{Tier0, Tier1, Tier2, Tier3}

func TierRole(tier string) string {
	return TierRoles[NormalizeTrustZone(tier)]
}

func NormalizeTrustZone(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return Tier2
	}
	return raw
}

func IsTrustZone(name string) bool {
	_, ok := TierRoles[NormalizeTrustZone(name)]
	return ok
}

func TierPolicyName(tier string) string {
	tier = NormalizeTrustZone(tier)
	return fmt.Sprintf("%s-%s", tier, TierRole(tier))
}

const (
	EnrollAppName = "Platy Enroll"
)
