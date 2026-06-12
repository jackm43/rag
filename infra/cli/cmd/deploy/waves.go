package deploy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
)

type wranglerServiceBinding struct {
	Service string `json:"service"`
}

type wranglerServicesConfig struct {
	Services []wranglerServiceBinding `json:"services"`
}

func configServiceBindings(root, config string) []string {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(config)))
	if err != nil {
		output.Logger.Warn("deploy waves: read wrangler config", "config", config, "error", err.Error())
		return nil
	}
	var parsed wranglerServicesConfig
	if err := json.Unmarshal(stripJSONC(data), &parsed); err != nil {
		output.Logger.Warn("deploy waves: parse wrangler config", "config", config, "error", err.Error())
		return nil
	}
	workers := make([]string, 0, len(parsed.Services))
	for _, binding := range parsed.Services {
		if binding.Service != "" {
			workers = append(workers, binding.Service)
		}
	}
	return workers
}

// deployWaves orders the requested applications by their service-binding
// dependencies: an app whose wrangler config binds to another deployed app's
// worker lands in a later wave than that app. Only dependencies that are part
// of this deploy run order anything; workers outside the run are assumed to
// already exist on the account.
func deployWaves(root string, loaded *manifest.Manifest, names []string) [][]string {
	appByWorker := map[string]string{}
	for _, name := range loaded.Names() {
		if worker := loaded.Application(name).Worker; worker != "" {
			appByWorker[worker] = name
		}
	}
	inRun := map[string]bool{}
	for _, name := range names {
		inRun[name] = true
	}
	dependencies := map[string]map[string]bool{}
	for _, name := range names {
		dependencies[name] = map[string]bool{}
		for _, worker := range configServiceBindings(root, loaded.Application(name).Config) {
			if dep, ok := appByWorker[worker]; ok && dep != name && inRun[dep] {
				dependencies[name][dep] = true
			}
		}
	}

	waves := [][]string{}
	placed := map[string]bool{}
	remaining := len(names)
	for remaining > 0 {
		wave := []string{}
		for _, name := range names {
			if placed[name] {
				continue
			}
			ready := true
			for dep := range dependencies[name] {
				if !placed[dep] {
					ready = false
					break
				}
			}
			if ready {
				wave = append(wave, name)
			}
		}
		if len(wave) == 0 {
			cycle := []string{}
			for _, name := range names {
				if !placed[name] {
					cycle = append(cycle, name)
				}
			}
			output.Logger.Warn("deploy waves: service-binding dependency cycle, deploying remainder together", "apps", cycle)
			wave = cycle
		}
		sort.Strings(wave)
		for _, name := range wave {
			placed[name] = true
		}
		remaining -= len(wave)
		waves = append(waves, wave)
	}
	return waves
}
