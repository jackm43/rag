import test from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  ConnectorAuthError,
  connectorToken,
  verifyMintedToken,
  type ConnectorConfig,
  type Identity,
} from "../src/index.ts";

const issuer = "https://gw.minted.test";
const keys = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), alg: "ES256", kid: "test" };

const discovery = {
  applications: [
    { name: "chat", delegations: [{ audience: "aigateway", scopes: [] }] },
    { name: "aigateway", delegations: [{ audience: "ragbot", scopes: [] }] },
    { name: "ragbot", delegations: [] },
  ],
};

const signToken = (claims: {
  aud: string;
  sub: string;
  scopes?: string[];
  act?: unknown;
}): Promise<string> =>
  new SignJWT({
    scope: (claims.scopes ?? []).join(" "),
    ...(claims.act !== undefined ? { act: claims.act } : {}),
  })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);

// Mints whatever mintToken is set to; lets each test control what the
// "gateway" returns from the exchange while jwks and discovery stay fixed.
let mintToken: () => Promise<string> = () => signToken({ aud: "aigateway", sub: "nobody" });
let exchangeCalls = 0;

const bootstrapDiscovery = {
  endpoints: {
    token_exchange: `${issuer}/oauth/token`,
    token_revoke: `${issuer}/oauth/revoke`,
    introspect: `${issuer}/oauth/introspect`,
    discovery: `${issuer}/api/discovery`,
    jwks: `${issuer}/.well-known/jwks.json`,
  },
  oidc: {
    issuer: "https://access.test",
    client_id: "access-client",
    authorization_endpoint: "https://access.test/authorization",
    token_endpoint: "https://access.test/token",
    jwks_endpoint: "https://access.test/jwks",
  },
};

const gatewayFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${issuer}/.well-known/jwks.json`) {
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === `${issuer}/api/discovery?view=bootstrap`) {
    return new Response(JSON.stringify(bootstrapDiscovery), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === `${issuer}/api/discovery`) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
  }
  if (url === `${issuer}/idp.v1.DiscoveryService/Discover`) {
    return new Response(JSON.stringify(discovery), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === `${issuer}/oauth/token`) {
    exchangeCalls += 1;
    return new Response(
      JSON.stringify({ access_token: await mintToken(), expires_in: 300, scope: "" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
};

const verifierConfig = {
  issuer,
  audience: "aigateway",
  gatewayFetch,
  serviceCredential: { clientId: "svc_chat_abc", clientSecret: "secret" },
};

test("verifyMintedToken accepts a gateway-signed token with a delegated chain", async () => {
  const token = await signToken({
    aud: "aigateway",
    sub: "user@example.com",
    scopes: ["aigateway/ChatService.Complete"],
    act: { sub: "svc_chat_abc" },
  });
  const identity = await verifyMintedToken(token, verifierConfig, "user@example.com");
  assert.ok(identity);
  assert.equal(identity.subject, "user@example.com");
  assert.deepEqual(identity.actorChain, ["svc_chat_abc"]);
});

test("verifyMintedToken rejects a token minted for another audience", async () => {
  const token = await signToken({
    aud: "ragbot",
    sub: "user@example.com",
    act: { sub: "svc_chat_abc" },
  });
  assert.equal(await verifyMintedToken(token, verifierConfig), null);
});

test("verifyMintedToken rejects a chain outside the delegation graph", async () => {
  const token = await signToken({
    aud: "aigateway",
    sub: "user@example.com",
    act: { sub: "svc_rogue_abc" },
  });
  assert.equal(await verifyMintedToken(token, verifierConfig), null);
});

test("verifyMintedToken rejects a token naming a different subject", async () => {
  const token = await signToken({
    aud: "aigateway",
    sub: "user@example.com",
    act: { sub: "svc_chat_abc" },
  });
  assert.equal(await verifyMintedToken(token, verifierConfig, "other@example.com"), null);
});

const connector = (subjectToken: string): [ConnectorConfig, Identity] => [
  {
    application: "aigateway",
    endpoint: "https://aigateway.test",
    gatewayUrl: issuer,
    credential: { clientId: "svc_chat_abc", clientSecret: "secret" },
    gatewayFetch,
  },
  {
    kind: "user",
    subject: "user@example.com",
    email: "user@example.com",
    scopes: [],
    actorChain: [],
    subjectToken,
  },
];

test("connectorToken returns only fully verified minted tokens and caches them", async () => {
  let minted = "";
  mintToken = async () => {
    minted = await signToken({
      aud: "aigateway",
      sub: "user@example.com",
      act: { sub: "svc_chat_abc" },
    });
    return minted;
  };
  exchangeCalls = 0;
  const [config, identity] = connector("subject-token-1");

  const token = await connectorToken(config, identity);
  assert.equal(token, minted);
  assert.equal(exchangeCalls, 1);

  const cached = await connectorToken(config, identity);
  assert.equal(cached, token);
  assert.equal(exchangeCalls, 1);
});

test("connectorToken fails closed when the minted token does not verify", async () => {
  mintToken = () =>
    signToken({ aud: "aigateway", sub: "user@example.com", act: { sub: "svc_rogue_abc" } });
  const [config, identity] = connector("subject-token-2");
  await assert.rejects(connectorToken(config, identity), ConnectorAuthError);

  mintToken = () =>
    signToken({ aud: "aigateway", sub: "someone-else", act: { sub: "svc_chat_abc" } });
  const [config2, identity2] = connector("subject-token-3");
  await assert.rejects(connectorToken(config2, identity2), ConnectorAuthError);
});
