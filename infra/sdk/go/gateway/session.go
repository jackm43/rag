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
	"jsmunro.me/platy/sdk/auth"
	"jsmunro.me/platy/sdk/discovery"
	"jsmunro.me/platy/sdk/dpop"
)

const (
	TokenTypeAccessToken       = "urn:ietf:params:oauth:token-type:access_token"
	TokenTypeJwt               = "urn:ietf:params:oauth:token-type:jwt"
	TokenTypeServiceCredential = "urn:platy:params:oauth:token-type:service-credential"

	identityServicePath = "/idp.v1.IdentityService/"
)

type Session struct {
	GatewayURL string
	Store      auth.TokenStore
	Local      *discovery.ApplicationDiscoveryService
	Dpop       *dpop.Key
	HTTPClient *http.Client
	Logger     *slog.Logger

	mu        sync.Mutex
	discovery *discovery.Document
	appTokens map[string]*auth.TokenSet
}

func NewSession(gatewayURL string, store auth.TokenStore, logger *slog.Logger) *Session {
	return &Session{
		GatewayURL: strings.TrimRight(gatewayURL, "/"),
		Store:      store,
		HTTPClient: http.DefaultClient,
		Logger:     logger,
		appTokens:  map[string]*auth.TokenSet{},
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
	if s.Local != nil {
		if err := s.Local.Sync(document, s.GatewayURL); err != nil {
			s.logger().Debug("failed to sync local application documents", "error", err)
		}
	}
	return document, nil
}

func (s *Session) oidcFlow(ctx context.Context) (*auth.BrowserFlow, error) {
	discovered, err := s.Discovery(ctx)
	if err != nil {
		return nil, err
	}
	if discovered.Oidc.ClientID == "" {
		return nil, fmt.Errorf("gateway has no OIDC provider configured")
	}
	return &auth.BrowserFlow{
		Config: oauth2.Config{
			ClientID: discovered.Oidc.ClientID,
			Endpoint: oauth2.Endpoint{
				AuthURL:  discovered.Oidc.AuthorizationEndpoint,
				TokenURL: discovered.Oidc.TokenEndpoint,
			},
			Scopes: []string{"openid", "email", "profile"},
		},
		Logger: s.logger(),
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

func tokenSetFromSession(tokens *idpv1.SessionTokens) *auth.TokenSet {
	now := time.Now().Unix()
	return &auth.TokenSet{
		AccessToken:      tokens.AccessToken,
		RefreshToken:     tokens.RefreshToken,
		ExpiresAt:        now + tokens.ExpiresIn,
		RefreshExpiresAt: now + tokens.RefreshExpiresIn,
	}
}

func (s *Session) createSession(ctx context.Context, subjectToken string) (*auth.TokenSet, error) {
	request := connect.NewRequest(&idpv1.CreateSessionRequest{
		SubjectToken:     subjectToken,
		SubjectTokenType: TokenTypeAccessToken,
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

func (s *Session) refreshSession(ctx context.Context, refreshToken string) (*auth.TokenSet, error) {
	request := connect.NewRequest(&idpv1.RefreshSessionRequest{RefreshToken: refreshToken})
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

func (s *Session) login(ctx context.Context) (*auth.TokenSet, error) {
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
	cached := s.Store.Get(ctx, s.userTokenKey())
	if cached != nil && cached.RefreshToken != "" {
		request := connect.NewRequest(&idpv1.RevokeSessionRequest{RefreshToken: cached.RefreshToken})
		if _, err := s.IdentityClient().RevokeSession(ctx, request); err != nil {
			s.logger().Debug("session revocation failed", "error", err)
		}
	}
	return s.Store.Delete(ctx, s.userTokenKey())
}

func (s *Session) IdentityClient() idpv1connect.IdentityServiceClient {
	return idpv1connect.NewIdentityServiceClient(s.HTTPClient, s.GatewayURL)
}

func (s *Session) WhoAmI(ctx context.Context) (*idpv1.WhoAmIResponse, error) {
	client := idpv1connect.NewIdentityServiceClient(
		s.HTTPClient,
		s.GatewayURL,
		connect.WithInterceptors(s.UserAuthInterceptor()),
	)
	response, err := client.WhoAmI(ctx, connect.NewRequest(&idpv1.WhoAmIRequest{}))
	if err != nil {
		return nil, err
	}
	return response.Msg, nil
}

func (s *Session) RegistryClient() idpv1connect.RegistryServiceClient {
	return idpv1connect.NewRegistryServiceClient(s.HTTPClient, s.GatewayURL, connect.WithInterceptors(s.UserAuthInterceptor()))
}

func (s *Session) AppToken(ctx context.Context, audience string) (string, error) {
	s.mu.Lock()
	cached := s.appTokens[audience]
	s.mu.Unlock()
	if cached.Valid(15 * time.Second) {
		return cached.AccessToken, nil
	}

	subjectToken, err := s.UserToken(ctx, false)
	if err != nil {
		return "", err
	}
	request := connect.NewRequest(&idpv1.ExchangeTokenRequest{
		SubjectToken:       subjectToken,
		SubjectTokenType:   TokenTypeJwt,
		Audience:           audience,
		RequestedTokenType: TokenTypeJwt,
	})
	if err := s.attachDpop(request.Header(), identityServicePath+"ExchangeToken"); err != nil {
		return "", err
	}
	response, err := s.IdentityClient().ExchangeToken(ctx, request)
	if err != nil {
		return "", fmt.Errorf("token exchange for %s: %w", audience, err)
	}

	token := &auth.TokenSet{
		AccessToken: response.Msg.AccessToken,
		ExpiresAt:   time.Now().Unix() + response.Msg.ExpiresIn,
	}
	s.mu.Lock()
	s.appTokens[audience] = token
	s.mu.Unlock()
	s.logger().Debug("exchanged app token", "audience", audience, "expires_in", response.Msg.ExpiresIn)
	return token.AccessToken, nil
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

func (s *Session) Application(ctx context.Context, name string) (*discovery.Application, error) {
	if s.Local != nil {
		if app, err := s.Local.Application(name); err == nil {
			return app, nil
		}
	}
	discovered, err := s.Discovery(ctx)
	if err != nil {
		return nil, err
	}
	return discovered.Application(name)
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
