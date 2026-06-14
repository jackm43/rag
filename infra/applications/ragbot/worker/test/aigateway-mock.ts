import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { TOKEN_TYPE_SERVICE_CREDENTIAL } from "@platy/sdk";

export const GATEWAY_ISSUER = "https://auth-gateway.example.com";
export const TEST_SERVICE_CLIENT_ID = "svc_ragbot_test";
export const TEST_SERVICE_CLIENT_SECRET = "ragbot-test-secret";

export type AiCompleteRequest = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
};

type CompleteHandler = (
  request: AiCompleteRequest,
  callIndex: number,
) => { content: string; model?: string };

type StreamHandler = () => {
  deltas: string[];
  final: { content: string; model?: string };
};

const jwtSubject = (token: string): string => {
  const payload = token.split(".")[1];
  if (!payload) {
    return TEST_SERVICE_CLIENT_ID;
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string };
  return decoded.sub ?? TEST_SERVICE_CLIENT_ID;
};

const readJsonBody = async (init?: RequestInit): Promise<Record<string, unknown>> => {
  if (!init?.body) {
    return {};
  }
  const text = typeof init.body === "string"
    ? init.body
    : new TextDecoder().decode(await new Response(init.body as BodyInit).arrayBuffer());
  const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
  return parsed.data ?? parsed;
};

export const createAigatewayTestHarness = await (async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "sts-test-kid";
  jwk.alg = "ES256";
  jwk.use = "sig";

  const discovery = {
    issuer: GATEWAY_ISSUER,
    jwksUri: `${GATEWAY_ISSUER}/.well-known/jwks.json`,
    endpoints: {
      tokenExchange: `${GATEWAY_ISSUER}/oauth/token`,
      tokenRevoke: `${GATEWAY_ISSUER}/oauth/revoke`,
      introspect: `${GATEWAY_ISSUER}/oauth/introspect`,
      discovery: `${GATEWAY_ISSUER}/api/discovery`,
      jwks: `${GATEWAY_ISSUER}/.well-known/jwks.json`,
    },
    oidc: {
      issuer: "https://access.test",
      clientId: "access-client",
      authorizationEndpoint: "https://access.test/authorization",
      tokenEndpoint: "https://access.test/token",
      jwksEndpoint: "https://access.test/jwks",
    },
    applications: [
      {
        name: "ragbot",
        audience: "ragbot",
        endpoint: "https://example.com",
        delegations: [
          {
            audience: "aigateway",
            scopes: ["aigateway/ChatService.Complete", "aigateway/ChatService.StreamComplete"],
          },
        ],
        resources: [],
      },
      {
        name: "aigateway",
        audience: "aigateway",
        endpoint: "https://aigateway.test",
        delegations: [{ audience: "ragbot", scopes: [] }],
        resources: [],
      },
    ],
    provider: {},
  };

  const signToken = (options: {
    audience?: string;
    scope?: string;
    subject?: string;
    kind?: string;
    act?: string;
  } = {}) =>
    new SignJWT({
      email: options.kind === "service" ? undefined : "jack@jsmunro.me",
      scope: options.scope ?? "ragbot/*",
      kind: options.kind ?? "user",
      ...(options.act ? { act: { sub: options.act } } : {}),
    })
      .setProtectedHeader({ alg: "ES256", kid: "sts-test-kid" })
      .setIssuer(GATEWAY_ISSUER)
      .setAudience(options.audience ?? "ragbot")
      .setSubject(options.subject ?? "access-user-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const authGatewayFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${GATEWAY_ISSUER}/.well-known/jwks.json`) {
      return Response.json({ keys: [jwk] });
    }
    if (url === `${GATEWAY_ISSUER}/api/discovery?view=bootstrap`) {
      return Response.json({
        endpoints: discovery.endpoints,
        oidc: {
          issuer: discovery.oidc.issuer,
          client_id: discovery.oidc.clientId,
          authorization_endpoint: discovery.oidc.authorizationEndpoint,
          token_endpoint: discovery.oidc.tokenEndpoint,
          jwks_endpoint: discovery.oidc.jwksEndpoint,
        },
      });
    }
    if (url === `${GATEWAY_ISSUER}/api/discovery`) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    }
    if (url.endsWith("/platform/gateway/v1/discovery")) {
      const headers = new Headers(init?.headers);
      if (input instanceof Request) {
        input.headers.forEach((value, key) => headers.set(key, value));
      }
      if (!headers.get("authorization")) {
        return new Response("unauthenticated", { status: 401 });
      }
      return Response.json({ data: discovery });
    }
    if (url === `${GATEWAY_ISSUER}/oauth/token`) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const audience = body.get("audience") ?? "ragbot";
      const requestedScopes =
        (body.get("scope") ?? "").trim() ? (body.get("scope") ?? "").trim().split(/\s+/) : [`${audience}/*`];
      let subject = TEST_SERVICE_CLIENT_ID;
      let act: string | undefined;
      if (body.get("subject_token_type") === TOKEN_TYPE_SERVICE_CREDENTIAL) {
        subject = TEST_SERVICE_CLIENT_ID;
      } else if (body.get("subject_token")) {
        subject = jwtSubject(body.get("subject_token") ?? "");
      }
      if (body.get("actor_token")) {
        act = (body.get("actor_token") ?? "").split(":")[0];
      }
      const accessToken = await signToken({
        audience,
        subject,
        kind: subject === TEST_SERVICE_CLIENT_ID ? "service" : "user",
        scope: requestedScopes.join(" "),
        act,
      });
      return Response.json({
        access_token: accessToken,
        expires_in: 300,
        scope: requestedScopes.join(" "),
      });
    }
    return new Response("{}", { status: 200 });
  };

  const createAigatewayEnv = (options: {
    complete?: CompleteHandler;
    stream?: StreamHandler;
  } = {}) => {
    const completeCalls: AiCompleteRequest[] = [];
    let completeIndex = 0;

    const aigatewayFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body = await readJsonBody(init);
      const request: AiCompleteRequest = {
        model: String(body.model ?? ""),
        messages: (body.messages as AiCompleteRequest["messages"]) ?? [],
        maxTokens: body.maxTokens as number | undefined,
        temperature: body.temperature as number | undefined,
      };

      if (url.pathname.endsWith("/chat/completions/stream")) {
        const stream = options.stream?.() ?? {
          deltas: ["Hel", "lo"],
          final: { content: "Hello", model: request.model },
        };
        const encoder = new TextEncoder();
        const responseStream = new ReadableStream({
          start(controller) {
            for (const delta of stream.deltas) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ delta, done: false })}\n`));
            }
            controller.enqueue(encoder.encode(`${JSON.stringify({
              delta: "",
              done: true,
              content: stream.final.content,
              model: stream.final.model ?? request.model,
              finishReason: "stop",
              durationMs: 1,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })}\n`));
            controller.close();
          },
        });
        return new Response(responseStream, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }

      completeCalls.push(request);
      const result =
        options.complete?.(request, completeIndex++) ??
        ({ content: "Short answer.", model: request.model } satisfies { content: string; model?: string });
      return Response.json({
        data: {
          content: result.content,
          model: result.model ?? request.model,
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          durationMs: 1,
        },
      });
    };

    return {
      completeCalls,
      env: {
        AUTH_GATEWAY_URL: GATEWAY_ISSUER,
        AUTH_GATEWAY: { fetch: authGatewayFetch },
        AIGATEWAY_ENDPOINT: "https://aigateway.test",
        AIGATEWAY: { fetch: aigatewayFetch },
        SERVICE_CLIENT_ID: TEST_SERVICE_CLIENT_ID,
        SERVICE_CLIENT_SECRET: TEST_SERVICE_CLIENT_SECRET,
      },
    };
  };

  return {
    signToken,
    authGatewayFetch,
    createAigatewayEnv,
  };
})();

export const { signToken, authGatewayFetch, createAigatewayEnv } = createAigatewayTestHarness;
