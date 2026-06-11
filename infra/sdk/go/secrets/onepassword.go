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
		updated := false
		for index := range item.Fields {
			if item.Fields[index].ID == field {
				item.Fields[index].Value = body
				updated = true
			}
		}
		if !updated {
			item.Fields = append(item.Fields, concealedItemField(field, body))
		}
		if _, err := client.Items().Put(ctx, item); err != nil {
			return "", fmt.Errorf("update 1password item %s: %w", existing.ID, err)
		}
		p.Logger.Debug("updated 1password item", "vault", p.VaultID, "title", title, "field", field)
		return p.Reference(name), nil
	}

	if _, err := client.Items().Create(ctx, onepassword.ItemCreateParams{
		Category: onepassword.ItemCategoryAPICredentials,
		VaultID:  p.VaultID,
		Title:    title,
		Fields:   []onepassword.ItemField{concealedItemField(field, body)},
	}); err != nil {
		return "", fmt.Errorf("create 1password item %q: %w", title, err)
	}
	p.Logger.Debug("created 1password item", "vault", p.VaultID, "title", title, "field", field)
	return p.Reference(name), nil
}

func (p *OnePassword) Resolve(ctx context.Context, reference string) (string, error) {
	client, err := p.connect(ctx)
	if err != nil {
		return "", err
	}
	secret, err := client.Secrets().Resolve(ctx, reference)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", reference, err)
	}
	return secret, nil
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

func splitSecretName(name string) (title, field string) {
	if index := strings.LastIndex(name, "/"); index >= 0 {
		return name[:index], name[index+1:]
	}
	return name, FieldClientSecret
}

func concealedItemField(field, value string) onepassword.ItemField {
	return onepassword.ItemField{
		ID:        field,
		Title:     field,
		FieldType: onepassword.ItemFieldTypeConcealed,
		Value:     value,
	}
}
