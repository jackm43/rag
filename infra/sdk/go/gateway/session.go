package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/oauth2"

	idpv1 "jsmunro.me/platy/applications/idp/client/idp/v1"
	"jsmunro.me/platy/applications/idp/client/idp/v1/idpv1connect"
	oauthv1 "jsmunro.me/platy/applications/idp/client/platy/oauth/v1"
	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/httpclient"
	"jsmunro.me/platy/sdk/identity"
	oauthclient "jsmunro.me/platy/sdk/oauth2/client"
	"jsmunro.me/platy/sdk/oauth2/client/dpop"
	"jsmunro.me/platy/sdk/oauth2/token"
	"jsmunro.me/platy/sdk/secrets"
)

const identityServicePath = "/idp.v1.IdentityService/"

type CredentialResolver func(ctx context.Context, application string) (*secrets.ClientCredential, error)

type Session struct {
	GatewayURL         string
	Store              oauthclient.TokenStore
	Dpop               *dpop.Key
	HTTPClient         *http.Client
	Logger             *slog.Logger
	RotateDeviceKey    func(context.Context) (*dpop.Key, error)
	CredentialResolver CredentialResolver

	mu              sync.Mutex
	discovery       *discovery.Document
	discoveryClient *discovery.Client
	appTokens       map[string]*oauthclient.TokenSet
}

func NewSession(gatewayURL string, store oauthclient.TokenStore, logger *slog.Logger) *Session {
	return &Session{
		GatewayURL: strings.TrimRight(gatewayURL, "/"),
		Store:      store,
		HTTPClient: httpclient.Default(),
		Logger:     logger,
		appTokens:  map[string]*oauthclient.TokenSet{},
	}
}

func (s *Session) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func (s *Session) Discovery(ctx context.Context) (*discovery.Document, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.discovery != nil {
		return s.discovery, nil
	}
	document, err := discovery.Fetch(ctx, s.HTTPClient, s.GatewayURL)
	if err != nil {
		return nil, err
	}
	s.discovery = document
	return document, nil
}

func (s *Session) InvalidateDiscovery() {
	s.mu.Lock()
	s.discovery = nil
	if s.discoveryClient != nil {
		s.discoveryClient.Invalidate()
	}
	s.mu.Unlock()
}

func (s *Session) oidcFlow(ctx context.Context) (*oauthclient.BrowserFlow, error) {
	discovered, err := s.Discovery(ctx)
	if err != nil {
		return nil, err
	}
	if discovered.Oidc.ClientID == "" {
		return nil, fmt.Errorf("gateway has no OIDC provider configured")
	}
	return &oauthclient.BrowserFlow{
		Config: oauth2.Config{
			ClientID: discovered.Oidc.ClientID,
			Endpoint: oauth2.Endpoint{
				AuthURL:  discovered.Oidc.AuthorizationEndpoint,
				TokenURL: discovered.Oidc.TokenEndpoint,
			},
			Scopes: []string{"openid", "email", "profile"},
		},
		Logger:     s.logger(),
		HTTPClient: s.HTTPClient,
	}, nil
}

func (s *Session) userTokenKey() string {
	return "session|" + s.GatewayURL
}

func (s *Session) dpopProof(procedure string) (string, error) {
	if s.Dpop == nil {
		return "", fmt.Errorf("session has no device key for DPoP proofs")
	}
	return s.Dpop.Proof(http.MethodPost, s.GatewayURL+procedure)
}

func (s *Session) attachDpop(header http.Header, procedure string) error {
	proof, err := s.dpopProof(procedure)
	if err != nil {
		return err
	}
	header.Set(dpop.Header, proof)
	return nil
}

func tokenSetFromSession(tokens *oauthv1.SessionTokens) *oauthclient.TokenSet {
	now := time.Now().Unix()
	return &oauthclient.TokenSet{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		ExpiresAt:        now + tokens.ExpiresIn,
		RefreshExpiresAt: now + tokens.RefreshExpiresIn,
	}
}

func (s *Session) createSession(ctx context.Context, subjectToken string) (*oauthclient.TokenSet, error) {
	request := connect.NewRequest(&oauthv1.CreateSessionRequest{
		SubjectToken:     subjectToken,
		SubjectTokenType: token.TypeAccessToken,
	})
	if err := s.attachDpop(request.Header(), identityServicePath+"CreateSession"); err != nil {
		return nil, err
	}
	response, err := s.IdentityClient().CreateSession(ctx, request)
	if err != nil {
		return nil, fmt.Errorf("create gateway session: %w", err)
	}
	if response.Msg.Tokens == nil {
		return nil, fmt.Errorf("gateway returned no session tokens")
	}
	return tokenSetFromSession(response.Msg.Tokens), nil
}

func (s *Session) refreshSession(ctx context.Context, refreshToken string) (*oauthclient.TokenSet, error) {
	request := connect.NewRequest(&oauthv1.RefreshSessionRequest{RefreshToken: refreshToken})
	if err := s.attachDpop(request.Header(), identityServicePath+"RefreshSession"); err != nil {
		return nil, err
	}
	response, err := s.IdentityClient().RefreshSession(ctx, request)
	if err != nil {
		return nil, fmt.Errorf("refresh gateway session: %w", err)
	}
	if response.Msg.Tokens == nil {
		return nil, fmt.Errorf("gateway returned no session tokens")
	}
	return tokenSetFromSession(response.Msg.Tokens), nil
}

func (s *Session) revokeCachedSession(ctx context.Context) {
	cached := s.Store.Get(ctx, s.userTokenKey())
	if cached != nil && cached.RefreshToken != "" {
		request := connect.NewRequest(&oauthv1.RevokeSessionRequest{RefreshToken: cached.RefreshToken})
		if _, err := s.IdentityClient().RevokeSession(ctx, request); err != nil {
			s.logger().Debug("session revocation failed", "error", err)
		} else {
			s.logger().Info("revoked previous gateway session")
		}
	}
	if err := s.Store.Delete(ctx, s.userTokenKey()); err != nil {
		s.logger().Debug("clear cached session tokens failed", "error", err)
	}
	s.mu.Lock()
	s.appTokens = map[string]*oauthclient.TokenSet{}
	s.mu.Unlock()
}

func (s *Session) login(ctx context.Context) (*oauthclient.TokenSet, error) {
	s.revokeCachedSession(ctx)
	if s.RotateDeviceKey != nil {
		key, err := s.RotateDeviceKey(ctx)
		if err != nil {
			return nil, fmt.Errorf("rotate device key: %w", err)
		}
		s.Dpop = key
	}
	flow, err := s.oidcFlow(ctx)
	if err != nil {
		return nil, err
	}
	upstream, err := flow.Login(ctx)
	if err != nil {
		return nil, err
	}
	tokens, err := s.createSession(ctx, upstream.AccessToken)
	if err != nil {
		return nil, err
	}
	if err := s.Store.Put(ctx, s.userTokenKey(), tokens); err != nil {
		return nil, err
	}
	return tokens, nil
}

func (s *Session) UserToken(ctx context.Context, forceLogin bool) (string, error) {
	if !forceLogin {
		cached := s.Store.Get(ctx, s.userTokenKey())
		if cached.Valid(30 * time.Second) {
			return cached.AccessToken, nil
		}
		if cached.Refreshable(30 * time.Second) {
			refreshed, err := s.refreshSession(ctx, cached.RefreshToken)
			if err == nil {
				if err := s.Store.Put(ctx, s.userTokenKey(), refreshed); err != nil {
					return "", err
				}
				return refreshed.AccessToken, nil
			}
			s.logger().Debug("session refresh failed, starting browser login", "error", err)
		}
	}
	tokens, err := s.login(ctx)
	if err != nil {
		return "", err
	}
	return tokens.AccessToken, nil
}

func (s *Session) Logout(ctx context.Context) error {
	s.revokeCachedSession(ctx)
	return nil
}

func (s *Session) IdentityClient() idpv1connect.IdentityServiceClient {
	return idpv1connect.NewIdentityServiceClient(s.HTTPClient, s.GatewayURL)
}

func (s *Session) Introspect(ctx context.Context) (*idpv1.IntrospectResponse, error) {
	var interceptor connect.Interceptor
	if actor := impersonate(ctx); actor != "" {
		interceptor = &tokenInterceptor{token: func(ctx context.Context) (string, error) {
			return s.ChainedAppToken(ctx, actor, "idp", nil)
		}}
	} else {
		interceptor = s.UserAuthInterceptor()
	}
	client := idpv1connect.NewIdentityServiceClient(
		s.HTTPClient,
		s.GatewayURL,
		connect.WithInterceptors(interceptor),
	)
	response, err := client.Introspect(ctx, connect.NewRequest(&idpv1.IntrospectRequest{}))
	if err != nil {
		return nil, err
	}
	return response.Msg, nil
}

func (s *Session) RegistryClient() idpv1connect.RegistryServiceClient {
	return idpv1connect.NewRegistryServiceClient(s.HTTPClient, s.GatewayURL, connect.WithInterceptors(s.UserAuthInterceptor()))
}

func (s *Session) AppToken(ctx context.Context, audience string) (string, error) {
	if service := impersonate(ctx); service != "" {
		return s.ChainedAppToken(ctx, service, audience, nil)
	}
	return s.directAppToken(ctx, audience)
}

func (s *Session) directAppToken(ctx context.Context, audience string) (string, error) {
	cacheKey := audience
	s.mu.Lock()
	cached := s.appTokens[cacheKey]
	s.mu.Unlock()
	if cached.Valid(15 * time.Second) {
		return cached.AccessToken, nil
	}

	subjectToken, err := s.UserToken(ctx, false)
	if err != nil {
		return "", err
	}
	token, err := s.exchangeToken(ctx, subjectToken, token.TypeJWT, "", "", audience, nil, "", false)
	if err != nil {
		return "", fmt.Errorf("token exchange for %s: %w", audience, err)
	}
	s.mu.Lock()
	s.appTokens[cacheKey] = token
	s.mu.Unlock()
	s.logger().Debug("exchanged app token", "audience", audience, "expires_in", token.ExpiresAt-time.Now().Unix())
	return token.AccessToken, nil
}

func (s *Session) ChainedAppToken(ctx context.Context, serviceApp, audience string, scopes []string) (string, error) {
	if s.CredentialResolver == nil {
		return "", fmt.Errorf("service impersonation requires a credential resolver")
	}
	cacheKey := "chain:" + serviceApp + ":" + audience
	s.mu.Lock()
	cached := s.appTokens[cacheKey]
	s.mu.Unlock()
	if cached.Valid(15 * time.Second) {
		return cached.AccessToken, nil
	}
	impersonationToken, err := s.ImpersonationToken(ctx, serviceApp, false)
	if err != nil {
		return "", err
	}
	actor, err := s.Application(ctx, serviceApp)
	if err != nil {
		return "", err
	}
	subjectAudience := actor.Audience
	if subjectAudience == "" {
		subjectAudience = serviceApp
	}
	subjectToken, err := s.directAppToken(ctx, subjectAudience)
	if err != nil {
		return "", fmt.Errorf("subject token for %s: %w", serviceApp, err)
	}
	credential, err := s.CredentialResolver(ctx, serviceApp)
	if err != nil {
		return "", fmt.Errorf("resolve %s service credential: %w", serviceApp, err)
	}
	token, err := s.exchangeToken(
		ctx,
		subjectToken,
		token.TypeJWT,
		credential.ActorToken(),
		token.TypeServiceCredential,
		audience,
		scopes,
		impersonationToken,
		true,
	)
	if err != nil {
		return "", fmt.Errorf("chained token exchange as %s for %s: %w", serviceApp, audience, err)
	}
	s.mu.Lock()
	s.appTokens[cacheKey] = token
	s.mu.Unlock()
	s.logger().Debug("exchanged chained app token", "service", serviceApp, "audience", audience)
	return token.AccessToken, nil
}

func (s *Session) ServiceAppToken(ctx context.Context, serviceApp, audience string, scopes []string) (string, error) {
	if s.CredentialResolver == nil {
		return "", fmt.Errorf("service authentication requires a credential resolver")
	}
	cacheKey := "svc:" + serviceApp + ":" + audience
	s.mu.Lock()
	cached := s.appTokens[cacheKey]
	s.mu.Unlock()
	if cached.Valid(15 * time.Second) {
		return cached.AccessToken, nil
	}
	credential, err := s.CredentialResolver(ctx, serviceApp)
	if err != nil {
		return "", fmt.Errorf("resolve %s service credential: %w", serviceApp, err)
	}
	token, err := s.exchangeToken(
		ctx,
		credential.ActorToken(),
		token.TypeServiceCredential,
		"",
		"",
		audience,
		scopes,
		"",
		false,
	)
	if err != nil {
		return "", fmt.Errorf("service token exchange for %s as %s: %w", audience, serviceApp, err)
	}
	s.mu.Lock()
	s.appTokens[cacheKey] = token
	s.mu.Unlock()
	s.logger().Debug("exchanged service app token", "service", serviceApp, "audience", audience)
	return token.AccessToken, nil
}

func (s *Session) authenticatedIdentityClient() idpv1connect.IdentityServiceClient {
	return idpv1connect.NewIdentityServiceClient(
		s.HTTPClient,
		s.GatewayURL,
		connect.WithInterceptors(s.UserAuthInterceptor()),
	)
}

func (s *Session) exchangeToken(
	ctx context.Context,
	subjectToken, subjectTokenType, actorToken, actorTokenType, audience string,
	scopes []string,
	impersonationToken string,
	authenticated bool,
) (*oauthclient.TokenSet, error) {
	request := connect.NewRequest(&oauthv1.TokenExchangeRequest{
		SubjectToken:           subjectToken,
		SubjectTokenType:       subjectTokenType,
		ActorToken:             actorToken,
		ActorTokenType:         actorTokenType,
		Audience:               audience,
		Scopes:                 scopes,
		RequestedTokenType:     token.TypeJWT,
		ImpersonationToken:     impersonationToken,
		ImpersonationTokenType: token.TypeAccessToken,
	})
	if authenticated {
		if err := s.attachDpop(request.Header(), identityServicePath+"ExchangeToken"); err != nil {
			return nil, err
		}
		userToken, err := s.UserToken(ctx, false)
		if err != nil {
			return nil, err
		}
		request.Header().Set("Authorization", "Bearer "+userToken)
	} else if subjectTokenType == token.TypeJWT && actorToken == "" {
		if err := s.attachDpop(request.Header(), identityServicePath+"ExchangeToken"); err != nil {
			return nil, err
		}
	}
	client := s.IdentityClient()
	if authenticated {
		client = s.authenticatedIdentityClient()
	}
	// Identity-boundary standard: every identity change is logged at the
	// client that makes it; only the actor's client id is logged, never the
	// secret.
	actorClientID := ""
	if actorToken != "" {
		actorClientID, _, _ = strings.Cut(actorToken, ":")
	}
	impersonation := impersonationToken != ""
	logActorTokenType := actorTokenType
	if actorToken != "" && logActorTokenType == "" {
		logActorTokenType = token.TypeServiceCredential
	}
	response, err := client.ExchangeToken(ctx, request)
	if err != nil {
		s.logger().Warn("identity_exchange_refused",
			identity.ExchangeRefusedLog(
				audience, subjectTokenType, logActorTokenType, actorClientID, err.Error(), impersonation, nil,
			)...,
		)
		return nil, err
	}
	s.logger().Info("identity_exchanged",
		identity.ExchangedLog(
			audience, subjectTokenType, logActorTokenType, actorClientID, impersonation, nil, response.Msg.Scopes,
		)...,
	)
	return &oauthclient.TokenSet{
		AccessToken: response.Msg.AccessToken,
		ExpiresAt:   time.Now().Unix() + response.Msg.ExpiresIn,
	}, nil
}

type gatewayInterceptor struct {
	session *Session
}

func (i *gatewayInterceptor) decorate(ctx context.Context, header http.Header, procedure string) error {
	token, err := i.session.UserToken(ctx, false)
	if err != nil {
		return err
	}
	header.Set("Authorization", "Bearer "+token)
	return i.session.attachDpop(header, procedure)
}

func (i *gatewayInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if err := i.decorate(ctx, request.Header(), request.Spec().Procedure); err != nil {
			return nil, err
		}
		return next(ctx, request)
	}
}

func (i *gatewayInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		if err := i.decorate(ctx, conn.RequestHeader(), spec.Procedure); err != nil {
			i.session.logger().Debug("failed to decorate streaming request", "error", err)
		}
		return conn
	}
}

func (i *gatewayInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

type tokenInterceptor struct {
	token func(ctx context.Context) (string, error)
}

func (i *tokenInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		token, err := i.token(ctx)
		if err != nil {
			return nil, err
		}
		request.Header().Set("Authorization", "Bearer "+token)
		return next(ctx, request)
	}
}

func (i *tokenInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		if token, err := i.token(ctx); err == nil {
			conn.RequestHeader().Set("Authorization", "Bearer "+token)
		}
		return conn
	}
}

func (i *tokenInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func (s *Session) AppAuthInterceptor(audience string) connect.Interceptor {
	return &tokenInterceptor{token: func(ctx context.Context) (string, error) {
		return s.AppToken(ctx, audience)
	}}
}

func (s *Session) UserAuthInterceptor() connect.Interceptor {
	return &gatewayInterceptor{session: s}
}

// DiscoveryClient returns the GraphQL discovery client for the registered
// discovery application, resolving its endpoint from the gateway bootstrap
// document and authenticating with an STS token for the discovery audience.
func (s *Session) DiscoveryClient(ctx context.Context) (*discovery.Client, error) {
	document, err := s.Discovery(ctx)
	if err != nil {
		return nil, err
	}
	app, err := document.Application("discovery")
	if err != nil {
		return nil, err
	}
	if app.Endpoint == "" {
		return nil, fmt.Errorf("discovery application has no endpoint registered")
	}
	audience := app.Audience
	if audience == "" {
		audience = "discovery"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.discoveryClient != nil && s.discoveryClient.Endpoint == strings.TrimRight(app.Endpoint, "/") {
		return s.discoveryClient, nil
	}
	client := discovery.NewClient(app.Endpoint, func(ctx context.Context) (string, error) {
		return s.directAppToken(ctx, audience)
	})
	client.HTTPClient = s.HTTPClient
	client.Logger = s.logger()
	s.discoveryClient = client
	return client, nil
}

// Application resolves one application's metadata, preferring the GraphQL
// discovery read model and falling back to the gateway bootstrap document
// when the discovery application is unreachable or not yet registered.
func (s *Session) Application(ctx context.Context, name string) (*discovery.Application, error) {
	document, err := s.Discovery(ctx)
	if err != nil {
		return nil, err
	}
	fallback, fallbackErr := document.Application(name)
	client, err := s.DiscoveryClient(ctx)
	if err != nil {
		s.logger().Debug("graphql discovery unavailable; using gateway discovery document", "error", err)
		return fallback, fallbackErr
	}
	app, err := client.Application(ctx, name)
	if err != nil {
		if fallbackErr == nil {
			s.logger().Warn("graphql discovery failed; using gateway discovery document", "application", name, "error", err)
			return fallback, nil
		}
		return nil, err
	}
	app.GatewayURL = s.GatewayURL
	if fallbackErr == nil && app.ImpersonationAccessClientID == "" {
		app.ImpersonationAccessClientID = fallback.ImpersonationAccessClientID
	}
	return app, nil
}

// Applications lists every registered application, preferring the GraphQL
// discovery read model with the same fallback as Application.
func (s *Session) Applications(ctx context.Context) ([]*discovery.Application, error) {
	document, err := s.Discovery(ctx)
	if err != nil {
		return nil, err
	}
	fallback := func() []*discovery.Application {
		apps := make([]*discovery.Application, 0, len(document.Applications))
		for index := range document.Applications {
			app := document.Applications[index]
			app.GatewayURL = s.GatewayURL
			apps = append(apps, &app)
		}
		return apps
	}
	client, err := s.DiscoveryClient(ctx)
	if err != nil {
		s.logger().Debug("graphql discovery unavailable; using gateway discovery document", "error", err)
		return fallback(), nil
	}
	apps, err := client.ListApplications(ctx)
	if err != nil {
		s.logger().Warn("graphql discovery failed; using gateway discovery document", "error", err)
		return fallback(), nil
	}
	for _, app := range apps {
		app.GatewayURL = s.GatewayURL
	}
	return apps, nil
}

// SyncDiscovery asks the discovery application to re-ingest the gateway
// registry.
func (s *Session) SyncDiscovery(ctx context.Context) (*discovery.SyncState, error) {
	client, err := s.DiscoveryClient(ctx)
	if err != nil {
		return nil, err
	}
	return client.Sync(ctx)
}

func (s *Session) AppEndpoint(ctx context.Context, name string) (string, error) {
	app, err := s.Application(ctx, name)
	if err != nil {
		return "", err
	}
	if app.Endpoint == "" {
		return "", fmt.Errorf("application %s has no endpoint registered", name)
	}
	return strings.TrimRight(app.Endpoint, "/"), nil
}
