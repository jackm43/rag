package client

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"jsmunro.me/platy/sdk/httpclient"
)

const (
	CallbackPort = 8976
	loginTimeout = 5 * time.Minute
)

var RedirectURL = fmt.Sprintf("http://127.0.0.1:%d/callback", CallbackPort)

type BrowserFlow struct {
	Config     oauth2.Config
	Logger     *slog.Logger
	HTTPClient *http.Client
}

func randomState() string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

// OpenBrowser launches the system browser for an interactive auth step,
// logging the URL for manual use when no launcher is available.
func OpenBrowser(logger *slog.Logger, url string) {
	for _, command := range []string{"xdg-open", "wslview", "open", "sensible-browser"} {
		if path, err := exec.LookPath(command); err == nil {
			cmd := exec.Command(path, url)
			if err := cmd.Start(); err == nil {
				go func() { _ = cmd.Wait() }()
				return
			}
		}
	}
	logger.Info("open the url manually", "url", url)
}

func waitForCallback(ctx context.Context, state string) (string, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", CallbackPort))
	if err != nil {
		return "", fmt.Errorf("callback listener: %w", err)
	}

	type result struct {
		code string
		err  error
	}
	results := make(chan result, 1)

	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		query := r.URL.Query()
		if oauthError := query.Get("error"); oauthError != "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, "<html><body>Login failed. Return to the terminal.</body></html>")
			results <- result{err: fmt.Errorf("authorization error: %s", oauthError)}
			return
		}
		code := query.Get("code")
		if code == "" || query.Get("state") != state {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, "<html><body>Login failed. Return to the terminal.</body></html>")
			results <- result{err: errors.New("missing code or state mismatch in callback")}
			return
		}
		fmt.Fprint(w, "<html><body>Login complete. You can close this tab.</body></html>")
		results <- result{code: code}
	})}

	go func() { _ = server.Serve(listener) }()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	timeout := time.NewTimer(loginTimeout)
	defer timeout.Stop()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-timeout.C:
		return "", errors.New("timed out waiting for browser login")
	case res := <-results:
		return res.code, res.err
	}
}

func tokenSet(token *oauth2.Token, grantedScopes []string) *TokenSet {
	expiresAt := token.Expiry.Unix()
	if token.Expiry.IsZero() {
		expiresAt = time.Now().Add(5 * time.Minute).Unix()
	}
	return &TokenSet{
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresAt:    expiresAt,
		Scopes:       append([]string(nil), grantedScopes...),
	}
}

func (f *BrowserFlow) logger() *slog.Logger {
	if f.Logger != nil {
		return f.Logger
	}
	return slog.Default()
}

func (f *BrowserFlow) httpClient() *http.Client {
	if f.HTTPClient != nil {
		return f.HTTPClient
	}
	return httpclient.Default()
}

func (f *BrowserFlow) oauthContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, oauth2.HTTPClient, f.httpClient())
}

func tlsHint(err error) string {
	if err == nil {
		return ""
	}
	message := err.Error()
	if !strings.Contains(message, "x509:") && !strings.Contains(message, "tls:") {
		return ""
	}
	return "; if TLS inspection is in use, export the inspecting CA and set SSL_CERT_FILE or PLATY_CA_BUNDLE"
}

func (f *BrowserFlow) Login(ctx context.Context) (*TokenSet, error) {
	code, verifier, _, err := f.AuthorizeCode(ctx)
	if err != nil {
		return nil, err
	}

	config := f.Config
	config.RedirectURL = RedirectURL
	token, err := config.Exchange(f.oauthContext(ctx), code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, fmt.Errorf("authorization code exchange: %w%s", err, tlsHint(err))
	}
	return tokenSet(token, f.Config.Scopes), nil
}

func (f *BrowserFlow) AuthorizeCode(ctx context.Context) (code string, verifier string, redirectURL string, err error) {
	config := f.Config
	config.RedirectURL = RedirectURL

	verifier = oauth2.GenerateVerifier()
	state := randomState()
	authURL := config.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))

	f.logger().Info("opening browser for login", "url", authURL)
	codeCh := make(chan struct {
		code string
		err  error
	}, 1)
	go func() {
		code, err := waitForCallback(ctx, state)
		codeCh <- struct {
			code string
			err  error
		}{code, err}
	}()
	OpenBrowser(f.logger(), authURL)

	res := <-codeCh
	if res.err != nil {
		return "", "", "", res.err
	}
	return res.code, verifier, RedirectURL, nil
}

func (f *BrowserFlow) Refresh(ctx context.Context, refreshToken string, priorScopes []string) (*TokenSet, error) {
	config := f.Config
	config.RedirectURL = RedirectURL
	source := config.TokenSource(f.oauthContext(ctx), &oauth2.Token{RefreshToken: refreshToken})
	token, err := source.Token()
	if err != nil {
		return nil, fmt.Errorf("token refresh: %w", err)
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	return tokenSet(token, priorScopes), nil
}

func (f *BrowserFlow) Token(ctx context.Context, store TokenStore, key string, forceLogin bool, wantedScopes []string) (*TokenSet, error) {
	if !forceLogin {
		cached := store.Get(ctx, key)
		if cached.Valid(30*time.Second) && CoversScopes(cached.Scopes, wantedScopes) {
			return cached, nil
		}
		if cached != nil && cached.RefreshToken != "" && CoversScopes(cached.Scopes, wantedScopes) {
			if refreshed, err := f.Refresh(ctx, cached.RefreshToken, cached.Scopes); err == nil {
				if err := store.Put(ctx, key, refreshed); err != nil {
					return nil, err
				}
				return refreshed, nil
			}
			f.logger().Debug("token refresh failed, starting browser login")
		} else if cached != nil && !CoversScopes(cached.Scopes, wantedScopes) {
			f.logger().Info("cached token missing required scopes, starting browser login")
		}
	}
	token, err := f.Login(ctx)
	if err != nil {
		return nil, err
	}
	if err := store.Put(ctx, key, token); err != nil {
		return nil, err
	}
	return token, nil
}
