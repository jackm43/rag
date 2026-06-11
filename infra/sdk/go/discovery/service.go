package discovery

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type ApplicationDiscoveryService struct {
	Dir string
}

func DefaultService() (*ApplicationDiscoveryService, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return &ApplicationDiscoveryService{Dir: filepath.Join(home, ".config", "platy", "applications")}, nil
}

func (s *ApplicationDiscoveryService) Register(app *Application) error {
	if app == nil || app.Name == "" {
		return fmt.Errorf("application document requires a name")
	}
	path, err := s.path(app.Name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(app, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

func (s *ApplicationDiscoveryService) Application(name string) (*Application, error) {
	path, err := s.path(name)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("application %s is not registered locally: %w", name, err)
	}
	app := &Application{}
	if err := json.Unmarshal(data, app); err != nil {
		return nil, fmt.Errorf("decode application document %s: %w", path, err)
	}
	return app, nil
}

func (s *ApplicationDiscoveryService) List() ([]*Application, error) {
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	applications := []*Application{}
	for _, entry := range entries {
		name, ok := strings.CutSuffix(entry.Name(), ".json")
		if !ok || entry.IsDir() {
			continue
		}
		app, err := s.Application(name)
		if err != nil {
			return nil, err
		}
		applications = append(applications, app)
	}
	sort.Slice(applications, func(i, j int) bool { return applications[i].Name < applications[j].Name })
	return applications, nil
}

func (s *ApplicationDiscoveryService) Remove(name string) error {
	path, err := s.path(name)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *ApplicationDiscoveryService) Sync(document *Document, gatewayURL string) error {
	for _, app := range document.Applications {
		merged := app
		merged.GatewayURL = gatewayURL
		if existing, err := s.Application(app.Name); err == nil {
			merged.Credential = existing.Credential
			for index := range merged.Resources {
				if merged.Resources[index].FullName != "" {
					continue
				}
				if resource, err := existing.Resource(merged.Resources[index].Name); err == nil {
					merged.Resources[index].FullName = resource.FullName
				}
			}
		}
		if err := s.Register(&merged); err != nil {
			return err
		}
	}
	return nil
}

func (s *ApplicationDiscoveryService) path(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return "", fmt.Errorf("invalid application name %q", name)
	}
	return filepath.Join(s.Dir, name+".json"), nil
}
