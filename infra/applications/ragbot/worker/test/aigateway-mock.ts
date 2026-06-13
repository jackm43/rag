import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { TOKEN_TYPE_SERVICE_CREDENTIAL } from "../../../../sdk/ts/src";

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

const envelopConnectJSON = (payload: string, flags = 0) => {
  const body = new TextEncoder().encode(payload);
  const frame = new Uint8Array(5 + body.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, body.length, false);
  frame.set(body, 5);
  return frame;
};

const END_STREAM_FLAG = 0b00000010;

const readConnectJsonBody = async (init?: RequestInit): Promise<Record<string, unknown>> => {
  if (!init?.body) {
    return {};
  }
  let bytes: Uint8Array;
  if (typeof init.body === "string") {
    bytes = new TextEncoder().encode(init.body);
  } else if (init.body instanceof Uint8Array) {
    bytes = init.body;
  } else {
    bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
  }
  if (bytes.length >= 5) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, false);
    if (5 + length <= bytes.length) {
      return JSON.parse(new TextDecoder().decode(bytes.slice(5, 5 + length))) as Record<string, unknown>;
    }
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
};

export const createAigatewayTestHarness = await (async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "sts-test-kid";
  jwk.alg = "ES256";
  jwk.use = "sig";

  const discovery = {
    applications: [
      {
        name: "ragbot",
        delegations: [
          {
            audience: "aigateway",
            scopes: ["aigateway/ChatService.Complete", "aigateway/ChatService.StreamComplete"],
          },
        ],
      },
      { name: "aigateway", delegations: [{ audience: "ragbot", scopes: [] }] },
    ],
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
    if (url === `${GATEWAY_ISSUER}/api/discovery`) {
      return Response.json(discovery);
    }
    if (url === `${GATEWAY_ISSUER}/idp.v1.IdentityService/ExchangeToken`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        audience?: string;
        subjectToken?: string;
        subjectTokenType?: string;
        actorToken?: string;
        scopes?: string[];
      };
      const audience = body.audience ?? "ragbot";
      const requestedScopes =
        body.scopes && body.scopes.length > 0 ? body.scopes : [`${audience}/*`];
      let subject = TEST_SERVICE_CLIENT_ID;
      let act: string | undefined;
      if (body.subjectTokenType === TOKEN_TYPE_SERVICE_CREDENTIAL) {
        subject = TEST_SERVICE_CLIENT_ID;
      } else if (body.subjectToken) {
        subject = jwtSubject(body.subjectToken);
      }
      if (body.actorToken) {
        act = body.actorToken.split(":")[0];
      }
      const accessToken = await signToken({
        audience,
        subject,
        kind: subject === TEST_SERVICE_CLIENT_ID ? "service" : "user",
        scope: requestedScopes.join(" "),
        act,
      });
      return Response.json({
        accessToken,
        expiresIn: 300,
        scopes: requestedScopes,
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
      const body = (await readConnectJsonBody(init)) as AiCompleteRequest;

      if (url.pathname.endsWith("/StreamComplete")) {
        const stream = options.stream?.() ?? {
          deltas: ["Hel", "lo"],
          final: { content: "Hello", model: body.model },
        };
        const responseStream = new ReadableStream({
          start(controller) {
            for (const delta of stream.deltas) {
              controller.enqueue(envelopConnectJSON(JSON.stringify({ delta, done: false })));
            }
            controller.enqueue(
              envelopConnectJSON(
                JSON.stringify({
                  delta: "",
                  done: true,
                  content: stream.final.content,
                  model: stream.final.model ?? body.model,
                  finishReason: "stop",
                  durationMs: "1",
                  usage: { promptTokens: "0", completionTokens: "0", totalTokens: "0" },
                }),
              ),
            );
            controller.enqueue(envelopConnectJSON("{}", END_STREAM_FLAG));
            controller.close();
          },
        });
        return new Response(responseStream, {
          headers: {
            "content-type": "application/connect+json",
            "connect-content-encoding": "identity",
          },
        });
      }

      completeCalls.push(body);
      const result =
        options.complete?.(body, completeIndex++) ??
        ({ content: "Short answer.", model: body.model } satisfies { content: string; model?: string });
      return Response.json({
        content: result.content,
        model: result.model ?? body.model,
        finishReason: "stop",
        usage: { promptTokens: "0", completionTokens: "0", totalTokens: "0" },
        durationMs: "1",
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
