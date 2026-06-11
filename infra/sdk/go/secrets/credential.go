package secrets

import (
	"context"
)

type ClientCredential struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Provider     string `json:"provider,omitempty"`
}

type TLSClientCertificate struct {
	Certificate string `json:"certificate"`
	PrivateKey  string `json:"private_key"`
	Provider    string `json:"provider,omitempty"`
}

func storeTLSClientCertificate(ctx context.Context, service *Service, owner, certificatePEM, privateKeyPEM, provider string) (*TLSClientCertificate, error) {
	certificateReference, err := service.Store(ctx, owner+"/"+FieldTLSCertificate, certificatePEM, provider)
	if err != nil {
		return nil, err
	}
	privateKeyReference, err := service.Store(ctx, owner+"/"+FieldTLSPrivateKey, privateKeyPEM, provider)
	if err != nil {
		return nil, err
	}
	return &TLSClientCertificate{Certificate: certificateReference, PrivateKey: privateKeyReference, Provider: provider}, nil
}

func resolveTLSClientCertificate(ctx context.Context, service *Service, owner, provider string) (*TLSClientCertificate, error) {
	certificate, err := service.resolveName(ctx, owner+"/"+FieldTLSCertificate, provider)
	if err != nil {
		return nil, err
	}
	privateKey, err := service.resolveName(ctx, owner+"/"+FieldTLSPrivateKey, provider)
	if err != nil {
		return nil, err
	}
	return &TLSClientCertificate{Certificate: certificate, PrivateKey: privateKey, Provider: provider}, nil
}
