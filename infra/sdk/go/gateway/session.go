package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"

	"jsmunro.me/platy/sdk/apps/discovery"
	"jsmunro.me/platy/sdk/httpclient"
	"jsmunro.me/platy/sdk/identity"
	"jsmunro.me/platy/sdk/oauth2/oauthclient"
	"jsmunro.me/platy/sdk/oauth2/oauthclient/dpop"
	"jsmunro.me/platy/sdk/oauth2/token"
	"jsmunro.me/platy/sdk/secrets"
)

type CredentialResolver func(ctx context.Context, application string) (*secrets.ClientCredential, error)

type Session struct {
	gatewayURL         string
	store              oauthclient.TokenStore
	deviceKey          *dpop.Key
	httpClient         *http.Client
	log                *slog.Logger
	rotateDeviceKey    func(context.Context) (*dpop.Key, error)
	credentialResolver CredentialResolver

	mu              sync.Mutex
	bootstrap       *discovery.BootstrapDocument
	discovery       *discovery.Document
	discoveryClient *discovery.Client
	appTokens       map[string]*oauthclient.TokenSet
}

// Option configures a Session at construction. The session is fully built by
// NewSession; callers no longer reach in and mutate fields afterwards.
type Option func(*Session)

// WithLogger sets the structured logger.
func WithLogger(logger *slog.Logger) Option {
	return func(s *Session) { s.log = logger }
}

// WithHTTPClient overrides the default trust-aware HTTP client.
func WithHTTPClient(client *http.Client) Option {
	return func(s *Session) {
		if client != nil {
			s.httpClient = client
		}
	}
}

// WithDeviceKey binds a device DPoP key and an optional rotation function used
// when the gateway forces re-binding.
func WithDeviceKey(key *dpop.Key, rotate func(context.Context) (*dpop.Key, error)) Option {
	return func(s *Session) {
		s.deviceKey = key
		s.rotateDeviceKey = rotate
	}
}

// WithCredentialResolver supplies the service-credential lookup used for
// chained and service-only token exchanges.
func WithCredentialResolver(resolver CredentialResolver) Option {
	return func(s *Session) { s.credentialResolver = resolver }
}

func NewSession(gatewayURL string, store oauthclient.TokenStore, opts ...Option) *Session {
	s := &Session{
		gatewayURL: strings.TrimRight(gatewayURL, "/"),
		store:      store,
		httpClient: httpclient.Default(),
		appTokens:  map[string]*oauthclient.TokenSet{},
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// GatewayURL is the normalized gateway base URL this session talks to.
func (s *Session) GatewayURL() string { return s.gatewayURL }

func (s *Session) logger() *slog.Logger {
	if s.log != nil {
		return s.log
	}
	return slog.Default()
}

func (s *Session) Bootstrap(ctx context.Context) (*discovery.BootstrapDocument, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bootstrap != nil {
		return s.bootstrap, nil
	}
	document, err := discovery.FetchBootstrap(ctx, s.httpClient, s.gatewayURL)
	if err != nil {
		return nil, err
	}
	s.bootstrap = document
	return document, nil
}

func (s *Session) Discovery(ctx context.Context) (*discovery.Document, error) {
	s.mu.Lock()
	if s.discovery != nil {
		document := s.discovery
		s.mu.Unlock()
		return document, nil
	}
	s.mu.Unlock()
	document, err := s.fetchDiscover(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.discovery = document
	s.mu.Unlock()
	return document, nil
}

func (s *Session) fetchDiscover(ctx context.Context) (*discovery.Document, error) {
	return s.fetchDiscoverHTTP(ctx)
}

func (s *Session) InvalidateDiscovery() {
	s.mu.Lock()
	s.bootstrap = nil
	s.discovery = nil
	if s.discoveryClient != nil {
		s.discoveryClient.Invalidate()
	}
	s.mu.Unlock()
}

func (s *Session) oidcFlow(ctx context.Context) (*oauthclient.BrowserFlow, error) {
	bootstrap, err := s.Bootstrap(ctx)
	if err != nil {
		return nil, err
	}
	if bootstrap.Oidc.ClientID == "" {
		return nil, fmt.Errorf("gateway has no OIDC provider configured")
	}
	return &oauthclient.BrowserFlow{
		Config: oauth2.Config{
			ClientID: bootstrap.Oidc.ClientID,
			Endpoint: oauth2.Endpoint{
				AuthURL:  bootstrap.Oidc.AuthorizationEndpoint,
				TokenURL: bootstrap.Oidc.TokenEndpoint,
			},
			Scopes: []string{"openid", "email", "profile"},
		},
		Logger:     s.logger(),
		HTTPClient: s.httpClient,
	}, nil
}

func (s *Session) userTokenKey() string {
	return "session|" + s.gatewayURL
}

func (s *Session) dpopProof(method, target, accessToken string) (string, error) {
	if s.deviceKey == nil {
		return "", fmt.Errorf("session has no device key for DPoP proofs")
	}
	proofURL := target
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		proofURL = s.gatewayURL + target
	}
	return s.deviceKey.ProofWithAccessToken(method, proofURL, accessToken)
}

func (s *Session) attachDpopForToken(header http.Header, method, target, accessToken string) error {
	proof, err := s.dpopProof(method, target, accessToken)
	if err != nil {
		return err
	}
	header.Set(dpop.Header, proof)
	return nil
}

type oauthTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

type oauthErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func tokenSetFromOAuth(tokens oauthTokenResponse) *oauthclient.TokenSet {
	now := time.Now().Unix()
	return &oauthclient.TokenSet{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresAt:    now + tokens.ExpiresIn,
	}
}

func (s *Session) tokenEndpoint(ctx context.Context) string {
	bootstrap, err := s.Bootstrap(ctx)
	if err == nil && bootstrap.Endpoints.TokenExchange != "" {
		return bootstrap.Endpoints.TokenExchange
	}
	return s.gatewayURL + "/oauth/token"
}

func (s *Session) revocationEndpoint(ctx context.Context) string {
	bootstrap, err := s.Bootstrap(ctx)
	if err == nil && bootstrap.Endpoints.TokenRevoke != "" {
		return bootstrap.Endpoints.TokenRevoke
	}
	return s.gatewayURL + "/oauth/revoke"
}

func (s *Session) oauthPost(
	ctx context.Context,
	endpoint string,
	values url.Values,
	authToken string,
	dpopAccessToken string,
) (oauthTokenResponse, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return oauthTokenResponse{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if authToken != "" {
		request.Header.Set("Authorization", "Bearer "+authToken)
	}
	if s.deviceKey != nil {
		if err := s.attachDpopForToken(request.Header, http.MethodPost, endpoint, dpopAccessToken); err != nil {
			return oauthTokenResponse{}, err
		}
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return oauthTokenResponse{}, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var oauthErr oauthErrorResponse
		_ = json.Unmarshal(body, &oauthErr)
		if oauthErr.ErrorDescription != "" {
			return oauthTokenResponse{}, fmt.Errorf("%s: %s", oauthErr.Error, oauthErr.ErrorDescription)
		}
		return oauthTokenResponse{}, fmt.Errorf("oauth request failed: %s", response.Status)
	}
	var tokenResponse oauthTokenResponse
	if err := json.Unmarshal(body, &tokenResponse); err != nil {
		return oauthTokenResponse{}, err
	}
	if tokenResponse.AccessToken == "" {
		return oauthTokenResponse{}, fmt.Errorf("gateway returned no access token")
	}
	return tokenResponse, nil
}

func (s *Session) createSession(ctx context.Context, code, verifier, redirectURL string) (*oauthclient.TokenSet, error) {
	response, err := s.oauthPost(ctx, s.tokenEndpoint(ctx), url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirectURL},
	}, "", "")
	if err != nil {
		return nil, fmt.Errorf("create gateway session: %w", err)
	}
	return tokenSetFromOAuth(response), nil
}

func (s *Session) refreshSession(ctx context.Context, refreshToken string) (*oauthclient.TokenSet, error) {
	response, err := s.oauthPost(ctx, s.tokenEndpoint(ctx), url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}, "", "")
	if err != nil {
		return nil, fmt.Errorf("refresh gateway session: %w", err)
	}
	return tokenSetFromOAuth(response), nil
}

func (s *Session) revokeCachedSession(ctx context.Context) {
	cached := s.store.Get(ctx, s.userTokenKey())
	if cached != nil && cached.RefreshToken != "" {
		endpoint := s.revocationEndpoint(ctx)
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(url.Values{
			"token":           {cached.RefreshToken},
			"token_type_hint": {"refresh_token"},
		}.Encode()))
		if err != nil {
			s.logger().Debug("session revocation failed", "error", err)
		} else {
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			if response, err := s.httpClient.Do(request); err != nil {
				s.logger().Debug("session revocation failed", "error", err)
			} else {
				_ = response.Body.Close()
				if response.StatusCode >= 200 && response.StatusCode < 300 {
					s.logger().Info("revoked previous gateway session")
				} else {
					s.logger().Debug("session revocation failed", "status", response.Status)
				}
			}
		}
	}
	if err := s.store.Delete(ctx, s.userTokenKey()); err != nil {
		s.logger().Debug("clear cached session tokens failed", "error", err)
	}
	s.mu.Lock()
	s.appTokens = map[string]*oauthclient.TokenSet{}
	s.mu.Unlock()
}

func (s *Session) login(ctx context.Context) (*oauthclient.TokenSet, error) {
	s.revokeCachedSession(ctx)
	if s.rotateDeviceKey != nil {
		key, err := s.rotateDeviceKey(ctx)
		if err != nil {
			return nil, fmt.Errorf("rotate device key: %w", err)
		}
		s.deviceKey = key
	}
	flow, err := s.oidcFlow(ctx)
	if err != nil {
		return nil, err
	}
	code, verifier, redirectURL, err := flow.AuthorizeCode(ctx)
	if err != nil {
		return nil, err
	}
	tokens, err := s.createSession(ctx, code, verifier, redirectURL)
	if err != nil {
		return nil, err
	}
	if err := s.store.Put(ctx, s.userTokenKey(), tokens); err != nil {
		return nil, err
	}
	return tokens, nil
}

func (s *Session) UserToken(ctx context.Context, forceLogin bool) (string, error) {
	if !forceLogin {
		cached := s.store.Get(ctx, s.userTokenKey())
		if cached.Valid(30 * time.Second) {
			return cached.AccessToken, nil
		}
		if cached.Refreshable(30 * time.Second) {
			refreshed, err := s.refreshSession(ctx, cached.RefreshToken)
			if err == nil {
				if err := s.store.Put(ctx, s.userTokenKey(), refreshed); err != nil {
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
	if s.credentialResolver == nil {
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
	credential, err := s.credentialResolver(ctx, serviceApp)
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
	if s.credentialResolver == nil {
		return "", fmt.Errorf("service authentication requires a credential resolver")
	}
	cacheKey := "svc:" + serviceApp + ":" + audience
	s.mu.Lock()
	cached := s.appTokens[cacheKey]
	s.mu.Unlock()
	if cached.Valid(15 * time.Second) {
		return cached.AccessToken, nil
	}
	credential, err := s.credentialResolver(ctx, serviceApp)
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

func (s *Session) exchangeToken(
	ctx context.Context,
	subjectToken, subjectTokenType, actorToken, actorTokenType, audience string,
	scopes []string,
	impersonationToken string,
	authenticated bool,
) (*oauthclient.TokenSet, error) {
	values := url.Values{
		"grant_type":           {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"subject_token":        {subjectToken},
		"subject_token_type":   {subjectTokenType},
		"audience":             {audience},
		"requested_token_type": {token.TypeJWT},
	}
	if len(scopes) > 0 {
		values.Set("scope", strings.Join(scopes, " "))
	}
	if actorToken != "" {
		values.Set("actor_token", actorToken)
		values.Set("actor_token_type", actorTokenType)
	}
	if impersonationToken != "" {
		values.Set("impersonation_token", impersonationToken)
		values.Set("impersonation_token_type", token.TypeAccessToken)
	}
	authToken := ""
	dpopAccessToken := ""
	if authenticated {
		userToken, err := s.UserToken(ctx, false)
		if err != nil {
			return nil, err
		}
		authToken = userToken
		dpopAccessToken = userToken
	} else if subjectTokenType == token.TypeJWT && actorToken == "" {
		dpopAccessToken = subjectToken
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
	response, err := s.oauthPost(ctx, s.tokenEndpoint(ctx), values, authToken, dpopAccessToken)
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
			audience, subjectTokenType, logActorTokenType, actorClientID, impersonation, nil, strings.Fields(response.Scope),
		)...,
	)
	return &oauthclient.TokenSet{
		AccessToken: response.AccessToken,
		ExpiresAt:   time.Now().Unix() + response.ExpiresIn,
	}, nil
}

// DiscoveryClient returns the GraphQL discovery client for the registered
// discovery application, resolving its endpoint from the authenticated
// gateway registry and authenticating with an STS token for the discovery
// audience.
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
	client.HTTPClient = s.httpClient
	client.Logger = s.logger()
	client.AttachDPoP = func(ctx context.Context, header http.Header, method, url, accessToken string) error {
		return s.attachDpopForToken(header, method, url, accessToken)
	}
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
	app.GatewayURL = s.gatewayURL
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
			app.GatewayURL = s.gatewayURL
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
		app.GatewayURL = s.gatewayURL
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
