package oauthclient

import (
	"net/http"

	"jsmunro.me/platy/sdk/oauth2/oauthclient/dpop"
)

type Transport struct {
	Base  http.RoundTripper
	Token func() (string, error)
	Dpop  *dpop.Key
}

func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	token, err := t.Token()
	if err != nil {
		return nil, err
	}
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+token)
	proof, err := t.Dpop.ProofWithAccessToken(req.Method, req.URL.String(), token)
	if err != nil {
		return nil, err
	}
	req.Header.Set(dpop.Header, proof)
	return base.RoundTrip(req)
}
