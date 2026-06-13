package provider

import (
	"encoding/json"
	"os"
	"path/filepath"

	"jsmunro.me/platy/cli/internal/output"
)

const ConfigRelativePath = "infra/applications/provider_config.json"

func ConfigPath(root string) string {
	return filepath.Join(root, filepath.FromSlash(ConfigRelativePath))
}

func LoadConfig(root string) ProviderConfig {
	data, err := os.ReadFile(ConfigPath(root))
	if err != nil {
		output.Fail("read %s: run terraform -chdir=infra/terraform apply first", ConfigRelativePath)
	}
	config := ProviderConfig{}
	if err := json.Unmarshal(data, &config); err != nil {
		output.Fail("decode %s: %v", ConfigRelativePath, err)
	}
	if len(config.Organization.TrustZones) == 0 {
		organization, err := LoadOrganization(root)
		if err != nil {
			output.Fail("%v", err)
		}
		config.Organization = organization
	}
	for tier, provisioned := range config.TrustZoneProvisioned {
		zone, ok := config.Organization.TrustZones[tier]
		if !ok {
			continue
		}
		zone.Provisioned = provisioned
		config.Organization.TrustZones[tier] = zone
	}
	return config
}
