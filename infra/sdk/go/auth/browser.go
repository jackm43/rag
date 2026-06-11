package auth

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
	"time"

	"golang.org/x/oauth2"
)

const (
	CallbackPort = 8976
	loginTimeout = 5 * time.Minute
)

var RedirectURL = fmt.Sprintf("http://127.0.0.1:%d/callback", CallbackPort)

type BrowserFlow struct {
	Config oauth2.Config
	Logger *slog.Logger
}

func randomState() string {
	buf := make([]byte, 24)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

func openBrowser(logger *slog.Logger, url string) {
	for _, command := range []string{"xdg-open", "wslview", "open", "sensible-browser"} {
		if path, err := exec.LookPath(command); err == nil {
			cmd := exec.Command(path, url)
			if err := cmd.Start(); err == nil {
				go func() { _ = cmd.Wait() }()
				return
			}
		}
	}
	logger.Info("open the login url manually", "url", url)
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

func tokenSet(token *oauth2.Token) *TokenSet {
	expiresAt := token.Expiry.Unix()
	if token.Expiry.IsZero() {
		expiresAt = time.Now().Add(5 * time.Minute).Unix()
	}
	return &TokenSet{
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresAt:    expiresAt,
	}
}

func (f *BrowserFlow) logger() *slog.Logger {
	if f.Logger != nil {
		return f.Logger
	}
	return slog.Default()
}

func (f *BrowserFlow) Login(ctx context.Context) (*TokenSet, error) {
	config := f.Config
	config.RedirectURL = RedirectURL

	verifier := oauth2.GenerateVerifier()
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
	openBrowser(f.logger(), authURL)

	res := <-codeCh
	if res.err != nil {
		return nil, res.err
	}

	token, err := config.Exchange(ctx, res.code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, fmt.Errorf("authorization code exchange: %w", err)
	}
	return tokenSet(token), nil
}

func (f *BrowserFlow) Refresh(ctx context.Context, refreshToken string) (*TokenSet, error) {
	config := f.Config
	config.RedirectURL = RedirectURL
	source := config.TokenSource(ctx, &oauth2.Token{RefreshToken: refreshToken})
	token, err := source.Token()
	if err != nil {
		return nil, fmt.Errorf("token refresh: %w", err)
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	return tokenSet(token), nil
}

func (f *BrowserFlow) Token(ctx context.Context, store TokenStore, key string, forceLogin bool) (*TokenSet, error) {
	if !forceLogin {
		cached := store.Get(ctx, key)
		if cached.Valid(30 * time.Second) {
			return cached, nil
		}
		if cached != nil && cached.RefreshToken != "" {
			if refreshed, err := f.Refresh(ctx, cached.RefreshToken); err == nil {
				if err := store.Put(ctx, key, refreshed); err != nil {
					return nil, err
				}
				return refreshed, nil
			}
			f.logger().Debug("token refresh failed, starting browser login")
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
