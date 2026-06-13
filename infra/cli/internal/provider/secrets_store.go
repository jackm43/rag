package provider

import (
	"encoding/json"
	"os"
)

func SaveSecretsStoreID(root, storeID string) error {
	path := ConfigPath(root)
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	config := ProviderConfig{}
	if err := json.Unmarshal(data, &config); err != nil {
		return err
	}
	config.SecretsStoreID = storeID
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(encoded, '\n'), 0o644)
}
