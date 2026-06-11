package provider

import (
	"context"
	"encoding/json"

	"connectrpc.com/connect"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/platform"
)

func organizationJSON(policy OrganizationPolicy) map[string]any {
	zones := []map[string]any{}
	for name, zone := range policy.TrustZones {
		entry := map[string]any{
			"name":         name,
			"role":         zone.Role,
			"description":  zone.Description,
			"teamLabel":    zone.TeamLabel,
			"groups":       zone.Groups,
			"accessPolicy": zone.AccessPolicy,
		}
		if zone.Provisioned.PolicyID != "" || zone.Provisioned.AccessAppID != "" || zone.Provisioned.Domain != "" {
			entry["provisioned"] = zone.Provisioned
		}
		if name == Tier3 {
			entry["enroll"] = zone.Enroll
		}
		zones = append(zones, entry)
	}
	return map[string]any{
		"organization": policy.Organization,
		"zeroTrust":    policy.ZeroTrust,
		"trustZones":   zones,
	}
}

func GatewayJSON(config ProviderConfig) map[string]any {
	groups := []map[string]string{}
	for _, group := range config.Groups {
		groups = append(groups, map[string]string{"id": group.ID, "name": group.Name})
	}
	payload := map[string]any{
		"boundary":          config.Boundary,
		"identityProviders": config.IdentityProviders,
		"groups":            groups,
		"emailAllowlist":    config.EmailAllowlist,
		"posture":           config.Posture,
	}
	if len(config.Organization.TrustZones) > 0 {
		payload["organization"] = organizationJSON(config.Organization)
	}
	return payload
}

func SyncToGateway(ctx context.Context, config ProviderConfig) error {
	data, err := json.Marshal(GatewayJSON(config))
	if err != nil {
		return err
	}
	s := platform.Session()
	_, err = s.RegistryClient().UpsertProviderConfig(ctx, connect.NewRequest(&idpv1.UpsertProviderConfigRequest{
		ConfigJson: string(data),
	}))
	if err != nil {
		return err
	}
	output.Logger.Info("synced provider config to gateway")
	return nil
}
