package secrets

import (
	"context"
	"fmt"
)

const (
	FieldClientSecret         = "client_secret"
	FieldAPIKey               = "api_key"
	FieldTLSCertificate       = "tls_certificate"
	FieldTLSPrivateKey        = "tls_private_key"
	FieldAuthenticationTokens = "authentication_tokens"
	FieldDeviceKey            = "device_key"
)

type Provider interface {
	Name() string
	Store(ctx context.Context, name, body string) (string, error)
	Resolve(ctx context.Context, reference string) (string, error)
	Reference(name string) string
}

type Service struct {
	Application *ApplicationSecrets
	User        *UserSecrets

	providers map[string]Provider
}

func NewService(providers ...Provider) *Service {
	service := &Service{providers: map[string]Provider{}}
	service.Application = &ApplicationSecrets{service: service}
	service.User = &UserSecrets{service: service}
	for _, provider := range providers {
		service.RegisterProvider(provider)
	}
	return service
}

func (s *Service) RegisterProvider(provider Provider) {
	s.providers[provider.Name()] = provider
}

func (s *Service) Store(ctx context.Context, name, body, provider string) (string, error) {
	selected, err := s.provider(provider)
	if err != nil {
		return "", err
	}
	return selected.Store(ctx, name, body)
}

func (s *Service) Resolve(ctx context.Context, reference, provider string) (string, error) {
	selected, err := s.provider(provider)
	if err != nil {
		return "", err
	}
	return selected.Resolve(ctx, reference)
}

func (s *Service) resolveName(ctx context.Context, name, provider string) (string, error) {
	selected, err := s.provider(provider)
	if err != nil {
		return "", err
	}
	return selected.Resolve(ctx, selected.Reference(name))
}

func (s *Service) provider(name string) (Provider, error) {
	provider, ok := s.providers[name]
	if !ok {
		return nil, fmt.Errorf("secret provider %q is not registered", name)
	}
	return provider, nil
}

func applicationSecretName(application, field string) string {
	return application + "/" + field
}

func userSecretName(user, field string) string {
	return "user-" + user + "/" + field
}

type ApplicationSecrets struct {
	service *Service
}

func (a *ApplicationSecrets) StoreServiceClientCredential(ctx context.Context, application, clientID, clientSecret, provider string) (*ClientCredential, error) {
	reference, err := a.service.Store(ctx, applicationSecretName(application, FieldClientSecret), clientSecret, provider)
	if err != nil {
		return nil, err
	}
	return &ClientCredential{ClientID: clientID, ClientSecret: reference, Provider: provider}, nil
}

func (a *ApplicationSecrets) ServiceClientCredential(ctx context.Context, application, clientID, provider string) (*ClientCredential, error) {
	secret, err := a.service.resolveName(ctx, applicationSecretName(application, FieldClientSecret), provider)
	if err != nil {
		return nil, err
	}
	return &ClientCredential{ClientID: clientID, ClientSecret: secret, Provider: provider}, nil
}

func (a *ApplicationSecrets) ResolveServiceClientCredential(ctx context.Context, credential *ClientCredential) (*ClientCredential, error) {
	if credential == nil || credential.ClientID == "" || credential.ClientSecret == "" {
		return nil, fmt.Errorf("service client credential is missing client_id or client_secret")
	}
	secret, err := a.service.Resolve(ctx, credential.ClientSecret, credential.Provider)
	if err != nil {
		return nil, err
	}
	return &ClientCredential{ClientID: credential.ClientID, ClientSecret: secret, Provider: credential.Provider}, nil
}

func (a *ApplicationSecrets) StoreAPIKeyCredential(ctx context.Context, application, key, provider string) (string, error) {
	return a.service.Store(ctx, applicationSecretName(application, FieldAPIKey), key, provider)
}

func (a *ApplicationSecrets) APIKeyCredential(ctx context.Context, application, provider string) (string, error) {
	return a.service.resolveName(ctx, applicationSecretName(application, FieldAPIKey), provider)
}

func (a *ApplicationSecrets) StoreTLSClientCertificate(ctx context.Context, application, certificatePEM, privateKeyPEM, provider string) (*TLSClientCertificate, error) {
	return storeTLSClientCertificate(ctx, a.service, application, certificatePEM, privateKeyPEM, provider)
}

func (a *ApplicationSecrets) TLSClientCertificate(ctx context.Context, application, provider string) (*TLSClientCertificate, error) {
	return resolveTLSClientCertificate(ctx, a.service, application, provider)
}

type UserSecrets struct {
	service *Service
}

func (u *UserSecrets) StoreAuthenticationTokens(ctx context.Context, user, body, provider string) (string, error) {
	return u.service.Store(ctx, userSecretName(user, FieldAuthenticationTokens), body, provider)
}

func (u *UserSecrets) AuthenticationTokens(ctx context.Context, user, provider string) (string, error) {
	return u.service.resolveName(ctx, userSecretName(user, FieldAuthenticationTokens), provider)
}

func (u *UserSecrets) StoreDeviceKey(ctx context.Context, user, body, provider string) (string, error) {
	return u.service.Store(ctx, userSecretName(user, FieldDeviceKey), body, provider)
}

func (u *UserSecrets) DeviceKey(ctx context.Context, user, provider string) (string, error) {
	return u.service.resolveName(ctx, userSecretName(user, FieldDeviceKey), provider)
}

func (u *UserSecrets) StoreClientCertificate(ctx context.Context, user, certificatePEM, privateKeyPEM, provider string) (*TLSClientCertificate, error) {
	return storeTLSClientCertificate(ctx, u.service, "user-"+user, certificatePEM, privateKeyPEM, provider)
}

func (u *UserSecrets) ClientCertificate(ctx context.Context, user, provider string) (*TLSClientCertificate, error) {
	return resolveTLSClientCertificate(ctx, u.service, "user-"+user, provider)
}
