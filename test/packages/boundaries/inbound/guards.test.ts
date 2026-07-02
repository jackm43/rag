import { assert, test } from "vitest";
import nacl from "tweetnacl";

import { discordInteractionGuard } from "../../../../packages/boundaries/inbound/discord-interaction.ts";
import { operatorControlGuard } from "../../../../packages/boundaries/inbound/operator-control.ts";
import { createEnv, createSignedRequest } from "../../../helpers.ts";

const captureWarnings = () => {
  const original = console.warn;
  const lines: Array<Record<string, unknown>> = [];
  console.warn = (line: unknown) => {
    lines.push(JSON.parse(String(line)));
  };
  return { lines, restore: () => (console.warn = original) };
};

test("discord interaction guard grants a discord principal for a signed interaction", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest({ type: 1 }, keyPair.secretKey);

  const result = await discordInteractionGuard.verify(request, env);

  assert.ok(result.ok);
  assert.equal(result.grant.principal, "discord");
  assert.deepEqual(result.grant.interaction, { type: 1 });
});

test("discord interaction guard denies bad signatures with the boundary context shape", async () => {
  const warnings = captureWarnings();
  try {
    const validPair = nacl.sign.keyPair();
    const mismatchedPair = nacl.sign.keyPair();
    const env = createEnv(Buffer.from(validPair.publicKey).toString("hex"));
    const request = createSignedRequest({ type: 1 }, mismatchedPair.secretKey);

    const result = await discordInteractionGuard.verify(request, env);

    assert.ok(!result.ok);
    assert.equal(result.reason, "invalid_signature");
    assert.equal(result.response.status, 401);

    const denial = warnings.lines.find((line) => line.message === "ingress_denied");
    assert.ok(denial);
    assert.equal(denial.identity, "discord-interactions");
    assert.equal(denial.trustZone, "ingress-discord");
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.reason, "invalid_signature");
  } finally {
    warnings.restore();
  }
});

test("operator control guard denies missing config and wrong tokens with the boundary context shape", async () => {
  const warnings = captureWarnings();
  try {
    const unconfigured = await operatorControlGuard.verify(
      new Request("https://example.com/gateway/start", {
        method: "POST",
        headers: { authorization: "Bearer control-token" },
      }),
      createEnv("unused"),
    );
    assert.ok(!unconfigured.ok);
    assert.equal(unconfigured.reason, "control_token_unconfigured");
    assert.equal(unconfigured.response.status, 401);

    const env = createEnv("unused", { GATEWAY_CONTROL_TOKEN: "control-token" });
    const wrongToken = await operatorControlGuard.verify(
      new Request("https://example.com/gateway/start", {
        method: "POST",
        headers: { authorization: "Bearer bot-token" },
      }),
      env,
    );
    assert.ok(!wrongToken.ok);
    assert.equal(wrongToken.reason, "invalid_bearer_token");
    assert.equal(wrongToken.response.status, 401);

    const denials = warnings.lines.filter((line) => line.message === "ingress_denied");
    assert.equal(denials.length, 2);
    for (const denial of denials) {
      assert.equal(denial.identity, "gateway-control");
      assert.equal(denial.trustZone, "ingress-operator");
      assert.equal(denial.outcome, "denied");
    }

    const granted = await operatorControlGuard.verify(
      new Request("https://example.com/gateway/start", {
        method: "POST",
        headers: { authorization: "Bearer control-token" },
      }),
      env,
    );
    assert.ok(granted.ok);
    assert.equal(granted.grant.principal, "operator");
  } finally {
    warnings.restore();
  }
});
