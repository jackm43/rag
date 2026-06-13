package secrets

import "strings"

const CFSSPrefix = "cfss://"

func ProviderForReference(reference string) string {
	reference = strings.TrimSpace(reference)
	switch {
	case strings.HasPrefix(reference, "op://"):
		return OnePasswordProvider
	case strings.HasPrefix(reference, CFSSPrefix):
		return CloudflareSecretsStoreProvider
	case strings.HasPrefix(reference, "file://"):
		return FileProvider
	default:
		return ""
	}
}

func ParseCFSSReference(reference string) (storeID, secretName string, ok bool) {
	reference = strings.TrimSpace(reference)
	if !strings.HasPrefix(reference, CFSSPrefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(reference, CFSSPrefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func WorkerSecretName(application, envKey string) string {
	slug := strings.ToLower(strings.TrimSpace(envKey))
	slug = strings.ReplaceAll(slug, "_", "-")
	return "platy-" + strings.TrimSpace(application) + "-" + slug
}

func WorkerSecretNameFromLogical(logical string) string {
	title, field := splitSecretName(logical)
	envKey := strings.ToUpper(field)
	if field == FieldServiceClientSecret {
		envKey = "SERVICE_CLIENT_SECRET"
	}
	if field == FieldProviderOAuthClientSecret {
		envKey = "PROVIDER_OAUTH_CLIENT_SECRET"
	}
	if field == FieldAPIKey {
		envKey = "API_KEY"
	}
	return WorkerSecretName(title, envKey)
}
