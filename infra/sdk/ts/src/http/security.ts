export const DEFAULT_CSRF_SAFE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;

export const DEFAULT_CSRF_FORM_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
] as const;

export interface PlatformSecurityPolicy {
  csrf: {
    enabled: true;
    safeMethods: readonly string[];
    protectedContentTypes: readonly string[];
    allowRouteOptOutWithAlternateVerifier: true;
  };
  secureHeaders: {
    enabled: true;
    contentSecurityPolicy: Record<string, readonly string[]>;
    strictTransportSecurity: string;
    xContentTypeOptions: "nosniff";
    xFrameOptions: "DENY" | "SAMEORIGIN";
    referrerPolicy: "no-referrer";
  };
  xss: {
    jsonOnlyApis: true;
    reflectiveHtmlFromApiInputs: false;
    browserCredentialsExposeProviderTokens: false;
  };
}

export const DEFAULT_CONTENT_SECURITY_POLICY: Record<string, readonly string[]> = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  imgSrc: ["'self'", "data:"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'"],
  upgradeInsecureRequests: [],
};

export const DEFAULT_PLATFORM_SECURITY_POLICY: PlatformSecurityPolicy = {
  csrf: {
    enabled: true,
    safeMethods: DEFAULT_CSRF_SAFE_METHODS,
    protectedContentTypes: DEFAULT_CSRF_FORM_CONTENT_TYPES,
    allowRouteOptOutWithAlternateVerifier: true,
  },
  secureHeaders: {
    enabled: true,
    contentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    xContentTypeOptions: "nosniff",
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
  },
  xss: {
    jsonOnlyApis: true,
    reflectiveHtmlFromApiInputs: false,
    browserCredentialsExposeProviderTokens: false,
  },
};

export function isCsrfSafeMethod(method: string): boolean {
  return DEFAULT_CSRF_SAFE_METHODS.includes(method.toUpperCase() as (typeof DEFAULT_CSRF_SAFE_METHODS)[number]);
}

export function isCsrfProtectedContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return DEFAULT_CSRF_FORM_CONTENT_TYPES.includes(
    normalized as (typeof DEFAULT_CSRF_FORM_CONTENT_TYPES)[number],
  );
}

