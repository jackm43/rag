package core

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestLoadOrganization(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..")
	policy := LoadOrganization(root)
	if policy.Organization.Name != "jsmunro" {
		t.Fatalf("organization name = %q, want jsmunro", policy.Organization.Name)
	}
	for _, zone := range TrustZones {
		if _, ok := policy.TrustZones[zone]; !ok {
			t.Fatalf("missing trust zone %q", zone)
		}
	}
	if policy.TrustZones[Tier0].Role != TierRoles[Tier0] {
		t.Fatalf("tier0 role = %q, want %q", policy.TrustZones[Tier0].Role, TierRoles[Tier0])
	}
	if policy.TrustZones[Tier3].Role != TierRoles[Tier3] {
		t.Fatalf("tier3 role = %q, want %q", policy.TrustZones[Tier3].Role, TierRoles[Tier3])
	}
	enroll := policy.EnrollPolicy()
	if enroll == nil || enroll.OnSuccess.GrantGroup != GroupEnrolled {
		t.Fatalf("enroll grant group = %q, want %q", enroll.OnSuccess.GrantGroup, GroupEnrolled)
	}
	if !policy.PostureRequiredForZone(Tier1) {
		t.Fatal("tier1 should require posture")
	}
	if policy.ZeroTrust.Gateway.TLSDecrypt {
		t.Fatal("gateway tls_decrypt should be disabled")
	}
	if !policy.ZeroTrust.Devices.GatewayProxyEnabled {
		t.Fatal("device gateway_proxy_enabled should be enabled")
	}
}

func TestTierRoles(t *testing.T) {
	want := map[string]string{
		Tier0: "root",
		Tier1: "critical",
		Tier2: "internal",
		Tier3: "enroll",
	}
	for tier, role := range want {
		if TierRoles[tier] != role {
			t.Fatalf("TierRoles[%q] = %q, want %q", tier, TierRoles[tier], role)
		}
		if TierRole(tier) != role {
			t.Fatalf("TierRole(%q) = %q, want %q", tier, TierRole(tier), role)
		}
	}
}

func TestNormalizeTrustZone(t *testing.T) {
	if got := NormalizeTrustZone(""); got != Tier2 {
		t.Fatalf("empty default = %q, want %q", got, Tier2)
	}
	if got := NormalizeTrustZone("TIER1"); got != Tier1 {
		t.Fatalf("case normalize = %q, want %q", got, Tier1)
	}
	if IsTrustZone("internal") {
		t.Fatal("role name is not a valid trust zone")
	}
}

func TestOrganizationGroupSpecs(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..")
	policy := LoadOrganization(root)
	specs := policy.GroupSpecs()
	if _, ok := specs[GroupEnrolled]; !ok {
		t.Fatalf("group specs missing %q", GroupEnrolled)
	}
}

func TestOrganizationValidateRejectsUnknownZone(t *testing.T) {
	dir := t.TempDir()
	path := OrganizationPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte(`organization:
  name: test
  provider: cloudflare
trust_zones:
  tier2:
    groups: [admins]
  tier1: {}
  tier0: {}
  tier3: {}
  rogue: {}
`)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	policy := OrganizationDocument{}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	loaded := OrganizationPolicy{Organization: policy.Organization, TrustZones: policy.TrustZones}
	if err := loaded.validate(); err == nil {
		t.Fatal("expected validation error for unknown trust zone")
	}
}
