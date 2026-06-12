package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	cf "github.com/cloudflare/cloudflare-go/v6"
	"github.com/cloudflare/cloudflare-go/v6/accounts"
	"github.com/cloudflare/cloudflare-go/v6/option"
	"github.com/cloudflare/cloudflare-go/v6/user"
	"github.com/cloudflare/cloudflare-go/v6/zero_trust"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider/core"
	"jsmunro.me/platy/sdk/auth"
	cfcloud "jsmunro.me/platy/sdk/cloudflare"
)

type cloudflareProvider struct {
	client *cf.Client
}

func New(apiToken string) (core.IdentityProxy, error) {
	if strings.TrimSpace(apiToken) == "" {
		return nil, fmt.Errorf("cloudflare api token is required")
	}
	client := cf.NewClient(option.WithAPIToken(apiToken))
	return &cloudflareProvider{client: client}, nil
}

type apiEnvelope struct {
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

func (e *apiEnvelope) decode(target any) error {
	if !e.Success {
		messages := []string{}
		for _, apiError := range e.Errors {
			messages = append(messages, fmt.Sprintf("%d %s", apiError.Code, apiError.Message))
		}
		return fmt.Errorf("cloudflare api error: %s", strings.Join(messages, "; "))
	}
	return json.Unmarshal(e.Result, target)
}

type oauthClientInfo struct {
	ClientID     string   `json:"client_id"`
	ClientName   string   `json:"client_name"`
	ClientSecret string   `json:"client_secret"`
	Scopes       []string `json:"scopes"`
}

func applicationOAuthClientName(application string) string {
	return "platy-app-" + application
}

func normalizeAccessTeamDomain(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	raw = strings.TrimRight(raw, "/")
	if strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "http://") {
		return raw
	}
	return "https://" + raw
}

func normalizeTeamName(raw string) string {
	return strings.TrimSpace(raw)
}

func accessTeamNameFromAuthDomain(authDomain string) string {
	host := strings.TrimSpace(authDomain)
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimRight(host, "/")
	const suffix = ".cloudflareaccess.com"
	if !strings.HasSuffix(host, suffix) {
		return ""
	}
	return strings.TrimSuffix(host, suffix)
}

func bootstrapProviderOrganization(account accounts.Account, organization map[string]any) core.TrustBoundary {
	authDomain, _ := organization["auth_domain"].(string)
	teamID, _ := organization["id"].(string)
	teamName := accessTeamNameFromAuthDomain(authDomain)
	domain := normalizeAccessTeamDomain(authDomain)
	if teamName == "" || domain == "" {
		output.Fail("account %s zero trust organization has no auth_domain", account.ID)
	}
	return core.TrustBoundary{
		Provider:     core.Cloudflare,
		AccountID:    account.ID,
		AccountName:  account.Name,
		TeamID:       teamID,
		TeamName:     teamName,
		TeamDomain:   domain,
		Organization: organization,
	}
}

func (p *cloudflareProvider) verifyToken(ctx context.Context) {
	response, err := p.client.User.Tokens.Verify(ctx)
	if err != nil {
		output.Fail("verify cloudflare api token: %v", err)
	}
	if response.Status != user.TokenVerifyResponseStatusActive {
		output.Fail("cloudflare api token is %s", response.Status)
	}
}

func (p *cloudflareProvider) listAccessibleAccounts(ctx context.Context) []accounts.Account {
	pager := p.client.Accounts.ListAutoPaging(ctx, accounts.AccountListParams{})
	listed := []accounts.Account{}
	for pager.Next() {
		listed = append(listed, pager.Current())
	}
	if err := pager.Err(); err != nil {
		output.Fail("list cloudflare accounts: %v", err)
	}
	if len(listed) == 0 {
		output.Fail("api token has access to no cloudflare accounts")
	}
	return listed
}

func (p *cloudflareProvider) fetchOrganizationRaw(ctx context.Context, accountID string) (map[string]any, error) {
	envelope := &apiEnvelope{}
	path := fmt.Sprintf("accounts/%s/access/organizations", accountID)
	if err := p.client.Get(ctx, path, nil, envelope); err != nil {
		return nil, err
	}
	if !envelope.Success {
		return nil, fmt.Errorf("organization lookup failed for account %s", accountID)
	}
	organization := map[string]any{}
	if err := envelope.decode(&organization); err != nil {
		return nil, err
	}
	return organization, nil
}

func (p *cloudflareProvider) discoverBoundaries(ctx context.Context, accountOverride string) []core.TrustBoundary {
	candidates := p.listAccessibleAccounts(ctx)
	if accountOverride != "" {
		filtered := []accounts.Account{}
		for _, account := range candidates {
			if account.ID == accountOverride {
				filtered = append(filtered, account)
				break
			}
		}
		if len(filtered) == 0 {
			output.Fail("account %s is not accessible with the provided api token", accountOverride)
		}
		candidates = filtered
	}

	contexts := []core.TrustBoundary{}
	for _, account := range candidates {
		organization, err := p.fetchOrganizationRaw(ctx, account.ID)
		if err != nil {
			output.Logger.Debug("skipping account without zero trust organization", "account_id", account.ID, "error", err)
			continue
		}
		contexts = append(contexts, bootstrapProviderOrganization(account, organization))
	}
	return contexts
}

func matchesTeamHints(candidate core.TrustBoundary, teamID, teamName, teamDomain string) bool {
	if teamID != "" && !strings.EqualFold(candidate.TeamID, teamID) {
		return false
	}
	if teamName != "" && !strings.EqualFold(candidate.TeamName, normalizeTeamName(teamName)) {
		return false
	}
	if teamDomain != "" && candidate.TeamDomain != normalizeAccessTeamDomain(teamDomain) {
		return false
	}
	return true
}

func (p *cloudflareProvider) ResolveTrustBoundary(ctx context.Context, hints core.TrustBoundaryHints) (core.TrustBoundary, error) {
	p.verifyToken(ctx)
	teamID := strings.TrimSpace(hints.TeamID)
	teamName := normalizeTeamName(hints.TeamName)
	teamDomain := strings.TrimSpace(hints.TeamDomain)

	contexts := p.discoverBoundaries(ctx, hints.AccountID)
	if len(contexts) == 0 {
		output.Fail("no zero trust organizations are accessible with the provided api token")
	}

	if teamID != "" || teamName != "" || teamDomain != "" {
		matched := []core.TrustBoundary{}
		for _, candidate := range contexts {
			if matchesTeamHints(candidate, teamID, teamName, teamDomain) {
				matched = append(matched, candidate)
			}
		}
		if len(matched) == 0 {
			output.Fail("no zero trust organization matches the provided team identifiers")
		}
		if len(matched) > 1 {
			output.Fail("multiple zero trust organizations match; disambiguate with --account-id")
		}
		resolved := matched[0]
		output.Logger.Info(
			"resolved zero trust organization",
			"provider", resolved.Provider,
			"account_id", resolved.AccountID,
			"team_id", resolved.TeamID,
			"team_name", resolved.TeamName,
			"team_domain", resolved.TeamDomain,
		)
		return resolved, nil
	}

	if len(contexts) > 1 {
		output.Fail("api token can access multiple zero trust organizations; pass --team-id, --team-name, or --team-domain")
	}
	resolved := contexts[0]
	output.Logger.Info(
		"resolved zero trust organization",
		"provider", resolved.Provider,
		"account_id", resolved.AccountID,
		"team_id", resolved.TeamID,
		"team_name", resolved.TeamName,
		"team_domain", resolved.TeamDomain,
	)
	return resolved, nil
}

func (p *cloudflareProvider) ListIdentityProviders(ctx context.Context, boundary core.TrustBoundary) ([]core.IdentityProvider, error) {
	providers := []core.IdentityProvider{}
	pager := p.client.ZeroTrust.IdentityProviders.ListAutoPaging(ctx, zero_trust.IdentityProviderListParams{
		AccountID: cf.F(boundary.AccountID),
	})
	for pager.Next() {
		idp := pager.Current()
		providers = append(providers, core.IdentityProvider{
			ID:   idp.ID,
			Name: idp.Name,
			Type: string(idp.Type),
		})
	}
	if err := pager.Err(); err != nil {
		return nil, fmt.Errorf("list identity providers: %w", err)
	}
	if len(providers) == 0 {
		output.Fail("no identity providers are configured in core.Cloudflare Zero Trust")
	}
	for _, idp := range providers {
		output.Logger.Info("found identity provider", "id", idp.ID, "name", idp.Name, "type", idp.Type)
	}
	return providers, nil
}

func resolveIdentityProviderIDs(all []core.IdentityProvider, requested []string) []string {
	if len(requested) == 0 {
		for _, idp := range all {
			if idp.Type == "github" {
				return []string{idp.ID}
			}
		}
		if len(all) > 0 {
			return []string{all[0].ID}
		}
		return nil
	}
	byID := map[string]core.IdentityProvider{}
	byName := map[string]core.IdentityProvider{}
	byType := map[string]core.IdentityProvider{}
	for _, idp := range all {
		byID[idp.ID] = idp
		byName[strings.ToLower(idp.Name)] = idp
		byType[strings.ToLower(idp.Type)] = idp
	}
	resolved := []string{}
	for _, ref := range requested {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		if idp, ok := byID[ref]; ok {
			resolved = append(resolved, idp.ID)
			continue
		}
		if idp, ok := byName[strings.ToLower(ref)]; ok {
			resolved = append(resolved, idp.ID)
			continue
		}
		if idp, ok := byType[strings.ToLower(ref)]; ok {
			resolved = append(resolved, idp.ID)
			continue
		}
		output.Fail("unknown identity provider %q", ref)
	}
	return resolved
}

func (p *cloudflareProvider) findAccessGroup(ctx context.Context, accountID, name string) (string, bool) {
	pager := p.client.ZeroTrust.Access.Groups.ListAutoPaging(ctx, zero_trust.AccessGroupListParams{
		AccountID: cf.F(accountID),
		Name:      cf.F(name),
	})
	for pager.Next() {
		group := pager.Current()
		if group.Name == name {
			return group.ID, true
		}
	}
	if err := pager.Err(); err != nil {
		output.Fail("list access groups: %v", err)
	}
	return "", false
}

func (p *cloudflareProvider) EnsureGroups(ctx context.Context, boundary core.TrustBoundary, specs map[string][]string) (map[string]core.AccessGroup, error) {
	groups := map[string]core.AccessGroup{}
	for name, emails := range specs {
		if id, ok := p.findAccessGroup(ctx, boundary.AccountID, name); ok {
			output.Logger.Info("reusing access group", "id", id, "name", name)
			groups[name] = core.AccessGroup{ID: id, Name: name}
			continue
		}
		if len(emails) == 0 {
			output.Logger.Info("skipping access group without static members", "name", name)
			continue
		}
		include := []zero_trust.AccessRuleUnionParam{}
		for _, email := range emails {
			include = append(include, zero_trust.EmailRuleParam{
				Email: cf.F(zero_trust.EmailRuleEmailParam{Email: cf.F(email)}),
			})
		}
		created, err := p.client.ZeroTrust.Access.Groups.New(ctx, zero_trust.AccessGroupNewParams{
			AccountID: cf.F(boundary.AccountID),
			Name:      cf.F(name),
			Include:   cf.F(include),
		})
		if err != nil {
			return nil, fmt.Errorf("create access group %s: %w", name, err)
		}
		output.Logger.Info("created access group", "id", created.ID, "name", name)
		groups[name] = core.AccessGroup{ID: created.ID, Name: name}
	}
	return groups, nil
}

func (p *cloudflareProvider) EnsureEmailAllowlistPolicy(ctx context.Context, boundary core.TrustBoundary, emails []string, groupIDs []string) (string, error) {
	policies := p.client.ZeroTrust.Access.Policies.ListAutoPaging(ctx, zero_trust.AccessPolicyListParams{
		AccountID: cf.F(boundary.AccountID),
	})
	for policies.Next() {
		policy := policies.Current()
		if policy.Name == core.PolicyPlatformAdmins {
			output.Logger.Info("reusing access policy", "id", policy.ID, "name", policy.Name)
			return policy.ID, nil
		}
	}
	if err := policies.Err(); err != nil {
		return "", fmt.Errorf("list access policies: %w", err)
	}

	include := []zero_trust.AccessRuleUnionParam{}
	for _, email := range emails {
		include = append(include, zero_trust.EmailRuleParam{
			Email: cf.F(zero_trust.EmailRuleEmailParam{Email: cf.F(email)}),
		})
	}
	for _, groupID := range groupIDs {
		include = append(include, zero_trust.GroupRuleParam{
			Group: cf.F(zero_trust.GroupRuleGroupParam{ID: cf.F(groupID)}),
		})
	}
	if len(include) == 0 {
		output.Fail("email allowlist is empty")
	}

	policy, err := p.client.ZeroTrust.Access.Policies.New(ctx, zero_trust.AccessPolicyNewParams{
		AccountID: cf.F(boundary.AccountID),
		Decision:  cf.F(zero_trust.DecisionAllow),
		Name:      cf.F(core.PolicyPlatformAdmins),
		Include:   cf.F(include),
	})
	if err != nil {
		return "", fmt.Errorf("create access policy: %w", err)
	}
	output.Logger.Info("created access policy", "id", policy.ID, "emails", strings.Join(emails, ","))
	return policy.ID, nil
}

func (p *cloudflareProvider) findDevicePostureRule(ctx context.Context, accountID, name string) (string, bool) {
	pager := p.client.ZeroTrust.Devices.Posture.ListAutoPaging(ctx, zero_trust.DevicePostureListParams{
		AccountID: cf.F(accountID),
	})
	for pager.Next() {
		rule := pager.Current()
		if rule.Name == name {
			return rule.ID, true
		}
	}
	if err := pager.Err(); err != nil {
		output.Fail("list device posture rules: %v", err)
	}
	return "", false
}

func (p *cloudflareProvider) EnsureDevicePosture(ctx context.Context, boundary core.TrustBoundary, enabled bool, ruleName string) (core.PosturePolicy, error) {
	if !enabled {
		return core.PosturePolicy{Enabled: false, Checks: []core.PostureCheck{{Type: core.PostureCheckWARP}}}, nil
	}
	if ruleName == "" {
		ruleName = core.PolicyPostureRuleName
	}
	if id, ok := p.findDevicePostureRule(ctx, boundary.AccountID, ruleName); ok {
		output.Logger.Info("reusing device posture rule", "id", id, "name", ruleName)
		return core.PosturePolicy{
			Enabled: true,
			RuleID:  id,
			Checks:  []core.PostureCheck{{Type: core.PostureCheckWARP}},
		}, nil
	}
	created, err := p.client.ZeroTrust.Devices.Posture.New(ctx, zero_trust.DevicePostureNewParams{
		AccountID:   cf.F(boundary.AccountID),
		Name:        cf.F(ruleName),
		Type:        cf.F(zero_trust.DevicePostureNewParamsTypeWARP),
		Description: cf.F("Requires Cloudflare WARP client for platform access"),
	})
	if err != nil {
		return core.PosturePolicy{}, fmt.Errorf("create device posture rule: %w", err)
	}
	output.Logger.Info("created device posture rule", "id", created.ID, "name", ruleName)
	return core.PosturePolicy{
		Enabled: true,
		RuleID:  created.ID,
		Checks:  []core.PostureCheck{{Type: core.PostureCheckWARP}},
	}, nil
}

func (p *cloudflareProvider) findPostureAccessPolicy(ctx context.Context, accountID string) (string, bool) {
	policies := p.client.ZeroTrust.Access.Policies.ListAutoPaging(ctx, zero_trust.AccessPolicyListParams{
		AccountID: cf.F(accountID),
	})
	for policies.Next() {
		policy := policies.Current()
		if policy.Name == core.PolicyDevicePosture {
			return policy.ID, true
		}
	}
	if err := policies.Err(); err != nil {
		output.Fail("list access policies: %v", err)
	}
	return "", false
}

func (p *cloudflareProvider) ensurePostureAccessPolicy(ctx context.Context, boundary core.TrustBoundary, postureRuleID string) (string, error) {
	if id, ok := p.findPostureAccessPolicy(ctx, boundary.AccountID); ok {
		return id, nil
	}
	policy, err := p.client.ZeroTrust.Access.Policies.New(ctx, zero_trust.AccessPolicyNewParams{
		AccountID: cf.F(boundary.AccountID),
		Decision:  cf.F(zero_trust.DecisionAllow),
		Name:      cf.F(core.PolicyDevicePosture),
		Include: cf.F([]zero_trust.AccessRuleUnionParam{
			everyoneIncludeRule(),
		}),
		Require: cf.F([]zero_trust.AccessRuleUnionParam{
			zero_trust.AccessDevicePostureRuleParam{
				DevicePosture: cf.F(zero_trust.AccessDevicePostureRuleDevicePostureParam{
					IntegrationUID: cf.F(postureRuleID),
				}),
			},
		}),
	})
	if err != nil {
		return "", fmt.Errorf("create device posture access policy: %w", err)
	}
	output.Logger.Info("created device posture access policy", "id", policy.ID)
	return policy.ID, nil
}

func (p *cloudflareProvider) SetPostureEnabled(ctx context.Context, boundary core.TrustBoundary, enabled bool, ruleName string) (core.PosturePolicy, error) {
	posture, err := p.EnsureDevicePosture(ctx, boundary, enabled, ruleName)
	if err != nil {
		return core.PosturePolicy{}, err
	}
	if !enabled {
		return posture, nil
	}
	if _, err := p.ensurePostureAccessPolicy(ctx, boundary, posture.RuleID); err != nil {
		return core.PosturePolicy{}, err
	}
	return posture, nil
}

func (p *cloudflareProvider) findAccessApp(ctx context.Context, accountID, name string) (string, string) {
	pager := p.client.ZeroTrust.Access.Applications.ListAutoPaging(ctx, zero_trust.AccessApplicationListParams{
		AccountID: cf.F(accountID),
		Name:      cf.F(name),
		Exact:     cf.F(true),
	})
	for pager.Next() {
		app := pager.Current()
		raw := app.JSON.RawJSON()
		var decoded struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			SaaSApp struct {
				ClientID string `json:"client_id"`
			} `json:"saas_app"`
		}
		if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
			continue
		}
		if decoded.Name == name {
			return decoded.ID, decoded.SaaSApp.ClientID
		}
	}
	if err := pager.Err(); err != nil {
		output.Fail("list access applications: %v", err)
	}
	return "", ""
}

func impersonationAccessAppName(application string) string {
	return "platy-impersonate-" + application
}

func (p *cloudflareProvider) ImpersonationAccessSpec(
	ctx context.Context,
	boundary core.TrustBoundary,
	access core.ApplicationAccess,
	groups map[string]core.AccessGroup,
	identityProviders []core.IdentityProvider,
	emailAllowlist []string,
	posture core.PosturePolicy,
) (core.AccessApplicationSpec, error) {
	groupIDs := []string{}
	for _, groupName := range access.AllowedGroups {
		if group, ok := groups[groupName]; ok {
			groupIDs = append(groupIDs, group.ID)
		}
	}
	if len(groupIDs) == 0 {
		if admins, ok := groups[core.GroupAdmins]; ok {
			groupIDs = append(groupIDs, admins.ID)
		}
	}
	policyID, err := p.EnsureEmailAllowlistPolicy(ctx, boundary, emailAllowlist, groupIDs)
	if err != nil {
		return core.AccessApplicationSpec{}, err
	}
	policyIDs := []string{policyID}
	if access.PostureRequired != nil && *access.PostureRequired && posture.Enabled && posture.RuleID != "" {
		posturePolicyID, err := p.ensurePostureAccessPolicy(ctx, boundary, posture.RuleID)
		if err != nil {
			return core.AccessApplicationSpec{}, err
		}
		policyIDs = append(policyIDs, posturePolicyID)
	}
	return core.AccessApplicationSpec{
		AllowedIdPIDs:   resolveIdentityProviderIDs(identityProviders, access.AllowedIdPs),
		PolicyIDs:       policyIDs,
		PostureRequired: access.PostureRequired != nil && *access.PostureRequired,
	}, nil
}

func (p *cloudflareProvider) EnsureImpersonationAccessApplication(
	ctx context.Context,
	boundary core.TrustBoundary,
	application string,
	spec core.AccessApplicationSpec,
) (*core.AccessApplication, error) {
	name := impersonationAccessAppName(application)
	_, clientID := p.findAccessApp(ctx, boundary.AccountID, name)
	if clientID != "" {
		output.Logger.Info("reusing impersonation access application", "application", application, "client_id", clientID)
		return &core.AccessApplication{ClientID: clientID}, nil
	}
	spec.Name = name
	created, err := p.CreateAccessApplication(ctx, boundary, spec)
	if err != nil {
		return nil, err
	}
	output.Logger.Info("created impersonation access application", "application", application, "client_id", created.ClientID)
	return created, nil
}

func (p *cloudflareProvider) CreateAccessApplication(ctx context.Context, boundary core.TrustBoundary, spec core.AccessApplicationSpec) (*core.AccessApplication, error) {
	allowed := make([]zero_trust.AllowedIdPsParam, len(spec.AllowedIdPIDs))
	copy(allowed, spec.AllowedIdPIDs)
	policyLinks := []zero_trust.AccessApplicationNewParamsBodySaaSApplicationPolicyUnion{}
	for index, policyID := range spec.PolicyIDs {
		policyLinks = append(policyLinks, zero_trust.AccessApplicationNewParamsBodySaaSApplicationPoliciesAccessAppPolicyLink{
			ID:         cf.F(policyID),
			Precedence: cf.F(int64(index + 1)),
		})
	}
	response, err := p.client.ZeroTrust.Access.Applications.New(ctx, zero_trust.AccessApplicationNewParams{
		AccountID: cf.F(boundary.AccountID),
		Body: zero_trust.AccessApplicationNewParamsBodySaaSApplication{
			Type:                   cf.F(zero_trust.ApplicationTypeSaaS),
			Name:                   cf.F(spec.Name),
			AppLauncherVisible:     cf.F(false),
			AllowedIdPs:            cf.F(allowed),
			AutoRedirectToIdentity: cf.F(true),
			Policies:               cf.F(policyLinks),
			SaaSApp: cf.F[zero_trust.AccessApplicationNewParamsBodySaaSApplicationSaaSAppUnion](
				zero_trust.OIDCSaaSAppParam{
					AuthType: cf.F(zero_trust.OIDCSaaSAppAuthTypeOIDC),
					GrantTypes: cf.F([]zero_trust.OIDCSaaSAppGrantType{
						zero_trust.OIDCSaaSAppGrantTypeAuthorizationCodeWithPKCE,
						zero_trust.OIDCSaaSAppGrantTypeRefreshTokens,
					}),
					RedirectURIs: cf.F([]string{
						auth.RedirectURL,
						fmt.Sprintf("http://localhost:%d/callback", auth.CallbackPort),
					}),
					Scopes: cf.F([]zero_trust.OIDCSaaSAppScope{
						zero_trust.OIDCSaaSAppScopeOpenid,
						zero_trust.OIDCSaaSAppScopeEmail,
						zero_trust.OIDCSaaSAppScopeProfile,
					}),
					AllowPKCEWithoutClientSecret: cf.F(true),
					AccessTokenLifetime:          cf.F("5m"),
					RefreshTokenOptions: cf.F(zero_trust.OIDCSaaSAppRefreshTokenOptionsParam{
						Lifetime: cf.F("30d"),
					}),
				},
			),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create access application: %w", err)
	}
	var decoded struct {
		ID      string `json:"id"`
		SaaSApp struct {
			ClientID string `json:"client_id"`
		} `json:"saas_app"`
	}
	if err := json.Unmarshal([]byte(response.JSON.RawJSON()), &decoded); err != nil {
		return nil, fmt.Errorf("decode access application response: %w", err)
	}
	output.Logger.Info("created access application", "id", decoded.ID, "client_id", decoded.SaaSApp.ClientID)
	return &core.AccessApplication{ID: decoded.ID, ClientID: decoded.SaaSApp.ClientID}, nil
}

func (p *cloudflareProvider) findBypassPolicy(ctx context.Context, accountID string) string {
	preferred := []string{"bypass-discord-bot", core.PolicyWorkersDevBypass, "rag-workers-dev-bypass"}
	policies := p.client.ZeroTrust.Access.Policies.ListAutoPaging(ctx, zero_trust.AccessPolicyListParams{
		AccountID: cf.F(accountID),
	})
	found := map[string]string{}
	for policies.Next() {
		policy := policies.Current()
		if policy.Decision == zero_trust.DecisionBypass {
			found[policy.Name] = policy.ID
		}
	}
	if err := policies.Err(); err != nil {
		output.Fail("list access policies: %v", err)
	}
	for _, name := range preferred {
		if id, ok := found[name]; ok {
			output.Logger.Info("reusing bypass access policy", "id", id, "name", name)
			return id
		}
	}
	policy, err := p.client.ZeroTrust.Access.Policies.New(ctx, zero_trust.AccessPolicyNewParams{
		AccountID: cf.F(accountID),
		Decision:  cf.F(zero_trust.DecisionBypass),
		Name:      cf.F(core.PolicyWorkersDevBypass),
		Include: cf.F([]zero_trust.AccessRuleUnionParam{
			everyoneIncludeRule(),
		}),
	})
	if err != nil {
		output.Fail("create bypass access policy: %v", err)
	}
	output.Logger.Info("created bypass access policy", "id", policy.ID)
	return policy.ID
}

func (p *cloudflareProvider) selfHostedAccessAppExists(ctx context.Context, accountID, domain string) bool {
	pager := p.client.ZeroTrust.Access.Applications.ListAutoPaging(ctx, zero_trust.AccessApplicationListParams{
		AccountID: cf.F(accountID),
		Domain:    cf.F(domain),
	})
	for pager.Next() {
		app := pager.Current()
		var decoded struct {
			Domain            string   `json:"domain"`
			SelfHostedDomains []string `json:"self_hosted_domains"`
		}
		if err := json.Unmarshal([]byte(app.JSON.RawJSON()), &decoded); err != nil {
			continue
		}
		if decoded.Domain == domain {
			return true
		}
		for _, candidate := range decoded.SelfHostedDomains {
			if candidate == domain {
				return true
			}
		}
	}
	if err := pager.Err(); err != nil {
		output.Fail("list access applications for %s: %v", domain, err)
	}
	return false
}

func (p *cloudflareProvider) ensureWorkerDevBypassApp(ctx context.Context, accountID, appName, domain, bypassPolicyID string) {
	if p.selfHostedAccessAppExists(ctx, accountID, domain) {
		output.Logger.Info("reusing workers.dev bypass access application", "domain", domain)
		return
	}
	_, err := p.client.ZeroTrust.Access.Applications.New(ctx, zero_trust.AccessApplicationNewParams{
		AccountID: cf.F(accountID),
		Body: zero_trust.AccessApplicationNewParamsBodySelfHostedApplication{
			Type:   cf.F(zero_trust.ApplicationTypeSelfHosted),
			Name:   cf.F(appName),
			Domain: cf.F(domain),
			Policies: cf.F([]zero_trust.AccessApplicationNewParamsBodySelfHostedApplicationPolicyUnion{
				zero_trust.AccessApplicationNewParamsBodySelfHostedApplicationPoliciesAccessAppPolicyLink{
					ID:         cf.F(bypassPolicyID),
					Precedence: cf.F(int64(1)),
				},
			}),
		},
	})
	if err != nil {
		output.Fail("create workers.dev bypass access application for %s: %v", domain, err)
	}
	output.Logger.Info("created workers.dev bypass access application", "domain", domain)
}

func (p *cloudflareProvider) EnsureWorkersDevBypassApps(ctx context.Context, boundary core.TrustBoundary, subdomain string) error {
	bypassPolicyID := p.findBypassPolicy(ctx, boundary.AccountID)
	for _, worker := range []string{"auth-gateway", "deploy", "cloudflare"} {
		domain := fmt.Sprintf("%s.%s.workers.dev", worker, subdomain)
		p.ensureWorkerDevBypassApp(ctx, boundary.AccountID, worker, domain, bypassPolicyID)
	}
	return nil
}

func (p *cloudflareProvider) EnsureWebClientBypassAccess(
	ctx context.Context,
	boundary core.TrustBoundary,
	application, domain string,
) error {
	bypassPolicyID := p.findBypassPolicy(ctx, boundary.AccountID)
	policyLinks := []zero_trust.AccessApplicationNewParamsBodySelfHostedApplicationPolicyUnion{
		zero_trust.AccessApplicationNewParamsBodySelfHostedApplicationPoliciesAccessAppPolicyLink{
			ID:         cf.F(bypassPolicyID),
			Precedence: cf.F(int64(1)),
		},
	}
	updatePolicyLinks := []zero_trust.AccessApplicationUpdateParamsBodySelfHostedApplicationPolicyUnion{
		zero_trust.AccessApplicationUpdateParamsBodySelfHostedApplicationPoliciesAccessAppPolicyLink{
			ID:         cf.F(bypassPolicyID),
			Precedence: cf.F(int64(1)),
		},
	}
	appID := p.findSelfHostedAccessAppID(ctx, boundary.AccountID, domain)
	if appID != "" {
		_, err := p.client.ZeroTrust.Access.Applications.Update(ctx, zero_trust.AppIDParam(appID), zero_trust.AccessApplicationUpdateParams{
			AccountID: cf.F(boundary.AccountID),
			Body: zero_trust.AccessApplicationUpdateParamsBodySelfHostedApplication{
				Type:     cf.F(zero_trust.ApplicationTypeSelfHosted),
				Domain:   cf.F(domain),
				Policies: cf.F(updatePolicyLinks),
			},
		})
		if err != nil {
			return err
		}
		output.Logger.Info("updated web client access application to bypass", "application", application, "domain", domain)
		return nil
	}
	_, err := p.client.ZeroTrust.Access.Applications.New(ctx, zero_trust.AccessApplicationNewParams{
		AccountID: cf.F(boundary.AccountID),
		Body: zero_trust.AccessApplicationNewParamsBodySelfHostedApplication{
			Type:     cf.F(zero_trust.ApplicationTypeSelfHosted),
			Name:     cf.F(application + " web client"),
			Domain:   cf.F(domain),
			Policies: cf.F(policyLinks),
		},
	})
	if err != nil {
		return err
	}
	output.Logger.Info("created web client bypass access application", "application", application, "domain", domain)
	return nil
}

func oauthScopesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]struct{}{}
	for _, scope := range a {
		seen[strings.ToLower(scope)] = struct{}{}
	}
	for _, scope := range b {
		if _, ok := seen[strings.ToLower(scope)]; !ok {
			return false
		}
	}
	return true
}

func (p *cloudflareProvider) finalizeOAuthClientRotation(ctx context.Context, accountID, clientID string) error {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s/rotate_secret", accountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Delete(ctx, path, nil, envelope); err != nil {
		return fmt.Errorf("finalize oauth client rotation: %w", err)
	}
	if err := envelope.decode(&struct{}{}); err != nil {
		return err
	}
	output.Logger.Info("finalized oauth client secret rotation", "client_id", clientID)
	return nil
}

func (p *cloudflareProvider) DeleteApplicationOAuthClient(ctx context.Context, boundary core.TrustBoundary, clientID string) error {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s", boundary.AccountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Delete(ctx, path, nil, envelope); err != nil {
		return fmt.Errorf("delete oauth client: %w", err)
	}
	return envelope.decode(&struct{}{})
}

func (p *cloudflareProvider) RotateApplicationOAuthClientSecret(ctx context.Context, boundary core.TrustBoundary, clientID string) (string, error) {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s/rotate_secret", boundary.AccountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Post(ctx, path, nil, envelope); err != nil {
		if strings.Contains(err.Error(), "70721") {
			if deleteErr := p.finalizeOAuthClientRotation(ctx, boundary.AccountID, clientID); deleteErr != nil {
				return "", fmt.Errorf("clear rotated oauth client secret: %w", deleteErr)
			}
			envelope = &apiEnvelope{}
			if err := p.client.Post(ctx, path, nil, envelope); err != nil {
				return "", fmt.Errorf("rotate oauth client secret: %w", err)
			}
		} else {
			return "", fmt.Errorf("rotate oauth client secret: %w", err)
		}
	}
	result := &struct {
		ClientSecret string `json:"client_secret"`
	}{}
	if err := envelope.decode(result); err != nil {
		return "", err
	}
	if result.ClientSecret == "" {
		return "", fmt.Errorf("rotate oauth client secret returned empty secret")
	}
	output.Logger.Info("rotated application oauth client secret", "client_id", clientID)
	return result.ClientSecret, nil
}

func (p *cloudflareProvider) FinalizeApplicationOAuthClientRotation(ctx context.Context, boundary core.TrustBoundary, clientID string) error {
	return p.finalizeOAuthClientRotation(ctx, boundary.AccountID, clientID)
}

func (p *cloudflareProvider) updateOAuthClientScopes(ctx context.Context, accountID, clientID string, scopes []string) error {
	path := fmt.Sprintf("accounts/%s/oauth_clients/%s", accountID, clientID)
	envelope := &apiEnvelope{}
	if err := p.client.Patch(ctx, path, map[string]any{"scopes": scopes}, envelope); err != nil {
		return fmt.Errorf("update oauth client scopes: %w", err)
	}
	if err := envelope.decode(&struct{}{}); err != nil {
		return err
	}
	output.Logger.Info("updated oauth client scopes", "client_id", clientID, "scopes", strings.Join(scopes, ","))
	return nil
}

func (p *cloudflareProvider) EnsureApplicationOAuthClient(
	ctx context.Context,
	boundary core.TrustBoundary,
	application string,
	wantedScopes []string,
	callbackURL string,
) (string, string, []string, error) {
	scopes := cfcloud.WithOfflineAccess(cfcloud.FilterAvailableScopeIDs(p.availableOauthScopes(ctx), wantedScopes))
	if len(scopes) == 0 {
		return "", "", nil, fmt.Errorf("no provider oauth scopes are available for %s", application)
	}
	name := applicationOAuthClientName(application)
	path := fmt.Sprintf("accounts/%s/oauth_clients", boundary.AccountID)
	listEnvelope := &apiEnvelope{}
	if err := p.client.Get(ctx, path, nil, listEnvelope); err == nil {
		var existing []oauthClientInfo
		if err := listEnvelope.decode(&existing); err == nil {
			for _, candidate := range existing {
				if candidate.ClientName != name {
					continue
				}
				if !oauthScopesEqual(candidate.Scopes, scopes) {
					if err := p.updateOAuthClientScopes(ctx, boundary.AccountID, candidate.ClientID, scopes); err != nil {
						return "", "", nil, err
					}
				} else {
					output.Logger.Info("reusing application oauth client", "application", application, "client_id", candidate.ClientID)
				}
				return candidate.ClientID, "", scopes, nil
			}
		}
	}
	redirects := []string{
		strings.TrimRight(callbackURL, "/") + "/provider/oauth/callback",
		auth.RedirectURL,
		fmt.Sprintf("http://localhost:%d/callback", auth.CallbackPort),
	}
	body := map[string]any{
		"client_name":                name,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "client_secret_post",
		"redirect_uris":              redirects,
		"scopes":                     scopes,
		"visibility":                 "private",
	}
	createEnvelope := &apiEnvelope{}
	if err := p.client.Post(ctx, path, body, createEnvelope); err != nil {
		return "", "", nil, fmt.Errorf("create application oauth client: %w", err)
	}
	created := &oauthClientInfo{}
	if err := createEnvelope.decode(created); err != nil {
		return "", "", nil, fmt.Errorf("decode application oauth client response: %w", err)
	}
	if created.ClientSecret == "" {
		return "", "", nil, fmt.Errorf("cloudflare did not return a provider oauth client secret")
	}
	output.Logger.Info("created application oauth client", "application", application, "client_id", created.ClientID)
	return created.ClientID, created.ClientSecret, scopes, nil
}

func (p *cloudflareProvider) availableOauthScopes(ctx context.Context) map[string]string {
	envelope := &apiEnvelope{}
	if err := p.client.Get(ctx, "oauth/scopes", nil, envelope); err != nil {
		output.Fail("list oauth scopes: %v", err)
	}
	var scopes []struct {
		ID string `json:"id"`
	}
	if err := envelope.decode(&scopes); err != nil {
		output.Fail("decode oauth scopes: %v", err)
	}
	available := map[string]string{}
	for _, scope := range scopes {
		available[strings.ToLower(scope.ID)] = scope.ID
	}
	return available
}

func (p *cloudflareProvider) Bootstrap(ctx context.Context, boundary core.TrustBoundary, opts core.BootstrapOptions) (*core.BootstrapResult, error) {
	identityProviders, err := p.ListIdentityProviders(ctx, boundary)
	if err != nil {
		return nil, err
	}

	adminEmails := opts.EmailAllowlist
	groupSpecs := map[string][]string{
		core.GroupAdmins: adminEmails,
	}
	groups, err := p.EnsureGroups(ctx, boundary, groupSpecs)
	if err != nil {
		return nil, err
	}

	adminGroupIDs := []string{}
	if admins, ok := groups[core.GroupAdmins]; ok {
		adminGroupIDs = append(adminGroupIDs, admins.ID)
	}
	adminPolicyID, err := p.EnsureEmailAllowlistPolicy(ctx, boundary, adminEmails, adminGroupIDs)
	if err != nil {
		return nil, err
	}

	posture, err := p.SetPostureEnabled(ctx, boundary, opts.PostureEnabled, opts.PostureCheckName)
	if err != nil {
		return nil, err
	}

	policyIDs := []string{adminPolicyID}
	if posture.Enabled && posture.RuleID != "" {
		if posturePolicyID, err := p.ensurePostureAccessPolicy(ctx, boundary, posture.RuleID); err == nil {
			policyIDs = append(policyIDs, posturePolicyID)
		}
	}

	idpIDs := resolveIdentityProviderIDs(identityProviders, nil)
	if opts.DefaultIdPType != "" {
		idpIDs = resolveIdentityProviderIDs(identityProviders, []string{opts.DefaultIdPType})
	}

	_, accessClientID := p.findAccessApp(ctx, boundary.AccountID, opts.AccessAppName)
	if accessClientID == "" {
		created, err := p.CreateAccessApplication(ctx, boundary, core.AccessApplicationSpec{
			Name:          opts.AccessAppName,
			AllowedIdPIDs: idpIDs,
			PolicyIDs:     policyIDs,
		})
		if err != nil {
			return nil, err
		}
		accessClientID = created.ClientID
	} else {
		output.Logger.Info("reusing access application", "client_id", accessClientID)
	}

	subdomain := opts.WorkersDevSubdomain
	if subdomain == "" {
		subdomain = boundary.TeamName
	}
	if err := p.EnsureWorkersDevBypassApps(ctx, boundary, subdomain); err != nil {
		return nil, err
	}

	return &core.BootstrapResult{
		Boundary:           boundary,
		IdentityProviders:  identityProviders,
		Groups:             groups,
		EmailAllowlist:     adminEmails,
		AdminPolicyID:      adminPolicyID,
		Posture:            posture,
		AccessOIDCClientID: accessClientID,
	}, nil
}
