package discovery

import (
	"fmt"
	"strings"
)

type fieldSet map[string]any

type fieldWithArgs struct {
	args   map[string]string
	fields []any
}

func inlineQuery(fields fieldSet) string {
	return "{ " + renderField(fields) + " }"
}

func operationQuery(operationName string, variableDefs map[string]string, fields fieldSet) string {
	defs := make([]string, 0, len(variableDefs))
	for name, typ := range variableDefs {
		defs = append(defs, fmt.Sprintf("$%s: %s", name, typ))
	}
	return fmt.Sprintf("query %s(%s) { %s }", operationName, strings.Join(defs, ", "), renderField(fields))
}

func renderField(field any) string {
	switch value := field.(type) {
	case string:
		return value
	case fieldSet:
		parts := make([]string, 0, len(value))
		for name, nested := range value {
			switch nestedValue := nested.(type) {
			case fieldWithArgs:
				args := make([]string, 0, len(nestedValue.args))
				for key, arg := range nestedValue.args {
					args = append(args, fmt.Sprintf("%s: %s", key, arg))
				}
				parts = append(parts, fmt.Sprintf("%s(%s) { %s }", name, strings.Join(args, ", "), renderFields(nestedValue.fields)))
			case []string:
				parts = append(parts, fmt.Sprintf("%s { %s }", name, strings.Join(nestedValue, " ")))
			case []any:
				parts = append(parts, fmt.Sprintf("%s { %s }", name, renderFields(nestedValue)))
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func renderFields(fields []any) string {
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		parts = append(parts, renderField(field))
	}
	return strings.Join(parts, " ")
}

var applicationSummaryFields = []string{
	"name",
	"audience",
	"endpoint",
	"description",
	"provider",
	"trustZone",
	"createdAt",
	"updatedAt",
}

var applicationDetailFields = []any{
	"name",
	"audience",
	"endpoint",
	"description",
	"provider",
	"trustZone",
	"createdAt",
	"updatedAt",
	fieldSet{
		"resources": []any{"name", fieldSet{"methods": []string{"name", "scope"}}},
	},
	fieldSet{
		"delegations": []string{"audience", "scopes"},
	},
}

var syncStateFields = []string{"syncedAt", "applications", "delegations", "methods"}

const ApplicationsListQuery = `{ applications { name audience endpoint description provider trustZone createdAt updatedAt } syncState { syncedAt applications delegations methods } }`

const ApplicationDetailQuery = `query ApplicationDetail($name: String!) { application(name: $name) { name audience endpoint description provider trustZone createdAt updatedAt resources { name methods { name scope } } delegations { audience scopes } } }`

const DelegationGraphQuery = `{ delegationGraph { application audience scopes } applications { name audience } }`

var RegistryQuery = inlineQuery(fieldSet{
	"applications": applicationDetailFields,
	"delegationGraph": []string{
		"application",
		"audience",
		"scopes",
	},
})
