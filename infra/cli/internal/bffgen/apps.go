package bffgen

import (
	"sort"

	"jsmunro.me/platy/cli/internal/manifest"
)

func ClientOnlyApps(root string) []string {
	loaded := manifest.Load(root)
	var apps []string
	for name, entry := range loaded.Applications {
		if manifest.HasProtoPackage(root, name) {
			continue
		}
		if entry.Config == "" {
			continue
		}
		if len(proxyTargets(entry)) == 0 {
			continue
		}
		apps = append(apps, name)
	}
	sort.Strings(apps)
	return apps
}
