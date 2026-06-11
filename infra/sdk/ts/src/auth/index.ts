export {
  anyAuthenticator,
  bearerToken,
  oidcAuthenticator,
  requireSenderConstraint,
  stsAuthenticator,
  type Authenticator,
} from "./authenticators";
export { defaultScope, protect, requireIdentity, type AuthPolicy } from "./protect";
