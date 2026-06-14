// Trust zone browser auth SDK (DESIGN.md Module 3).
//
// Brings the CLI's device-bound session design to the browser using Web Crypto:
// the DPoP key is a non-extractable ES256 CryptoKey persisted in IndexedDB, so
// even an XSS attacker who can read all storage cannot exfiltrate a usable
// session — they can only sign while their code runs in the live page.

import { createDpopProof } from "@platy/sdk/oauth2/dpop";
import { createPlatformWebClient, type PlatformWebClientOptions, type PlatformWebClients } from "./platform-client";

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
  auth_providers?: Array<{ id: string; authorization_endpoint: string }>;
  applications?: DiscoveryApplication[];
};

export type AuthProvider = "access" | "discord";

export type BrowserAuthOptions = {
  provider?: AuthProvider;
  // Hostnames routed onto this page's origin (zone worker routes), so calls
  // to them are same-origin and need no CORS. Keys are application names or
  // "gateway"; the rewrite keeps the path and swaps the origin.
  sameOrigin?: string[];
  // Route OAuth token and revoke through the BFF (/client/session/*). The
  // browser still creates DPoP proofs with its device key; the BFF verifies
  // possession and forwards the grant to the gateway with the device jkt.
  sessionViaBff?: boolean;
};

export type BootstrapOptions = BrowserAuthOptions & {
  // Path the OIDC provider redirects back to. Defaults to "/callback".
  callbackPath?: string;
  // When false, a missing session resolves to "unauthenticated" instead of
  // starting an interactive login redirect.
  interactive?: boolean;
};

export type BootstrapResult = {
  auth: BrowserAuth;
  status: EnsureResult;
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
type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
};

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

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

// ---- gateway helpers -----------------------------------------------------

const oauthPost = async <T>(
  url: string,
  params: URLSearchParams,
  dpopProof?: string,
): Promise<T> => {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (dpopProof) headers.dpop = dpopProof;
  const response = await fetch(url, { method: "POST", headers, body: params.toString() });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      (parsed as { error_description?: string; message?: string } | null)?.error_description ??
      (parsed as { error_description?: string; message?: string } | null)?.message ??
      `request to ${url} failed (${response.status})`;
    const error = new Error(message) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return parsed as T;
};

const sessionTokensFromOAuth = (response: OAuthTokenResponse): SessionTokens => ({
  accessToken: response.access_token,
  refreshToken: response.refresh_token ?? "",
  expiresIn: response.expires_in,
});

export class BrowserAuth {
  private readonly discoveryUrl: string;
  private readonly sameOrigin: string[];
  private readonly sessionViaBff: boolean;
  private readonly provider: AuthProvider;
  private config: DiscoveryConfig | null = null;
  private key: StoredKey | null = null;
  private sessionToken: { accessToken: string; expiresAt: number } | null = null;
  private readonly listeners = new Set<(state: SessionState) => void>();
  // Reason string once a session existed but is gone.
  private needsLogin: string | null = null;

  constructor(discoveryUrl: string, options: BrowserAuthOptions = {}) {
    this.discoveryUrl = discoveryUrl;
    this.sameOrigin = options.sameOrigin ?? [];
    this.sessionViaBff = options.sessionViaBff ?? true;
    this.provider = options.provider ?? "access";
  }

  // bootstrap is the one-call page entry: fetch discovery and load the device
  // key (init), complete the OIDC callback when on the callback route, then
  // recover or refresh the session (ensureAuthenticated). Pages branch on the
  // returned status: "login_redirect" means navigation has started (stop
  // rendering); otherwise render using the returned auth instance.
  static async bootstrap(discoveryUrl: string, options: BootstrapOptions = {}): Promise<BootstrapResult> {
    const { callbackPath = "/callback", interactive = true, ...authOptions } = options;
    const auth = new BrowserAuth(discoveryUrl, authOptions);
    await auth.init();
    if (location.pathname === callbackPath) {
      await auth.handleRedirect();
      history.replaceState(null, "", "/");
      return { auth, status: auth.isAuthenticated() ? "active" : "unauthenticated" };
    }
    const status = await auth.ensureAuthenticated({ interactive });
    return { auth, status };
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
    callback(this.state());
    return () => this.listeners.delete(callback);
  }

  // Interactive sign-in for a user gesture: clears a stale login guard from a
  // prior abandoned redirect, reuses an existing session when present, and only
  // starts a new OIDC redirect when needed.
  async promptSignIn(): Promise<EnsureResult> {
    sessionStorage.removeItem(LOGIN_GUARD);
    return this.ensureAuthenticated({ interactive: true });
  }

  private emit(state: SessionState): void {
    for (const callback of this.listeners) callback(state);
  }

  async init(): Promise<SessionState> {
    const url = new URL(this.discoveryUrl, location.origin);
    url.searchParams.set("view", "bootstrap");
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`discovery failed (${response.status})`);
    this.config = (await response.json()) as DiscoveryConfig;
    if (this.sameOrigin.includes("gateway") && this.config.endpoints.discovery) {
      this.config.endpoints.discovery = this.rewrite(this.config.endpoints.discovery);
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
    const redirectUri = `${location.origin}/callback`;
    if (this.provider === "discord") {
      const endpoint =
        config.auth_providers?.find((provider) => provider.id === "discord")?.authorization_endpoint ??
        config.endpoints.discord_authorize ??
        "";
      if (!endpoint) {
        throw new Error("discord auth provider is not configured");
      }
      const params = new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });
      location.assign(`${endpoint}?${params.toString()}`);
      return;
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.oidc.client_id,
      redirect_uri: redirectUri,
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
    // Device-bound session: the browser signs this token request with its own
    // DPoP key; the BFF verifies possession and forwards the grant to the gateway.
    const url = this.sessionTokenUrl();
    const proof = await createDpopProof(this.requireKey(), { method: "POST", url });
    const result = await oauthPost<OAuthTokenResponse>(
      url,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: `${location.origin}/callback`,
      }),
      proof,
    );
    await this.storeSession(sessionTokensFromOAuth(result));
    sessionStorage.removeItem(LOGIN_GUARD);
    return this.state();
  }

  private async refresh(refreshToken: string): Promise<void> {
    const url = this.sessionTokenUrl();
    const proof = await createDpopProof(this.requireKey(), { method: "POST", url });
    const result = await oauthPost<OAuthTokenResponse>(
      url,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      proof,
    );
    await this.storeSession(sessionTokensFromOAuth(result));
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

  applicationEndpoint(name: string): string | null {
    if (this.sameOrigin.includes(name)) {
      return location.origin;
    }
    const registered = (this.config?.applications ?? []).find((app) => app.name === name);
    return registered?.endpoint ?? null;
  }

  application(name: string): DiscoveryApplication | null {
    const endpoint = this.applicationEndpoint(name);
    if (!endpoint) {
      return null;
    }
    const registered = (this.config?.applications ?? []).find((app) => app.name === name);
    return { name, audience: registered?.audience ?? name, endpoint };
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
    const proof = await createDpopProof(this.requireKey(), { method, url }, token);
    return {
      authorization: `Bearer ${token}`,
      dpop: proof,
      traceparent: `00-${randomHex(16)}-${randomHex(8)}-01`,
    };
  }

  async request(application: string, path: string, init: RequestInit = {}): Promise<Response> {
    const app = this.application(application);
    if (!app?.endpoint) throw new Error(`unknown application ${application}`);
    const method = init.method ?? "GET";
    const url = `${app.endpoint.replace(/\/$/, "")}${path}`;
    return fetch(url, {
      ...init,
      method,
      headers: {
        ...(await this.authHeaders(method, url)),
        ...(init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : Array.isArray(init.headers)
            ? Object.fromEntries(init.headers)
            : init.headers ?? {}),
      },
    });
  }

  platformClient(application: string, options: PlatformWebClientOptions = {}): PlatformWebClients {
    return createPlatformWebClient(this, application, options);
  }

  private sessionTokenUrl(): string {
    if (this.sessionViaBff) {
      return `${location.origin}/client/session/token`;
    }
    return this.requireConfig().endpoints.token_exchange;
  }

  private sessionRevokeUrl(): string {
    if (this.sessionViaBff) {
      return `${location.origin}/client/session/revoke`;
    }
    return this.requireConfig().endpoints.token_revoke;
  }

  gatewayOrigin(): string {
    if (this.sessionViaBff) {
      return new URL(this.requireConfig().endpoints.token_exchange).origin;
    }
    return new URL(this.sessionTokenUrl()).origin;
  }

  // Authenticated GET against the gateway's HTTP API (session token + proof).
  async gatewayGet(path: string): Promise<Response> {
    const url = `${this.gatewayOrigin()}${path}`;
    return fetch(url, { headers: await this.authHeaders("GET", url) });
  }

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
        await oauthPost(
          this.sessionRevokeUrl(),
          new URLSearchParams({
            token: refresh.value,
            token_type_hint: "refresh_token",
          }),
        );
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
