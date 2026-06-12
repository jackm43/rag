package httpclient

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os"
	"strings"
	"sync"
)

var (
	once   sync.Once
	client *http.Client
)

func Default() *http.Client {
	once.Do(func() {
		client = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: TLSConfig(),
			},
		}
	})
	return client
}

func TLSConfig() *tls.Config {
	return &tls.Config{
		RootCAs:    RootCAs(),
		MinVersion: tls.VersionTLS12,
	}
}

func RootCAs() *x509.CertPool {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	for _, path := range ExtraCAPaths() {
		appendPEMFile(pool, path)
	}
	return pool
}

func ExtraCAPaths() []string {
	paths := []string{}
	seen := map[string]struct{}{}
	for _, key := range []string{"SSL_CERT_FILE", "PLATY_CA_BUNDLE"} {
		path := strings.TrimSpace(os.Getenv(key))
		if path == "" {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	return paths
}

func appendPEMFile(pool *x509.CertPool, path string) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return
	}
	pool.AppendCertsFromPEM(pem)
}
