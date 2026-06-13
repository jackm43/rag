import test from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  createDpopProof,
  DPOP_HEADER,
  dpopThumbprint,
  generateDpopKey,
  requireSenderConstraint,
  verifyDpopProof,
  type Identity,
} from "../src/index.ts";

const target = { method: "POST", url: "https://gateway.example/oauth/token" };

test("dpop proof roundtrip verifies and binds to the key thumbprint", async () => {
  const key = await generateDpopKey();
  const proof = await createDpopProof(key, target);
  const headers = new Headers({ [DPOP_HEADER]: proof });

  const verified = await verifyDpopProof(headers, target);
  assert.ok(verified);
  assert.equal(verified.jkt, await dpopThumbprint(key));
});

test("dpop proof ath binds the proof to the presented access token", async () => {
  const key = await generateDpopKey();
  const token = "token-one";
  const proof = await createDpopProof(key, target, token);
  const headers = new Headers({ [DPOP_HEADER]: proof });

  assert.ok(await verifyDpopProof(headers, target, token));
  assert.equal(await verifyDpopProof(headers, target, "token-two"), null);
});

test("dpop proof is rejected for a different method or url", async () => {
  const key = await generateDpopKey();
  const headers = new Headers({ [DPOP_HEADER]: await createDpopProof(key, target) });

  assert.equal(await verifyDpopProof(headers, { ...target, method: "GET" }), null);
  assert.equal(
    await verifyDpopProof(headers, { ...target, url: "https://gateway.example/other" }),
    null,
  );
});

test("dpop proof with the wrong typ or a stale iat is rejected", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: false });
  const jwk = await exportJWK(publicKey);
  const wrongTyp = await new SignJWT({ htm: "POST", htu: target.url, jti: "x" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", jwk })
    .setIssuedAt()
    .sign(privateKey);
  assert.equal(await verifyDpopProof(new Headers({ [DPOP_HEADER]: wrongTyp }), target), null);

  const stale = await new SignJWT({ htm: "POST", htu: target.url, jti: "x" })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .sign(privateKey);
  assert.equal(await verifyDpopProof(new Headers({ [DPOP_HEADER]: stale }), target), null);
});

test("sender-constrained identities require a matching proof", async () => {
  const key = await generateDpopKey();
  const identity: Identity = {
    kind: "user",
    subject: "user-1",
    email: "user@example.com",
    scopes: ["internal"],
    actorChain: [],
    cnfJkt: await dpopThumbprint(key),
  };

  assert.equal(await requireSenderConstraint(identity, new Headers(), target), null);

  const token = "session-token";
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    [DPOP_HEADER]: await createDpopProof(key, target, token),
  });
  assert.deepEqual(await requireSenderConstraint(identity, headers, target), identity);

  const otherKey = await generateDpopKey();
  const wrongHeaders = new Headers({
    authorization: `Bearer ${token}`,
    [DPOP_HEADER]: await createDpopProof(otherKey, target, token),
  });
  assert.equal(await requireSenderConstraint(identity, wrongHeaders, target), null);

  const unconstrained: Identity = { ...identity, cnfJkt: null };
  assert.deepEqual(await requireSenderConstraint(unconstrained, new Headers(), target), unconstrained);
});
