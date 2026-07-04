// Common JWT claim vocabulary used by service identity tokens and the
// request-placement control plane. Keep this small and standard: domain
// catalogs can add their own metadata around it without redefining iss/sub/aud
// differently in each package.
export type JwtClaims<Issuer extends string = string, Audience extends string = string> = {
  iss: Issuer;
  sub: string;
  aud: Audience;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
};

export type CorrelatedJwtClaims<Issuer extends string = string, Audience extends string = string> =
  JwtClaims<Issuer, Audience> & {
    correlationId?: string;
  };
