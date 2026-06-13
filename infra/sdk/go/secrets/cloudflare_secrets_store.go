package secrets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const CloudflareSecretsStoreProvider = "cloudflare_secrets_store"

var ErrSecretsStoreWriteOnly = errors.New(
	"cloudflare secrets store values are write-only; use secrets_store_secrets worker bindings",
)

type CloudflareSecretsStore struct {
	AccountID string
	StoreID   string
	Token     func(ctx context.Context) (string, error)
	Logger    *slog.Logger

	client *http.Client
}

type cfAPIResponse struct {
	Success bool            `json:"success"`
	Errors  []cfAPIError    `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

type cfAPIError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cfStore struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type cfSecret struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (p *CloudflareSecretsStore) Name() string {
	return CloudflareSecretsStoreProvider
}

func (p *CloudflareSecretsStore) Reference(name string) string {
	storeID := strings.TrimSpace(p.StoreID)
	if storeID == "" {
		storeID = "store"
	}
	return CFSSPrefix + storeID + "/" + WorkerSecretNameFromLogical(name)
}

func (p *CloudflareSecretsStore) Store(ctx context.Context, name, body string) (string, error) {
	storeID, err := p.EnsureStore(ctx)
	if err != nil {
		return "", err
	}
	secretName := WorkerSecretNameFromLogical(name)
	if err := p.Upsert(ctx, storeID, secretName, body); err != nil {
		return "", err
	}
	if p.Logger != nil {
		p.Logger.Debug("stored cloudflare secrets store secret", "name", secretName)
	}
	return CFSSPrefix + storeID + "/" + secretName, nil
}

func (p *CloudflareSecretsStore) Resolve(ctx context.Context, reference string) (string, error) {
	if strings.HasPrefix(strings.TrimSpace(reference), CFSSPrefix) {
		return "", ErrSecretsStoreWriteOnly
	}
	return "", fmt.Errorf("cloudflare secrets store cannot resolve %q", reference)
}

func (p *CloudflareSecretsStore) EnsureStore(ctx context.Context) (string, error) {
	if storeID := strings.TrimSpace(p.StoreID); storeID != "" {
		return storeID, nil
	}
	if strings.TrimSpace(p.AccountID) == "" {
		return "", fmt.Errorf("cloudflare secrets store account id is required")
	}
	stores, err := p.listStores(ctx)
	if err != nil {
		return "", err
	}
	for _, store := range stores {
		if store.Name == "platy" || store.Name == "default_secrets_store" {
			p.StoreID = store.ID
			return store.ID, nil
		}
	}
	if len(stores) > 0 {
		p.StoreID = stores[0].ID
		return stores[0].ID, nil
	}
	created, err := p.createStore(ctx, "platy")
	if err != nil {
		return "", err
	}
	p.StoreID = created.ID
	if p.Logger != nil {
		p.Logger.Info("created cloudflare secrets store", "store_id", created.ID, "name", created.Name)
	}
	return created.ID, nil
}

func (p *CloudflareSecretsStore) Upsert(ctx context.Context, storeID, secretName, value string) error {
	storeID = strings.TrimSpace(storeID)
	secretName = strings.TrimSpace(secretName)
	if storeID == "" || secretName == "" {
		return fmt.Errorf("store id and secret name are required")
	}
	existing, err := p.findSecret(ctx, storeID, secretName)
	if err != nil {
		return err
	}
	if existing == nil {
		return p.createSecret(ctx, storeID, secretName, value)
	}
	return p.updateSecret(ctx, storeID, existing.ID, secretName, value)
}

func (p *CloudflareSecretsStore) listStores(ctx context.Context) ([]cfStore, error) {
	path := fmt.Sprintf("/accounts/%s/secrets_store/stores", p.AccountID)
	body, err := p.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var stores []cfStore
	if err := json.Unmarshal(body, &stores); err != nil {
		return nil, fmt.Errorf("decode secrets store list: %w", err)
	}
	return stores, nil
}

func (p *CloudflareSecretsStore) createStore(ctx context.Context, name string) (*cfStore, error) {
	path := fmt.Sprintf("/accounts/%s/secrets_store/stores", p.AccountID)
	body, err := p.request(ctx, http.MethodPost, path, map[string]string{"name": name})
	if err != nil {
		return nil, err
	}
	store := &cfStore{}
	if err := json.Unmarshal(body, store); err != nil {
		return nil, fmt.Errorf("decode secrets store create: %w", err)
	}
	return store, nil
}

func (p *CloudflareSecretsStore) findSecret(ctx context.Context, storeID, secretName string) (*cfSecret, error) {
	path := fmt.Sprintf(
		"/accounts/%s/secrets_store/stores/%s/secrets?search=%s&per_page=50",
		p.AccountID,
		storeID,
		secretName,
	)
	body, err := p.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var secrets []cfSecret
	if err := json.Unmarshal(body, &secrets); err != nil {
		return nil, fmt.Errorf("decode secrets store secrets: %w", err)
	}
	for _, secret := range secrets {
		if secret.Name == secretName {
			return &secret, nil
		}
	}
	return nil, nil
}

func (p *CloudflareSecretsStore) createSecret(ctx context.Context, storeID, secretName, value string) error {
	path := fmt.Sprintf("/accounts/%s/secrets_store/stores/%s/secrets", p.AccountID, storeID)
	_, err := p.request(ctx, http.MethodPost, path, []map[string]any{
		{
			"name":    secretName,
			"value":   value,
			"scopes":  []string{"workers"},
			"comment": "managed by platy",
		},
	})
	return err
}

func (p *CloudflareSecretsStore) updateSecret(ctx context.Context, storeID, secretID, secretName, value string) error {
	path := fmt.Sprintf("/accounts/%s/secrets_store/stores/%s/secrets/%s", p.AccountID, storeID, secretID)
	_, err := p.request(ctx, http.MethodPatch, path, map[string]any{
		"value":   value,
		"scopes":  []string{"workers"},
		"comment": "managed by platy",
		"name":    secretName,
	})
	return err
}

func (p *CloudflareSecretsStore) httpClient() *http.Client {
	if p.client != nil {
		return p.client
	}
	p.client = &http.Client{Timeout: 60 * time.Second}
	return p.client
}

func (p *CloudflareSecretsStore) request(ctx context.Context, method, path string, payload any) (json.RawMessage, error) {
	token, err := p.Token(ctx)
	if err != nil {
		return nil, err
	}
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("encode secrets store request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, "https://api.cloudflare.com/client/v4"+path, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := p.httpClient().Do(request)
	if err != nil {
		return nil, fmt.Errorf("secrets store api %s %s: %w", method, path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read secrets store response: %w", err)
	}
	var decoded cfAPIResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("decode secrets store response: %w", err)
	}
	if !decoded.Success {
		messages := make([]string, 0, len(decoded.Errors))
		for _, item := range decoded.Errors {
			messages = append(messages, item.Message)
		}
		if len(messages) == 0 {
			messages = append(messages, string(raw))
		}
		return nil, fmt.Errorf("secrets store api %s %s failed: %s", method, path, strings.Join(messages, "; "))
	}
	return decoded.Result, nil
}
