package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	cf "github.com/cloudflare/cloudflare-go/v6"
	"github.com/cloudflare/cloudflare-go/v6/zero_trust"

	"jsmunro.me/platy/cli/internal/output"
	"jsmunro.me/platy/cli/internal/provider/core"
)

func (p *cloudflareProvider) EnsureOrganization(ctx context.Context, boundary core.TrustBoundary, input core.EnsureOrganizationInput) (core.OrganizationPolicy, error) {
	organization := input.Organization
	subdomain := input.WorkersDevSubdomain
	if subdomain == "" {
		subdomain = boundary.TeamName
	}

	if err := p.ensureOrganizationMFA(ctx, boundary, organization); err != nil {
		return organization, err
	}

	if err := p.ensureGatewaySettings(ctx, boundary.AccountID, organization.ZeroTrust.Gateway); err != nil {
		return organization, err
	}
	if organization.ZeroTrust.Devices.GatewayProxyEnabled {
		if err := p.ensureDeviceSettings(ctx, boundary.AccountID, organization.ZeroTrust.Devices); err != nil {
			return organization, err
		}
	}

	for _, tier := range core.TrustZones {
		zone, ok := organization.TrustZones[tier]
		if !ok {
			continue
		}
		policyID, err := p.ensureTierAccessPolicy(ctx, boundary, tier, zone, input)
		if err != nil {
			return organization, fmt.Errorf("ensure %s policy: %w", tier, err)
		}
		zone.Provisioned.PolicyID = policyID
		organization.TrustZones[tier] = zone
	}

	enrollZone := organization.TrustZones[core.Tier3]
	appID, domain, staffPolicyID, contractorPolicyIDs, err := p.ensureEnrollAccessApp(ctx, boundary, subdomain, enrollZone, input)
	if err != nil {
		return organization, fmt.Errorf("ensure enroll application: %w", err)
	}
	enrollZone.Provisioned.AccessAppID = appID
	enrollZone.Provisioned.Domain = domain
	if staffPolicyID != "" {
		enrollZone.Provisioned.PolicyID = staffPolicyID
	}
	organization.TrustZones[core.Tier3] = enrollZone
	for _, policyID := range contractorPolicyIDs {
		output.Logger.Info("provisioned enroll contractor policy", "id", policyID)
	}

	output.Logger.Info("provisioned organization trust zones", "account_id", boundary.AccountID)
	return organization, nil
}

func (p *cloudflareProvider) ensureGatewaySettings(ctx context.Context, accountID string, settings core.ZeroTrustGatewaySettings) error {
	mode := zero_trust.GatewayConfigurationSettingsInspectionModeStatic
	if settings.TLSDecrypt && strings.EqualFold(settings.InspectionMode, "dynamic") {
		mode = zero_trust.GatewayConfigurationSettingsInspectionModeDynamic
	}
	dynamicInspection := settings.TLSDecrypt && mode == zero_trust.GatewayConfigurationSettingsInspectionModeDynamic
	_, err := p.client.ZeroTrust.Gateway.Configurations.Edit(ctx, zero_trust.GatewayConfigurationEditParams{
		AccountID: cf.F(accountID),
		Settings: cf.F(zero_trust.GatewayConfigurationSettingsParam{
			TLSDecrypt: cf.F(zero_trust.TLSSettingsParam{Enabled: cf.F(settings.TLSDecrypt)}),
			Inspection: cf.F(zero_trust.GatewayConfigurationSettingsInspectionParam{
				Mode: cf.F(mode),
			}),
			ProtocolDetection: cf.F(zero_trust.ProtocolDetectionParam{
				Enabled: cf.F(dynamicInspection),
			}),
		}),
	})
	if err != nil {
		return fmt.Errorf("configure gateway tls inspection: %w", err)
	}
	output.Logger.Info("configured gateway traffic inspection", "account_id", accountID, "tls_decrypt", settings.TLSDecrypt, "inspection_mode", mode)
	return nil
}

func (p *cloudflareProvider) ensureDeviceSettings(ctx context.Context, accountID string, settings core.ZeroTrustDeviceSettings) error {
	_, err := p.client.ZeroTrust.Devices.Settings.Edit(ctx, zero_trust.DeviceSettingEditParams{
		AccountID: cf.F(accountID),
		DeviceSettings: zero_trust.DeviceSettingsParam{
			GatewayProxyEnabled:    cf.F(settings.GatewayProxyEnabled),
			GatewayUdpProxyEnabled: cf.F(settings.GatewayUdpProxyEnabled),
		},
	})
	if err != nil {
		return fmt.Errorf("configure device gateway proxy: %w", err)
	}
	output.Logger.Info("configured device gateway proxy filtering", "account_id", accountID)
	return nil
}

func (p *cloudflareProvider) findAccessPolicyID(ctx context.Context, accountID, name string) (string, bool) {
	pager := p.client.ZeroTrust.Access.Policies.ListAutoPaging(ctx, zero_trust.AccessPolicyListParams{
		AccountID: cf.F(accountID),
	})
	for pager.Next() {
		policy := pager.Current()
		if policy.Name == name {
			return policy.ID, true
		}
	}
	if err := pager.Err(); err != nil {
		output.Fail("list access policies: %v", err)
	}
	return "", false
}

func (p *cloudflareProvider) ensureAccessPolicy(ctx context.Context, accountID string, params zero_trust.AccessPolicyNewParams) (string, error) {
	if id, ok := p.findAccessPolicyID(ctx, accountID, params.Name.Value); ok {
		output.Logger.Info("reusing access policy", "id", id, "name", params.Name.Value)
		return id, nil
	}
	policy, err := p.client.ZeroTrust.Access.Policies.New(ctx, params)
	if err != nil {
		return "", err
	}
	output.Logger.Info("created access policy", "id", policy.ID, "name", params.Name.Value)
	return policy.ID, nil
}

func groupIncludeRules(groups map[string]core.AccessGroup, names ...string) []zero_trust.AccessRuleUnionParam {
	rules := []zero_trust.AccessRuleUnionParam{}
	for _, name := range names {
		group, ok := groups[name]
		if !ok {
			continue
		}
		rules = append(rules, zero_trust.GroupRuleParam{
			Group: cf.F(zero_trust.GroupRuleGroupParam{ID: cf.F(group.ID)}),
		})
	}
	if len(rules) == 0 {
		rules = append(rules, everyoneIncludeRule())
	}
	return rules
}

func everyoneIncludeRule() zero_trust.AccessRuleUnionParam {
	return zero_trust.EveryoneRuleParam{
		Everyone: cf.F(zero_trust.EveryoneRuleEveryoneParam{}),
	}
}

func postureRequireRules(postureRuleID string) []zero_trust.AccessRuleUnionParam {
	if postureRuleID == "" {
		return nil
	}
	return []zero_trust.AccessRuleUnionParam{
		zero_trust.AccessDevicePostureRuleParam{
			DevicePosture: cf.F(zero_trust.AccessDevicePostureRuleDevicePostureParam{
				IntegrationUID: cf.F(postureRuleID),
			}),
		},
	}
}

func accessPolicyMFAConfig(config *core.AccessPolicyMFAConfig) zero_trust.AccessPolicyNewParamsMfaConfig {
	mfa := zero_trust.AccessPolicyNewParamsMfaConfig{
		MfaDisabled: cf.F(false),
		AllowedAuthenticators: cf.F([]zero_trust.AccessPolicyNewParamsMfaConfigAllowedAuthenticator{
			zero_trust.AccessPolicyNewParamsMfaConfigAllowedAuthenticatorTotp,
			zero_trust.AccessPolicyNewParamsMfaConfigAllowedAuthenticatorBiometrics,
			zero_trust.AccessPolicyNewParamsMfaConfigAllowedAuthenticatorSecurityKey,
		}),
	}
	if config != nil && config.SessionDuration != "" {
		mfa.SessionDuration = cf.F(config.SessionDuration)
	}
	return mfa
}

func applyAccessPolicySpec(
	params *zero_trust.AccessPolicyNewParams,
	spec core.AccessPolicySpec,
	postureRuleID string,
) {
	if spec.ApprovalRequired {
		params.ApprovalRequired = cf.F(true)
	}
	if spec.PurposeJustificationRequired {
		params.PurposeJustificationRequired = cf.F(true)
	}
	if spec.SessionDuration != "" {
		params.SessionDuration = cf.F(spec.SessionDuration)
	}
	if spec.IsolationRequired {
		params.IsolationRequired = cf.F(true)
	}
	if spec.MFAConfig != nil {
		params.MfaConfig = cf.F(accessPolicyMFAConfig(spec.MFAConfig))
	}
	if spec.RequirePosture {
		params.Require = cf.F(postureRequireRules(postureRuleID))
	}
}

func (p *cloudflareProvider) ensureTierAccessPolicy(
	ctx context.Context,
	boundary core.TrustBoundary,
	tier string,
	zone core.TrustZoneSpec,
	input core.EnsureOrganizationInput,
) (string, error) {
	if tier == core.Tier3 {
		return "", nil
	}

	name := core.TierPolicyName(tier)
	params := zero_trust.AccessPolicyNewParams{
		AccountID: cf.F(boundary.AccountID),
		Decision:  cf.F(zero_trust.DecisionAllow),
		Name:      cf.F(name),
	}

	switch tier {
	case core.Tier0:
		params.Include = cf.F(groupIncludeRules(input.Groups, core.GroupAdmins))
	case core.Tier1:
		params.Include = cf.F(groupIncludeRules(input.Groups, core.GroupEnrolled, core.GroupAdmins))
	case core.Tier2:
		params.Include = cf.F(groupIncludeRules(input.Groups, core.GroupEnrolled, core.GroupUsers, core.GroupAdmins))
	default:
		return "", fmt.Errorf("unsupported tier %q", tier)
	}

	applyAccessPolicySpec(&params, zone.AccessPolicy, input.PostureRuleID)
	if zone.AccessPolicy.ApprovalRequired {
		params.ApprovalGroups = cf.F([]zero_trust.ApprovalGroupParam{{
			ApprovalsNeeded: cf.F(1.0),
			EmailAddresses:  cf.F(input.EmailAllowlist),
		}})
	}

	return p.ensureAccessPolicy(ctx, boundary.AccountID, params)
}

func (p *cloudflareProvider) ensureOrganizationMFA(ctx context.Context, boundary core.TrustBoundary, organization core.OrganizationPolicy) error {
	needsMFA := false
	for _, tier := range core.TrustZones {
		zone, ok := organization.TrustZones[tier]
		if ok && zone.AccessPolicy.MFAConfig != nil {
			needsMFA = true
			break
		}
	}
	if !needsMFA {
		return nil
	}
	authDomain := authDomainFromBoundary(boundary)
	if authDomain == "" {
		return fmt.Errorf("configure organization mfa: zero trust auth_domain is unavailable")
	}
	sessionDuration := organizationMFAConfigSessionDuration(organization)
	mfaConfig := zero_trust.OrganizationUpdateParamsMfaConfig{
		AllowedAuthenticators: cf.F([]zero_trust.OrganizationUpdateParamsMfaConfigAllowedAuthenticator{
			zero_trust.OrganizationUpdateParamsMfaConfigAllowedAuthenticatorTotp,
			zero_trust.OrganizationUpdateParamsMfaConfigAllowedAuthenticatorBiometrics,
			zero_trust.OrganizationUpdateParamsMfaConfigAllowedAuthenticatorSecurityKey,
		}),
	}
	if sessionDuration != "" {
		mfaConfig.SessionDuration = cf.F(sessionDuration)
	}
	_, err := p.client.ZeroTrust.Organizations.Update(ctx, zero_trust.OrganizationUpdateParams{
		AccountID:  cf.F(boundary.AccountID),
		AuthDomain: cf.F(authDomain),
		MfaConfig:  cf.F(mfaConfig),
	})
	if err != nil {
		return fmt.Errorf("configure organization mfa: %w", err)
	}
	output.Logger.Info("configured organization mfa authenticators", "account_id", boundary.AccountID)
	return nil
}

func authDomainFromBoundary(boundary core.TrustBoundary) string {
	if authDomain, ok := boundary.Organization["auth_domain"].(string); ok {
		authDomain = strings.TrimSpace(authDomain)
		authDomain = strings.TrimPrefix(authDomain, "https://")
		authDomain = strings.TrimPrefix(authDomain, "http://")
		authDomain = strings.TrimRight(authDomain, "/")
		if authDomain != "" {
			return authDomain
		}
	}
	if boundary.TeamName != "" {
		return boundary.TeamName + ".cloudflareaccess.com"
	}
	return ""
}

func organizationMFAConfigSessionDuration(organization core.OrganizationPolicy) string {
	for _, tier := range core.TrustZones {
		zone, ok := organization.TrustZones[tier]
		if !ok || zone.AccessPolicy.MFAConfig == nil {
			continue
		}
		if duration := strings.TrimSpace(zone.AccessPolicy.MFAConfig.SessionDuration); duration != "" {
			return duration
		}
	}
	return "24h"
}

func (p *cloudflareProvider) ensureEnrollAccessApp(
	ctx context.Context,
	boundary core.TrustBoundary,
	subdomain string,
	zone core.TrustZoneSpec,
	input core.EnsureOrganizationInput,
) (appID, domain, staffPolicyID string, contractorPolicyIDs []string, err error) {
	domain = fmt.Sprintf("enroll.%s.workers.dev", subdomain)
	enroll := zone.Enroll

	staffPolicyID, err = p.ensureEnrollStaffPolicy(ctx, boundary, enroll, input.PostureRuleID)
	if err != nil {
		return "", "", "", nil, err
	}
	contractorPolicyIDs, err = p.ensureEnrollContractorPolicies(ctx, boundary, enroll, input.PostureRuleID)
	if err != nil {
		return "", "", "", nil, err
	}

	policyLinks := []zero_trust.AccessApplicationNewParamsBodySelfHostedApplicationPolicyUnion{}
	for _, policyID := range append([]string{staffPolicyID}, contractorPolicyIDs...) {
		if policyID == "" {
			continue
		}
		policyLinks = append(policyLinks, zero_trust.AccessApplicationNewParamsBodySelfHostedApplicationPoliciesAccessAppPolicyLink{
			ID:         cf.F(policyID),
			Precedence: cf.F(int64(len(policyLinks) + 1)),
		})
	}
	if len(policyLinks) == 0 {
		return "", domain, "", nil, nil
	}

	if existingID := p.findSelfHostedAccessAppID(ctx, boundary.AccountID, domain); existingID != "" {
		output.Logger.Info("reusing enroll access application", "id", existingID, "domain", domain)
		return existingID, domain, staffPolicyID, contractorPolicyIDs, nil
	}

	allowedIdPs := resolveIdentityProviderIDs(input.IdentityProviders, enrollStaffIdPRefs(enroll))
	response, err := p.client.ZeroTrust.Access.Applications.New(ctx, zero_trust.AccessApplicationNewParams{
		AccountID: cf.F(boundary.AccountID),
		Body: zero_trust.AccessApplicationNewParamsBodySelfHostedApplication{
			Type:        cf.F(zero_trust.ApplicationTypeSelfHosted),
			Name:        cf.F(core.EnrollAppName),
			Domain:      cf.F(domain),
			AllowedIdPs: cf.F(allowedIdPs),
			Policies:    cf.F(policyLinks),
		},
	})
	if err != nil {
		return "", "", "", nil, err
	}
	output.Logger.Info("created enroll access application", "id", response.ID, "domain", domain)
	return response.ID, domain, staffPolicyID, contractorPolicyIDs, nil
}

func enrollStaffIdPRefs(enroll core.EnrollPolicy) []string {
	if len(enroll.Staff.IdPTypes) == 0 {
		return nil
	}
	return enroll.Staff.IdPTypes
}

func (p *cloudflareProvider) ensureEnrollStaffPolicy(ctx context.Context, boundary core.TrustBoundary, enroll core.EnrollPolicy, postureRuleID string) (string, error) {
	if len(enroll.Staff.IdPTypes) == 0 && !enroll.Staff.RequirePosture {
		return "", nil
	}
	params := zero_trust.AccessPolicyNewParams{
		AccountID: cf.F(boundary.AccountID),
		Decision:  cf.F(zero_trust.DecisionAllow),
		Name:      cf.F(core.PolicyEnrollStaff),
		Include:   cf.F([]zero_trust.AccessRuleUnionParam{everyoneIncludeRule()}),
	}
	if enroll.Staff.RequirePosture {
		params.Require = cf.F(postureRequireRules(postureRuleID))
	}
	return p.ensureAccessPolicy(ctx, boundary.AccountID, params)
}

func (p *cloudflareProvider) ensureEnrollContractorPolicies(ctx context.Context, boundary core.TrustBoundary, enroll core.EnrollPolicy, postureRuleID string) ([]string, error) {
	if !enroll.Contractor.RequireWarpOrRBI {
		return nil, nil
	}
	ids := []string{}
	rbiParams := zero_trust.AccessPolicyNewParams{
		AccountID:         cf.F(boundary.AccountID),
		Decision:          cf.F(zero_trust.DecisionAllow),
		Name:              cf.F(core.PolicyEnrollContractorRBI),
		Include:           cf.F([]zero_trust.AccessRuleUnionParam{everyoneIncludeRule()}),
		IsolationRequired: cf.F(true),
	}
	rbiID, err := p.ensureAccessPolicy(ctx, boundary.AccountID, rbiParams)
	if err != nil {
		return nil, err
	}
	ids = append(ids, rbiID)
	if postureRuleID != "" {
		warpParams := zero_trust.AccessPolicyNewParams{
			AccountID: cf.F(boundary.AccountID),
			Decision:  cf.F(zero_trust.DecisionAllow),
			Name:      cf.F(core.PolicyEnrollContractorWarp),
			Include:   cf.F([]zero_trust.AccessRuleUnionParam{everyoneIncludeRule()}),
			Require:   cf.F(postureRequireRules(postureRuleID)),
		}
		warpID, err := p.ensureAccessPolicy(ctx, boundary.AccountID, warpParams)
		if err != nil {
			return nil, err
		}
		ids = append(ids, warpID)
	}
	return ids, nil
}

func (p *cloudflareProvider) findSelfHostedAccessAppID(ctx context.Context, accountID, domain string) string {
	pager := p.client.ZeroTrust.Access.Applications.ListAutoPaging(ctx, zero_trust.AccessApplicationListParams{
		AccountID: cf.F(accountID),
		Domain:    cf.F(domain),
	})
	for pager.Next() {
		app := pager.Current()
		var decoded struct {
			ID     string `json:"id"`
			Domain string `json:"domain"`
		}
		if err := json.Unmarshal([]byte(app.JSON.RawJSON()), &decoded); err != nil {
			continue
		}
		if strings.EqualFold(decoded.Domain, domain) {
			return decoded.ID
		}
	}
	if err := pager.Err(); err != nil {
		output.Fail("list access applications for %s: %v", domain, err)
	}
	return ""
}
