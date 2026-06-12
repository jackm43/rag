package identity

type Principal struct {
	Kind  string   `json:"kind"`
	Sub   string   `json:"sub"`
	Email string   `json:"email,omitempty"`
	Act   []string `json:"act,omitempty"`
}

func NewPrincipal(kind, sub, email string, act []string) Principal {
	p := Principal{Kind: kind, Sub: sub, Email: email}
	if len(act) > 0 {
		p.Act = append([]string(nil), act...)
	}
	return p
}

func PrincipalMap(principal Principal) map[string]any {
	fields := map[string]any{
		"kind": principal.Kind,
		"sub":  principal.Sub,
	}
	if principal.Email != "" {
		fields["email"] = principal.Email
	}
	if len(principal.Act) > 0 {
		fields["act"] = principal.Act
	}
	return fields
}

type ExchangeLog struct {
	Audience         string     `json:"audience"`
	SubjectTokenType string     `json:"subject_token_type"`
	ActorTokenType   string     `json:"actor_token_type,omitempty"`
	Act              string     `json:"act,omitempty"`
	Impersonation    bool       `json:"impersonation,omitempty"`
	Principal        *Principal `json:"principal,omitempty"`
	Scopes           []string   `json:"scopes,omitempty"`
	Reason           string     `json:"reason,omitempty"`
}

func ExchangeRefusedLog(
	audience, subjectTokenType, actorTokenType, act, reason string,
	impersonation bool,
	principal *Principal,
) []any {
	fields := []any{
		"audience", audience,
		"subject_token_type", subjectTokenType,
	}
	if actorTokenType != "" {
		fields = append(fields, "actor_token_type", actorTokenType)
	}
	if act != "" {
		fields = append(fields, "act", act)
	}
	if impersonation {
		fields = append(fields, "impersonation", true)
	}
	if principal != nil {
		fields = append(fields, "principal", PrincipalMap(*principal))
	}
	if reason != "" {
		fields = append(fields, "reason", reason)
	}
	return fields
}

func ExchangedLog(
	audience, subjectTokenType, actorTokenType, act string,
	impersonation bool,
	principal *Principal,
	scopes []string,
) []any {
	fields := ExchangeRefusedLog(audience, subjectTokenType, actorTokenType, act, "", impersonation, principal)
	if len(scopes) > 0 {
		fields = append(fields, "scopes", scopes)
	}
	return fields
}
