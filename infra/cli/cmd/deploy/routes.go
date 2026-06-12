package deploy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"jsmunro.me/platy/cli/internal/manifest"
	"jsmunro.me/platy/cli/internal/output"
)

// Route reconciliation: wrangler adds and updates zone routes from config but
// never deletes ones that were removed, so a route taken out of wrangler.jsonc
// keeps pointing production traffic at the worker. After each deploy the
// declared config is the desired state — any zone route still naming this
// worker but absent from config is stale and gets deleted (and logged as a
// diff), matching apply-deletes-resources semantics.

const cloudflareAPI = "https://api.cloudflare.com/client/v4"

type wranglerRoute struct {
	Pattern      string `json:"pattern"`
	ZoneName     string `json:"zone_name"`
	CustomDomain bool   `json:"custom_domain"`
}

type wranglerConfig struct {
	Routes []wranglerRoute `json:"routes"`
}

// stripJSONC removes full-line // comments (the only style used in our
// wrangler configs) so the document parses as JSON.
func stripJSONC(data []byte) []byte {
	lines := bytes.Split(data, []byte("\n"))
	kept := make([][]byte, 0, len(lines))
	for _, line := range lines {
		if bytes.HasPrefix(bytes.TrimSpace(line), []byte("//")) {
			continue
		}
		kept = append(kept, line)
	}
	return bytes.Join(kept, []byte("\n"))
}

func declaredZonePatterns(root, config string) (map[string]bool, error) {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(config)))
	if err != nil {
		return nil, err
	}
	parsed := wranglerConfig{}
	if err := json.Unmarshal(stripJSONC(data), &parsed); err != nil {
		return nil, err
	}
	patterns := map[string]bool{}
	for _, route := range parsed.Routes {
		// Custom domains are managed as worker domains, not zone routes.
		if !route.CustomDomain {
			patterns[route.Pattern] = true
		}
	}
	return patterns, nil
}

type apiRoute struct {
	ID      string `json:"id"`
	Pattern string `json:"pattern"`
	Script  string `json:"script"`
}

func cloudflareGet[T any](token, path string) ([]T, error) {
	request, err := http.NewRequest(http.MethodGet, cloudflareAPI+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	parsed := struct {
		Success bool            `json:"success"`
		Result  []T             `json:"result"`
		Errors  json.RawMessage `json:"errors"`
	}{}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !parsed.Success {
		return nil, fmt.Errorf("GET %s: %s", path, string(parsed.Errors))
	}
	return parsed.Result, nil
}

func cloudflareDelete(token, path string) error {
	request, err := http.NewRequest(http.MethodDelete, cloudflareAPI+path, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		body, _ := io.ReadAll(response.Body)
		return fmt.Errorf("DELETE %s: %d %s", path, response.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

type apiZone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// reconcileRoutes deletes zone routes that still point at this application's
// worker but are no longer declared in its wrangler config. Failures warn
// rather than fail: route cleanup must not block a deploy.
func reconcileRoutes(token, root, name string, app *manifest.Application) {
	if token == "" || app.Worker == "" {
		return
	}
	declared, err := declaredZonePatterns(root, app.Config)
	if err != nil {
		output.Logger.Warn("route reconcile: read config", "app", name, "error", err.Error())
		return
	}
	zones, err := cloudflareGet[apiZone](token, "/zones?per_page=50")
	if err != nil {
		output.Logger.Warn("route reconcile: list zones", "app", name, "error", err.Error())
		return
	}
	for _, zone := range zones {
		routes, err := cloudflareGet[apiRoute](token, "/zones/"+zone.ID+"/workers/routes")
		if err != nil {
			output.Logger.Warn("route reconcile: list routes", "zone", zone.Name, "error", err.Error())
			continue
		}
		for _, route := range routes {
			if route.Script != app.Worker || declared[route.Pattern] {
				continue
			}
			if err := cloudflareDelete(token, "/zones/"+zone.ID+"/workers/routes/"+route.ID); err != nil {
				output.Logger.Warn("route reconcile: delete route", "pattern", route.Pattern, "error", err.Error())
				continue
			}
			output.Logger.Info("removed stale worker route", "app", name, "worker", app.Worker, "pattern", route.Pattern, "zone", zone.Name)
		}
	}
}
