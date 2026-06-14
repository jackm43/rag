import { logger } from "./logger";

export type IdentityKind = "user" | "service" | "platform";

export type Identity = {
  kind: IdentityKind;
  subject: string;
  email: string | null;
  scopes: string[];
  actorChain: string[];
  cnfJkt?: string | null;
  sessionId?: string | null;
  subjectToken?: string | null;
  clientInstance?: string | null;
  clientKind?: string | null;
};

export const identityKey = Symbol("platy.identity");

export type Principal = {
  kind: IdentityKind;
  sub: string;
  email?: string;
  act?: string[];
};

export const principalFromIdentity = (
  identity: Pick<Identity, "kind" | "subject" | "email" | "actorChain">,
): Principal => ({
  kind: identity.kind,
  sub: identity.subject,
  ...(identity.email ? { email: identity.email } : {}),
  ...(identity.actorChain.length > 0 ? { act: identity.actorChain } : {}),
});

export type IdentityExchangeLog = {
  audience: string;
  subject_token_type: string;
  actor_token_type?: string;
  act?: string;
  impersonation?: boolean;
  principal?: Principal;
  scopes?: string[];
  reason?: string;
  status?: number;
};

export const identityExchangeRefused = (fields: IdentityExchangeLog): void => {
  logger.warn("identity_exchange_refused", fields);
};

export const identityExchanged = (fields: IdentityExchangeLog): void => {
  logger.info("identity_exchanged", fields);
};
