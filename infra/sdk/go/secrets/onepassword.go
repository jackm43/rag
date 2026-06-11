package secrets

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"

	onepassword "github.com/1password/onepassword-sdk-go"
)

const (
	OnePasswordProvider = "1password"

	serviceAccountTokenEnv = "OP_SERVICE_ACCOUNT_TOKEN"
	accountEnv             = "OP_ACCOUNT"
	integrationName        = "platy-secret-service"
	integrationVersion     = "v1.0.0"
)

type OnePassword struct {
	VaultID string
	Logger  *slog.Logger

	once   sync.Once
	client *onepassword.Client
	err    error
}

func (p *OnePassword) Name() string {
	return OnePasswordProvider
}

func (p *OnePassword) Reference(name string) string {
	title, field := splitSecretName(name)
	return fmt.Sprintf("op://%s/%s/%s", p.VaultID, title, field)
}

func (p *OnePassword) Store(ctx context.Context, name, body string) (string, error) {
	client, err := p.connect(ctx)
	if err != nil {
		return "", err
	}
	title, field := splitSecretName(name)

	existing, err := p.findItem(ctx, client, title)
	if err != nil {
		return "", err
	}
	if existing != nil {
		item, err := client.Items().Get(ctx, p.VaultID, existing.ID)
		if err != nil {
			return "", fmt.Errorf("get 1password item %s: %w", existing.ID, err)
		}
		consolidateField(&item, field, body)
		item, err = client.Items().Put(ctx, item)
		if err != nil {
			return "", fmt.Errorf("update 1password item %s: %w", existing.ID, err)
		}
		p.Logger.Debug("updated 1password item", "vault", p.VaultID, "title", title, "field", field)
		return p.referenceForField(item, field), nil
	}

	item, err := client.Items().Create(ctx, onepassword.ItemCreateParams{
		Category: onepassword.ItemCategoryAPICredentials,
		VaultID:  p.VaultID,
		Title:    title,
		Fields:   []onepassword.ItemField{concealedItemField(field, body)},
	})
	if err != nil {
		return "", fmt.Errorf("create 1password item %q: %w", title, err)
	}
	p.Logger.Debug("created 1password item", "vault", p.VaultID, "title", title, "field", field)
	return p.referenceForField(item, field), nil
}

func (p *OnePassword) Resolve(ctx context.Context, reference string) (string, error) {
	client, err := p.connect(ctx)
	if err != nil {
		return "", err
	}
	secret, err := client.Secrets().Resolve(ctx, reference)
	if err == nil {
		return secret, nil
	}
	value, directErr := p.resolveDirect(ctx, client, reference)
	if directErr != nil {
		return "", fmt.Errorf("resolve %s: %w (direct lookup: %v)", reference, err, directErr)
	}
	return value, nil
}

func (p *OnePassword) referenceForField(item onepassword.Item, fieldKey string) string {
	selected, err := selectField(item.Fields, fieldKey)
	if err != nil {
		return fmt.Sprintf("op://%s/%s/%s", p.VaultID, item.ID, fieldKey)
	}
	return fmt.Sprintf("op://%s/%s/%s", p.VaultID, item.ID, selected.ID)
}

func (p *OnePassword) resolveDirect(ctx context.Context, client *onepassword.Client, reference string) (string, error) {
	vaultID, itemKey, fieldKey, ok := parseOpReference(reference)
	if !ok {
		return "", fmt.Errorf("invalid op reference")
	}
	if vaultID != "" && vaultID != p.VaultID {
		return "", fmt.Errorf("vault %q is outside the configured services vault", vaultID)
	}
	item, err := p.getItem(ctx, client, itemKey)
	if err != nil {
		return "", err
	}
	selected, err := selectField(item.Fields, fieldKey)
	if err != nil {
		return "", err
	}
	return selected.Value, nil
}

func (p *OnePassword) getItem(ctx context.Context, client *onepassword.Client, itemKey string) (onepassword.Item, error) {
	if looksLikeItemID(itemKey) {
		item, err := client.Items().Get(ctx, p.VaultID, itemKey)
		if err == nil {
			return item, nil
		}
	}
	overview, err := p.findItem(ctx, client, itemKey)
	if err != nil {
		return onepassword.Item{}, err
	}
	if overview == nil {
		return onepassword.Item{}, fmt.Errorf("1password item %q not found", itemKey)
	}
	return client.Items().Get(ctx, p.VaultID, overview.ID)
}

func (p *OnePassword) connect(ctx context.Context) (*onepassword.Client, error) {
	p.once.Do(func() {
		options := []onepassword.ClientOption{
			onepassword.WithIntegrationInfo(integrationName, integrationVersion),
		}
		if token := os.Getenv(serviceAccountTokenEnv); token != "" {
			p.Logger.Debug("authenticating to 1password with a service account token")
			options = append(options, onepassword.WithServiceAccountToken(token))
		} else {
			account := os.Getenv(accountEnv)
			if account == "" {
				p.err = fmt.Errorf("set %s for service account auth or %s for desktop app auth", serviceAccountTokenEnv, accountEnv)
				return
			}
			p.Logger.Debug("authenticating to 1password through the desktop app", "account", account)
			options = append(options, onepassword.WithDesktopAppIntegration(account))
		}
		p.client, p.err = onepassword.NewClient(ctx, options...)
	})
	if p.err != nil {
		return nil, fmt.Errorf("1password client: %w", p.err)
	}
	return p.client, nil
}

func (p *OnePassword) findItem(ctx context.Context, client *onepassword.Client, title string) (*onepassword.ItemOverview, error) {
	items, err := client.Items().List(ctx, p.VaultID)
	if err != nil {
		return nil, fmt.Errorf("list 1password vault %s: %w", p.VaultID, err)
	}
	for _, item := range items {
		if item.Title == title {
			return &item, nil
		}
	}
	return nil, nil
}

func parseOpReference(reference string) (vaultID, itemKey, fieldKey string, ok bool) {
	reference = strings.TrimSpace(reference)
	if !strings.HasPrefix(reference, "op://") {
		return "", "", "", false
	}
	rest := strings.TrimPrefix(reference, "op://")
	parts := strings.SplitN(rest, "/", 3)
	if len(parts) != 3 {
		return "", "", "", false
	}
	fieldKey = parts[2]
	if index := strings.Index(fieldKey, "?"); index >= 0 {
		fieldKey = fieldKey[:index]
	}
	return parts[0], parts[1], fieldKey, true
}

func looksLikeItemID(value string) bool {
	if len(value) < 20 {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

func selectField(fields []onepassword.ItemField, key string) (*onepassword.ItemField, error) {
	keys := []string{key}
	if key == FieldClientSecret {
		keys = append(keys, FieldServiceClientSecret)
	}
	var idMatches, titleMatches []onepassword.ItemField
	for _, field := range fields {
		for _, candidate := range keys {
			if field.ID == candidate {
				idMatches = append(idMatches, field)
			}
			if field.Title == candidate {
				titleMatches = append(titleMatches, field)
			}
		}
	}
	switch {
	case len(idMatches) == 1:
		return &idMatches[0], nil
	case len(idMatches) > 1:
		return preferConcealedField(idMatches, key)
	case len(titleMatches) == 1:
		return &titleMatches[0], nil
	case len(titleMatches) > 1:
		return preferConcealedField(titleMatches, key)
	default:
		return nil, fmt.Errorf("field %q not found", key)
	}
}

func preferConcealedField(fields []onepassword.ItemField, key string) (*onepassword.ItemField, error) {
	var concealed []onepassword.ItemField
	for _, field := range fields {
		if field.FieldType == onepassword.ItemFieldTypeConcealed {
			concealed = append(concealed, field)
		}
	}
	candidates := fields
	if len(concealed) > 0 {
		candidates = concealed
	}
	if len(candidates) == 1 {
		return &candidates[0], nil
	}
	return nil, fmt.Errorf("ambiguous field %q (%d concealed matches)", key, len(candidates))
}

func consolidateField(item *onepassword.Item, fieldKey, value string) {
	kept := false
	out := item.Fields[:0]
	for _, field := range item.Fields {
		if field.ID == fieldKey {
			if !kept {
				field.Value = value
				out = append(out, field)
				kept = true
			}
			continue
		}
		out = append(out, field)
	}
	if !kept {
		out = append(out, concealedItemField(fieldKey, value))
	}
	item.Fields = out
}

func splitSecretName(name string) (title, field string) {
	if index := strings.LastIndex(name, "/"); index >= 0 {
		return name[:index], name[index+1:]
	}
	return name, FieldServiceClientSecret
}

func concealedItemField(field, value string) onepassword.ItemField {
	return onepassword.ItemField{
		ID:        field,
		Title:     field,
		FieldType: onepassword.ItemFieldTypeConcealed,
		Value:     value,
	}
}
