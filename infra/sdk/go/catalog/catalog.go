package catalog

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type MethodRoute struct {
	Application string
	Service     string
	Method      string
	Scope       string
	HTTPMethod  string
	Path        string
	PathParams  []string
	Stream      string
	IdentityDPoP bool
}

type Resource struct {
	Name    string
	Methods []ResourceMethod
}

type ResourceMethod struct {
	Name  string
	Scope string
}

type Catalog struct {
	routes map[string]MethodRoute
}

func ResourcesPath(root string) string {
	return filepath.Join(root, "infra", "applications", "resources.yaml")
}

func Load(root string) (*Catalog, error) {
	data, err := os.ReadFile(ResourcesPath(root))
	if err != nil {
		return nil, fmt.Errorf("read resources.yaml: %w", err)
	}
	raw := struct {
		Applications map[string]struct {
			Resources []struct {
				Name    string `yaml:"name"`
				Methods []struct {
					Name  string `yaml:"name"`
					Scope string `yaml:"scope"`
					HTTP  struct {
						Method     string   `yaml:"method"`
						Path       string   `yaml:"path"`
						PathParams []string `yaml:"pathParams"`
						Stream     string   `yaml:"stream"`
					} `yaml:"http"`
				} `yaml:"methods"`
			} `yaml:"resources"`
		} `yaml:"applications"`
	}{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse resources.yaml: %w", err)
	}
	catalog := &Catalog{routes: map[string]MethodRoute{}}
	for application, entry := range raw.Applications {
		for _, resource := range entry.Resources {
			for _, method := range resource.Methods {
				key := RouteKey(application, resource.Name, method.Name)
				catalog.routes[key] = MethodRoute{
					Application:  application,
					Service:      resource.Name,
					Method:       method.Name,
					Scope:        method.Scope,
					HTTPMethod:   method.HTTP.Method,
					Path:         method.HTTP.Path,
					PathParams:   append([]string{}, method.HTTP.PathParams...),
					Stream:       method.HTTP.Stream,
					IdentityDPoP: resource.Name != "RegistryService",
				}
			}
		}
	}
	return catalog, nil
}

func RouteKey(application, service, method string) string {
	return application + "." + service + "." + method
}

func (c *Catalog) Route(application, service, method string) (MethodRoute, error) {
	route, ok := c.routes[RouteKey(application, service, method)]
	if !ok {
		return MethodRoute{}, fmt.Errorf("no HTTP route for %s.%s.%s", application, service, method)
	}
	return route, nil
}

func HasApplicationResources(root, application string) bool {
	catalog, err := Load(root)
	if err != nil {
		return false
	}
	prefix := application + "."
	for key := range catalog.routes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func ApplicationResources(root, application string) ([]Resource, error) {
	data, err := os.ReadFile(ResourcesPath(root))
	if err != nil {
		return nil, err
	}
	raw := struct {
		Applications map[string]struct {
			Resources []Resource `yaml:"resources"`
		} `yaml:"applications"`
	}{}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	entry, ok := raw.Applications[application]
	if !ok {
		return nil, nil
	}
	resources := make([]Resource, 0, len(entry.Resources))
	for _, resource := range entry.Resources {
		methods := make([]ResourceMethod, 0, len(resource.Methods))
		for _, method := range resource.Methods {
			scope := method.Scope
			if scope == "" {
				scope = fmt.Sprintf("%s/%s.%s", application, resource.Name, method.Name)
			}
			methods = append(methods, ResourceMethod{Name: method.Name, Scope: scope})
		}
		resources = append(resources, Resource{Name: resource.Name, Methods: methods})
	}
	return resources, nil
}

func SubstitutePath(path string, params map[string]string) string {
	result := path
	for key, value := range params {
		result = strings.ReplaceAll(result, "{"+key+"}", value)
	}
	return result
}
