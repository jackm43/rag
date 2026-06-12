// Trust zone browser auth SDK (DESIGN.md Module 3).
//
// Brings the CLI's device-bound session design to the browser using Web Crypto:
// the DPoP key is a non-extractable ES256 CryptoKey persisted in IndexedDB, so
// even an XSS attacker who can read all storage cannot exfiltrate a usable
// session — they can only sign while their code runs in the live page.

const DB_NAME = "trustzone-auth";
const STORE = "auth";
const KEY_ID = "dpop-key";
const REFRESH_ID = "refresh-token";

// Stops redirect loops: set before handing off to the identity proxy, cleared
// when a callback completes. While set, ensureAuthenticated() will not start
// another redirect.
const LOGIN_GUARD = "tz_login_attempted";

export type SessionState =
  | { status: "none" }
  | { status: "active"; expiresAt: Date }
  | { status: "needs_login"; reason: string };

export type EnsureResult = "active" | "login_redirect" | "unauthenticated";

export type DiscoveryApplication = {
  name: string;
  audience: string;
  endpoint: string;
  description?: string;
};

export type DiscoveryConfig = {
  endpoints: Record<string, string>;
  oidc: {
    client_id: string;
    authorization_endpoint: string;
    token_endpoint: string;
    issuer: string;
  };
  applications?: DiscoveryApplication[];
};

export type TrustZoneWebAuthOptions = {
  // Hostnames routed onto this page's origin (zone worker routes), so calls
  // to them are same-origin and need no CORS. Keys are application names or
  // "gateway"; the rewrite keeps the path and swaps the origin.
  sameOrigin?: string[];
};

// Thrown when the session is gone and the caller must route back through
// ensureAuthenticated().
export class NeedsLoginError extends Error {
  readonly code = "needs_login";

  constructor() {
    super("needs_login");
    this.name = "NeedsLoginError";
  }
}

type StoredKey = { privateKey: CryptoKey; publicJwk: JsonWebKey };

type SessionTokens = { accessToken: string; refreshToken: string; expiresIn?: number | string };

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlJson = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const randomString = (bytes: number): string =>
  b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

const sha256 = (text: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

// ---- IndexedDB -----------------------------------------------------------

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const idbGet = async <T>(key: string): Promise<T | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve((tx.result as T | undefined) ?? null);
    tx.onerror = () => reject(tx.error);
  });
};

const idbPut = async (key: string, value: unknown): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const idbDelete = async (key: string): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// ---- DPoP key + proofs ---------------------------------------------------

// The private key is non-extractable; for ECDSA generateKey the public key is
// always extractable, so the public JWK can still go in the proof header.
const ensureDeviceKey = async (): Promise<StoredKey> => {
  const existing = await idbGet<StoredKey>(KEY_ID);
  if (existing?.privateKey) return existing;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const stored: StoredKey = { privateKey: pair.privateKey, publicJwk };
  await idbPut(KEY_ID, stored);
  return stored;
};

const createDpopProof = async (
  key: StoredKey,
  method: string,
  url: string,
  accessToken?: string,
): Promise<string> => {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const cleanUrl = new URL(url);
  cleanUrl.search = "";
  cleanUrl.hash = "";
  const payload: Record<string, unknown> = {
    htm: method.toUpperCase(),
    htu: cleanUrl.toString(),
    iat: Math.floor(Date.now() / 1000),
    jti: randomString(16),
  };
  if (accessToken) {
    payload.ath = b64url(await sha256(accessToken));
  }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(signature)}`;
};

// ---- gateway helpers -----------------------------------------------------

const connectPost = async <T>(url: string, body: unknown, dpopProof?: string): Promise<T> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "connect-protocol-version": "1",
  };
  if (dpopProof) headers.dpop = dpopProof;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      (parsed as { message?: string } | null)?.message ??
      `request to ${url} failed (${response.status})`;
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return parsed as T;
};

export class TrustZoneWebAuth {
  private readonly discoveryUrl: string;
  private readonly sameOrigin: string[];
  private config: DiscoveryConfig | null = null;
  private key: StoredKey | null = null;
  private sessionToken: { accessToken: string; expiresAt: number } | null = null;
  private readonly listeners = new Set<(state: SessionState) => void>();
  // Reason string once a session existed but is gone.
  private needsLogin: string | null = null;

  constructor(discoveryUrl: string, options: TrustZoneWebAuthOptions = {}) {
    this.discoveryUrl = discoveryUrl;
    this.sameOrigin = options.sameOrigin ?? [];
  }

  private rewrite(url: string): string {
    if (!url) return url;
    try {
      const parsed = new URL(url);
      return `${location.origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  onSessionChange(callback: (state: SessionState) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emit(state: SessionState): void {
    for (const callback of this.listeners) callback(state);
  }

  async init(): Promise<SessionState> {
    const response = await fetch(this.discoveryUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`discovery failed (${response.status})`);
    this.config = (await response.json()) as DiscoveryConfig;
    if (this.sameOrigin.includes("gateway")) {
      for (const key of Object.keys(this.config.endpoints ?? {})) {
        this.config.endpoints[key] = this.rewrite(this.config.endpoints[key]);
      }
    }
    for (const app of this.config.applications ?? []) {
      if (this.sameOrigin.includes(app.name)) {
        app.endpoint = location.origin;
      }
    }
    this.key = await ensureDeviceKey();
    const refresh = await idbGet<{ value: string }>(REFRESH_ID);
    if (refresh?.value) {
      try {
        await this.refresh(refresh.value);
        return this.state();
      } catch {
        await idbDelete(REFRESH_ID);
      }
    }
    return this.state();
  }

  state(): SessionState {
    if (this.sessionToken) {
      return { status: "active", expiresAt: new Date(this.sessionToken.expiresAt * 1000) };
    }
    if (this.needsLogin) {
      return { status: "needs_login", reason: this.needsLogin };
    }
    return { status: "none" };
  }

  isAuthenticated(): boolean {
    return this.state().status === "active";
  }

  // Ensures an active session for this page: silent refresh first, then
  // (unless interactive is false) a redirect login. Returns "active",
  // "login_redirect" (navigation to the identity proxy has started — stop
  // rendering), or "unauthenticated" (silent paths failed and either
  // interactive was off or a previous redirect already bounced back without
  // a session, so looping again would be pointless).
  async ensureAuthenticated({ interactive = true } = {}): Promise<EnsureResult> {
    if (this.isAuthenticated()) {
      sessionStorage.removeItem(LOGIN_GUARD);
      return "active";
    }
    const refresh = await idbGet<{ value: string }>(REFRESH_ID);
    if (refresh?.value) {
      try {
        await this.refresh(refresh.value);
        sessionStorage.removeItem(LOGIN_GUARD);
        return "active";
      } catch {
        await idbDelete(REFRESH_ID);
      }
    }
    if (!interactive || sessionStorage.getItem(LOGIN_GUARD)) {
      return "unauthenticated";
    }
    sessionStorage.setItem(LOGIN_GUARD, "1");
    await this.login();
    return "login_redirect";
  }

  // Redirect-based OIDC authorization code + PKCE login against the upstream
  // identity-aware proxy. Returns via handleRedirect() on the callback route.
  async login(): Promise<void> {
    const config = this.requireConfig();
    const verifier = randomString(48);
    const state = randomString(24);
    const challenge = b64url(await sha256(verifier));
    sessionStorage.setItem("tz_pkce_verifier", verifier);
    sessionStorage.setItem("tz_pkce_state", state);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.oidc.client_id,
      redirect_uri: `${location.origin}/callback`,
      scope: "openid email profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    location.assign(`${config.oidc.authorization_endpoint}?${params.toString()}`);
  }

  async handleRedirect(): Promise<SessionState> {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const verifier = sessionStorage.getItem("tz_pkce_verifier");
    const expectedState = sessionStorage.getItem("tz_pkce_state");
    sessionStorage.removeItem("tz_pkce_verifier");
    sessionStorage.removeItem("tz_pkce_state");
    if (!code || !returnedState || returnedState !== expectedState || !verifier) {
      throw new Error("invalid authorization callback");
    }
    // The gateway completes the PKCE token exchange server-side (the identity
    // proxy's token endpoint does not allow browser CORS) and returns a
    // device-bound session in the same call.
    const url = this.requireConfig().endpoints.session_create;
    const proof = await createDpopProof(this.requireKey(), "POST", url);
    const result = await connectPost<{ tokens: SessionTokens }>(
      url,
      {
        authorizationCode: code,
        codeVerifier: verifier,
        redirectUri: `${location.origin}/callback`,
      },
      proof,
    );
    await this.storeSession(result.tokens);
    sessionStorage.removeItem(LOGIN_GUARD);
    return this.state();
  }

  private async refresh(refreshToken: string): Promise<void> {
    const url = this.requireConfig().endpoints.session_refresh;
    const proof = await createDpopProof(this.requireKey(), "POST", url);
    const result = await connectPost<{ tokens: SessionTokens }>(url, { refreshToken }, proof);
    await this.storeSession(result.tokens);
  }

  private async storeSession(tokens: SessionTokens): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.sessionToken = {
      accessToken: tokens.accessToken,
      expiresAt: now + Number(tokens.expiresIn ?? 300),
    };
    this.needsLogin = null;
    await idbPut(REFRESH_ID, { value: tokens.refreshToken });
    this.emit(this.state());
  }

  // Marks the session as gone (refresh token missing or rejected) and tells
  // subscribers, so the app can route back through ensureAuthenticated().
  private sessionLost(reason: string): NeedsLoginError {
    this.sessionToken = null;
    this.needsLogin = reason;
    this.emit(this.state());
    return new NeedsLoginError();
  }

  private async sessionAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.sessionToken && now < this.sessionToken.expiresAt - 30) {
      return this.sessionToken.accessToken;
    }
    const refresh = await idbGet<{ value: string }>(REFRESH_ID);
    if (!refresh?.value) {
      throw this.sessionLost("expired");
    }
    try {
      await this.refresh(refresh.value);
    } catch {
      await idbDelete(REFRESH_ID);
      throw this.sessionLost("revoked");
    }
    return this.sessionToken!.accessToken;
  }

  application(name: string): DiscoveryApplication | null {
    return (this.config?.applications ?? []).find((app) => app.name === name) ?? null;
  }

  // Authorization headers for a request to any trust zone application: the
  // DPoP-bound session token plus a fresh proof for this exact method+URL
  // (with ath binding the proof to the token). The application validates the
  // sender constraint and mints its own audience token server-side via
  // client-credentials chaining — the browser never sees audiences, scopes,
  // or client secrets. The browser also roots the trace: a fresh traceparent
  // per request means every downstream hop (proxy, exchanges, services)
  // shares one trace id, so the full flow renders as a single trace.
  async authHeaders(method: string, url: string): Promise<Record<string, string>> {
    const token = await this.sessionAccessToken();
    const proof = await createDpopProof(this.requireKey(), method, url, token);
    return {
      authorization: `Bearer ${token}`,
      dpop: proof,
      traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
    };
  }

  // Calls a registered application's Connect endpoint as a dumb client.
  async call(application: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const app = this.application(application);
    if (!app?.endpoint) throw new Error(`unknown application ${application}`);
    const url = `${app.endpoint.replace(/\/$/, "")}${path}`;
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        ...(await this.authHeaders("POST", url)),
      },
      body: JSON.stringify(body ?? {}),
      ...init,
    });
  }

  // The gateway's own HTTP API base (same-origin when "gateway" is listed in
  // sameOrigin), for endpoints like /api/traces.
  gatewayOrigin(): string {
    return new URL(this.requireConfig().endpoints.token_exchange).origin;
  }

  // Authenticated GET against the gateway's HTTP API (session token + proof).
  async gatewayGet(path: string): Promise<Response> {
    const url = `${this.gatewayOrigin()}${path}`;
    return fetch(url, { headers: await this.authHeaders("GET", url) });
  }

  // Authenticated Connect RPC against the gateway itself (e.g. TraceService).
  async gatewayCall(path: string, body?: unknown): Promise<Response> {
    const url = `${this.gatewayOrigin()}${path}`;
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        ...(await this.authHeaders("POST", url)),
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  // Authenticated POST to this page's own application worker (the BFF), e.g.
  // registering a chat instance during client auth.
  async appPost(path: string, body?: unknown): Promise<Response> {
    const url = `${location.origin}${path}`;
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders("POST", url)),
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  async logout(): Promise<void> {
    const refresh = await idbGet<{ value: string }>(REFRESH_ID);
    if (refresh?.value) {
      try {
        await connectPost(this.requireConfig().endpoints.session_revoke, {
          refreshToken: refresh.value,
        });
      } catch {
        // best effort
      }
    }
    await idbDelete(REFRESH_ID);
    this.sessionToken = null;
    this.needsLogin = null;
    this.emit(this.state());
  }

  private requireConfig(): DiscoveryConfig {
    if (!this.config) throw new Error("init() has not completed");
    return this.config;
  }

  private requireKey(): StoredKey {
    if (!this.key) throw new Error("init() has not completed");
    return this.key;
  }
}
