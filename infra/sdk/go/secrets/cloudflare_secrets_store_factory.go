package secrets

import (
	"context"
	"fmt"
	"log/slog"
)

type CloudflareSecretsStoreFactory struct {
	AccountID string
	StoreID   string
	Token     func(ctx context.Context) (string, error)
	Logger    *slog.Logger
}

func (f *CloudflareSecretsStoreFactory) Provider() *CloudflareSecretsStore {
	return &CloudflareSecretsStore{
		AccountID: f.AccountID,
		StoreID:   f.StoreID,
		Token:     f.Token,
		Logger:    f.Logger,
	}
}

func (f *CloudflareSecretsStoreFactory) EnsureStore(ctx context.Context) (string, error) {
	storeID, err := f.Provider().EnsureStore(ctx)
	if err != nil {
		return "", err
	}
	f.StoreID = storeID
	return storeID, nil
}

func (f *CloudflareSecretsStoreFactory) SyncWorkerSecret(
	ctx context.Context,
	application, envKey, value string,
) (string, error) {
	storeID, err := f.EnsureStore(ctx)
	if err != nil {
		return "", err
	}
	secretName := WorkerSecretName(application, envKey)
	if err := f.Provider().Upsert(ctx, storeID, secretName, value); err != nil {
		return "", fmt.Errorf("sync %s: %w", secretName, err)
	}
	return CFSSPrefix + storeID + "/" + secretName, nil
}
