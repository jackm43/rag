package platform

import (
	"context"
	"fmt"

	"jsmunro.me/platy/sdk/secrets"
)

func ResolveApplicationServiceCredential(ctx context.Context, service *secrets.Service, root, application string) (*secrets.ClientCredential, error) {
	document := CredentialDocument(root, application)
	if document == nil || document.Credential == nil {
		return nil, fmt.Errorf("application %s has no stored service credential", application)
	}
	return service.Application.ResolveServiceClientCredential(ctx, document.Credential)
}
