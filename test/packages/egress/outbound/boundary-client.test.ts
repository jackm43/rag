import { assert, test } from "vitest";

import {
  createBoundaryClient,
  PolicyViolationError,
  type BoundaryPolicy,
} from "@rag/egress/outbound/boundary-client";
import { boundaryClients } from "@rag/egress/outbound/clients";
import { createEnv } from "../../../helpers";

const discordPolicy: BoundaryPolicy = {
  identity: "discord-rest",
  trustZone: "egress-discord",
  credential: { header: "authorization", value: "Bot bot-token" },
  allowedHosts: ["discord.com"],
  defaultTimeoutMs: 15_000,
};

const mediaPolicy: BoundaryPolicy = {
  identity: "media-download",
  trustZone: "egress-media",
  allowedHosts: "*",
  defaultTimeoutMs: 30_000,
  maxResponseBytes: 16,
  logPath: false,
};

const captureWarnings = () => {
  const original = console.warn;
  const lines: Array<Record<string, unknown>> = [];
  console.warn = (line: unknown) => {
    lines.push(JSON.parse(String(line)));
  };
  return { lines, restore: () => (console.warn = original) };
};

const captureFetch = (respond: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
};

test("boundary client rejects hosts outside the allowlist before any network I/O", async () => {
  const warnings = captureWarnings();
  const mocked = captureFetch(() => new Response("{}"));
  try {
    const client = createBoundaryClient(discordPolicy);
    const error = await client("https://attacker.example/api/v10/users/1?token=leak").then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof PolicyViolationError);
    assert.equal(error.reason, "host_not_allowed");
    assert.equal(error.identity, "discord-rest");
    assert.equal(error.trustZone, "egress-discord");
    assert.equal(mocked.calls.length, 0);

    const denial = warnings.lines.find((line) => line.message === "egress_denied");
    assert.ok(denial);
    assert.equal(denial.identity, "discord-rest");
    assert.equal(denial.trustZone, "egress-discord");
    assert.equal(denial.method, "GET");
    assert.equal(denial.host, "attacker.example");
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.path, "/api/v10/users/1");
    assert.equal(JSON.stringify(denial).includes("token=leak"), false);
  } finally {
    mocked.restore();
    warnings.restore();
  }
});

test("boundary client rejects non-https URLs before any network I/O", async () => {
  const warnings = captureWarnings();
  const mocked = captureFetch(() => new Response("{}"));
  try {
    const client = createBoundaryClient(discordPolicy);
    const error = await client("http://discord.com/api/v10/users/1", { method: "POST" }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof PolicyViolationError);
    assert.equal(error.reason, "insecure_scheme");
    assert.equal(mocked.calls.length, 0);

    const denial = warnings.lines.find((line) => line.message === "egress_denied");
    assert.ok(denial);
    assert.equal(denial.method, "POST");
    assert.equal(denial.outcome, "denied");
  } finally {
    mocked.restore();
    warnings.restore();
  }
});

test("boundary client attaches the policy credential and preserves caller headers", async () => {
  const mocked = captureFetch(() => new Response("{}"));
  try {
    const client = createBoundaryClient(discordPolicy);
    const response = await client("https://discord.com/api/v10/channels/1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    assert.equal(response.status, 200);
    assert.equal(mocked.calls.length, 1);
    assert.deepEqual(mocked.calls[0].init?.headers, {
      "content-type": "application/json",
      authorization: "Bot bot-token",
    });
  } finally {
    mocked.restore();
  }
});

test("boundary client applies a default timeout signal only when the caller passed none", async () => {
  const mocked = captureFetch(() => new Response("{}"));
  try {
    const client = createBoundaryClient(discordPolicy);

    await client("https://discord.com/api/v10/users/1");
    assert.ok(mocked.calls[0].init?.signal instanceof AbortSignal);

    const callerSignal = AbortSignal.timeout(1_000);
    await client("https://discord.com/api/v10/users/1", { signal: callerSignal });
    assert.equal(mocked.calls[1].init?.signal, callerSignal);
  } finally {
    mocked.restore();
  }
});

test("boundary client denies responses whose content-length exceeds the size cap", async () => {
  const warnings = captureWarnings();
  const mocked = captureFetch(
    () => new Response("x", { headers: { "content-length": "17" } }),
  );
  try {
    const client = createBoundaryClient(mediaPolicy);
    const error = await client("https://cdn.example/audio.mp3?sig=secret").then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof PolicyViolationError);
    assert.equal(error.reason, "response_too_large");

    const denial = warnings.lines.find((line) => line.message === "egress_denied");
    assert.ok(denial);
    assert.equal(denial.host, "cdn.example");
    assert.equal(denial.path, undefined);
    assert.equal(JSON.stringify(denial).includes("sig=secret"), false);
  } finally {
    mocked.restore();
    warnings.restore();
  }
});

test("boundary client rejects buffered bodies that exceed the size cap without a content-length", async () => {
  const warnings = captureWarnings();
  const mocked = captureFetch(() => new Response(new Uint8Array(17)));
  try {
    const client = createBoundaryClient(mediaPolicy);
    const response = await client("https://cdn.example/audio.mp3");
    const error = await response.arrayBuffer().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof PolicyViolationError);
    assert.equal(error.reason, "response_too_large");
    assert.ok(warnings.lines.some((line) => line.message === "egress_denied"));
  } finally {
    mocked.restore();
    warnings.restore();
  }
});

test("boundary client passes through bodies within the size cap", async () => {
  const mocked = captureFetch(
    () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
  );
  try {
    const client = createBoundaryClient(mediaPolicy);
    const response = await client("https://cdn.example/audio.mp3");

    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  } finally {
    mocked.restore();
  }
});

test("boundary client logs http errors with the request context and returns the response", async () => {
  const warnings = captureWarnings();
  const mocked = captureFetch(() => new Response("nope", { status: 503 }));
  try {
    const client = createBoundaryClient(discordPolicy);
    const response = await client("https://discord.com/api/v10/channels/1?limit=5");

    assert.equal(response.status, 503);
    const failure = warnings.lines.find((line) => line.message === "egress_request_failed");
    assert.ok(failure);
    assert.equal(failure.identity, "discord-rest");
    assert.equal(failure.outcome, "http_error");
    assert.equal(failure.status, 503);
    assert.equal(failure.host, "discord.com");
    assert.equal(failure.path, "/api/v10/channels/1");
    assert.equal(JSON.stringify(failure).includes("limit=5"), false);
  } finally {
    mocked.restore();
    warnings.restore();
  }
});

test("discord-webhook egress failure logs carry no interaction token path segment", async () => {
  const warnings = captureWarnings();
  const mocked = captureFetch(() => new Response("nope", { status: 500 }));
  try {
    // Routed through the real in-process egress path: the discord-webhook
    // profile's logPath:false is what redacts the interaction-token path
    // segment, and the egress server logs egress_request_failed from the
    // profile identity when the upstream fetch fails.
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
    const response = await boundaryClients(env, "responder").discordWebhook(
      "https://discord.com/api/v10/webhooks/500000000000000001/secret-interaction-token/messages/@original",
      { method: "PATCH" },
    );

    assert.equal(response.status, 500);
    const failure = warnings.lines.find((line) => line.message === "egress_request_failed");
    assert.ok(failure);
    assert.equal(failure.identity, "discord-webhook");
    assert.equal(failure.outcome, "http_error");
    assert.equal(failure.host, "discord.com");
    assert.equal(failure.path, undefined);
    assert.equal(JSON.stringify(failure).includes("secret-interaction-token"), false);
  } finally {
    mocked.restore();
    warnings.restore();
  }
});

test("boundary client classifies fetch failures as network errors", async () => {
  const warnings = captureWarnings();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("connection refused");
  }) as typeof fetch;
  try {
    const client = createBoundaryClient(discordPolicy);
    const error = await client("https://discord.com/api/v10/users/1").then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof TypeError);
    const failure = warnings.lines.find((line) => line.message === "egress_request_failed");
    assert.ok(failure);
    assert.equal(failure.outcome, "network_error");
    assert.equal(failure.error, "connection refused");
  } finally {
    globalThis.fetch = original;
    warnings.restore();
  }
});

test("boundary client classifies timeout aborts as timeouts", async () => {
  const warnings = captureWarnings();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as typeof fetch;
  try {
    const client = createBoundaryClient(discordPolicy);
    const error = await client("https://discord.com/api/v10/users/1").then(
      () => null,
      (thrown: unknown) => thrown,
    );

    assert.ok(error instanceof DOMException);
    const failure = warnings.lines.find((line) => line.message === "egress_request_failed");
    assert.ok(failure);
    assert.equal(failure.outcome, "timeout");
  } finally {
    globalThis.fetch = original;
    warnings.restore();
  }
});

test("boundary client allows any https host when the allowlist is a wildcard", async () => {
  const mocked = captureFetch(() => new Response(new Uint8Array([1])));
  try {
    const client = createBoundaryClient(mediaPolicy);
    const response = await client("https://anything.example/file.bin");
    assert.equal(response.status, 200);
    assert.equal(mocked.calls.length, 1);
  } finally {
    mocked.restore();
  }
});
