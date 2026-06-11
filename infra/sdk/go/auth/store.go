package auth

import (
	"context"
	"encoding/json"
	"time"

	"jsmunro.me/platy/sdk/secrets"
)

type TokenSet struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token,omitempty"`
	ExpiresAt        int64  `json:"expires_at"`
	RefreshExpiresAt int64  `json:"refresh_expires_at,omitempty"`
}

func (t *TokenSet) Valid(skew time.Duration) bool {
	return t != nil && t.AccessToken != "" && time.Now().Add(skew).Unix() < t.ExpiresAt
}

func (t *TokenSet) Refreshable(skew time.Duration) bool {
	if t == nil || t.RefreshToken == "" {
		return false
	}
	return t.RefreshExpiresAt == 0 || time.Now().Add(skew).Unix() < t.RefreshExpiresAt
}

type TokenStore interface {
	Get(ctx context.Context, key string) *TokenSet
	Put(ctx context.Context, key string, token *TokenSet) error
	Delete(ctx context.Context, key string) error
}

type SecretStore struct {
	Secrets  *secrets.Service
	User     string
	Provider string
}

func (s *SecretStore) read(ctx context.Context) map[string]TokenSet {
	body, err := s.Secrets.User.AuthenticationTokens(ctx, s.User, s.Provider)
	if err != nil {
		return map[string]TokenSet{}
	}
	tokens := map[string]TokenSet{}
	if err := json.Unmarshal([]byte(body), &tokens); err != nil {
		return map[string]TokenSet{}
	}
	return tokens
}

func (s *SecretStore) write(ctx context.Context, tokens map[string]TokenSet) error {
	body, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return err
	}
	_, err = s.Secrets.User.StoreAuthenticationTokens(ctx, s.User, string(body), s.Provider)
	return err
}

func (s *SecretStore) Get(ctx context.Context, key string) *TokenSet {
	tokens := s.read(ctx)
	if token, ok := tokens[key]; ok {
		return &token
	}
	return nil
}

func (s *SecretStore) Put(ctx context.Context, key string, token *TokenSet) error {
	tokens := s.read(ctx)
	tokens[key] = *token
	return s.write(ctx, tokens)
}

func (s *SecretStore) Delete(ctx context.Context, key string) error {
	tokens := s.read(ctx)
	delete(tokens, key)
	return s.write(ctx, tokens)
}
