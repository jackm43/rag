package dpop

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/url"
	"time"

	"jsmunro.me/platy/sdk/secrets"
)

const Header = "DPoP"

type Key struct {
	private *ecdsa.PrivateKey
}

func Generate() (*Key, error) {
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate dpop key: %w", err)
	}
	return &Key{private: private}, nil
}

func Parse(pemBody string) (*Key, error) {
	block, _ := pem.Decode([]byte(pemBody))
	if block == nil {
		return nil, fmt.Errorf("dpop key is not valid PEM")
	}
	private, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse dpop key: %w", err)
	}
	return &Key{private: private}, nil
}

func (k *Key) PEM() (string, error) {
	der, err := x509.MarshalECPrivateKey(k.private)
	if err != nil {
		return "", fmt.Errorf("marshal dpop key: %w", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})), nil
}

func LoadOrCreate(ctx context.Context, service *secrets.Service, user, provider string) (*Key, error) {
	if body, err := service.User.DeviceKey(ctx, user, provider); err == nil {
		if key, err := Parse(body); err == nil {
			return key, nil
		}
	}
	return Rotate(ctx, service, user, provider)
}

func Rotate(ctx context.Context, service *secrets.Service, user, provider string) (*Key, error) {
	key, err := Generate()
	if err != nil {
		return nil, err
	}
	body, err := key.PEM()
	if err != nil {
		return nil, err
	}
	if _, err := service.User.StoreDeviceKey(ctx, user, body, provider); err != nil {
		return nil, fmt.Errorf("store dpop key: %w", err)
	}
	return key, nil
}

func encodeSegment(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func coordinate(value *big.Int) string {
	bytes := value.Bytes()
	padded := make([]byte, 32)
	copy(padded[32-len(bytes):], bytes)
	return encodeSegment(padded)
}

func (k *Key) publicJwk() map[string]string {
	return map[string]string{
		"kty": "EC",
		"crv": "P-256",
		"x":   coordinate(k.private.PublicKey.X),
		"y":   coordinate(k.private.PublicKey.Y),
	}
}

func (k *Key) Thumbprint() (string, error) {
	jwk := k.publicJwk()
	canonical, err := json.Marshal(map[string]string{
		"crv": jwk["crv"],
		"kty": jwk["kty"],
		"x":   jwk["x"],
		"y":   jwk["y"],
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return encodeSegment(digest[:]), nil
}

func normalizeHtu(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func randomJti() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return encodeSegment(buf), nil
}

func (k *Key) Proof(method, requestURL string) (string, error) {
	return k.ProofWithAccessToken(method, requestURL, "")
}

func (k *Key) ProofWithAccessToken(method, requestURL, accessToken string) (string, error) {
	header := map[string]any{
		"alg": "ES256",
		"typ": "dpop+jwt",
		"jwk": k.publicJwk(),
	}
	jti, err := randomJti()
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"htm": method,
		"htu": normalizeHtu(requestURL),
		"jti": jti,
		"iat": time.Now().Unix(),
	}
	if accessToken != "" {
		digest := sha256.Sum256([]byte(accessToken))
		payload["ath"] = encodeSegment(digest[:])
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	signingInput := encodeSegment(headerJSON) + "." + encodeSegment(payloadJSON)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, k.private, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign dpop proof: %w", err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + encodeSegment(signature), nil
}
