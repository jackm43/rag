export enum OAuthErrorCode {
  InvalidArgument = "invalid_argument",
  Unauthenticated = "unauthenticated",
  PermissionDenied = "permission_denied",
  NotFound = "not_found",
  FailedPrecondition = "failed_precondition",
}

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;

  constructor(message: string, code: OAuthErrorCode) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}
