import { assert, test } from "vitest";

import { resolveSecretRef, secretsProvider } from "../../../packages/secrets/index.ts";

// The secrets-provider module is the gate through which the broker resolves every
// credential. These tests prove two things: the factory selects the right backend
// by name (falling back to wrangler-env), and EVERY backend fails closed — an
// absent binding, an unconfigured/unreachable remote, or a non-2xx resolves to
// null so the connector op denies rather than surfacing a half-resolved secret.

const captureFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
};

test("wrangler-env resolves an env binding by name, and fails closed when absent", async () => {
  const env = { GITHUB_APP_PRIVATE_KEY: "pem-value" } as never;
  assert.equal(await secretsProvider(env, "wrangler-env").get("GITHUB_APP_PRIVATE_KEY"), "pem-value");
  assert.isNull(await secretsProvider(env, "wrangler-env").get("MISSING"));
});

test("the factory falls back to wrangler-env for an unknown provider name", async () => {
  const env = { SOME_SECRET: "v" } as never;
  // An unrecognised backend keeps today's behaviour (worker secrets) rather than
  // failing — the safe default.
  assert.equal(await secretsProvider(env, "does-not-exist").get("SOME_SECRET"), "v");
  assert.equal(await resolveSecretRef(env, { provider: "wrangler-env", ref: "SOME_SECRET" }), "v");
});

test("cloudflare-secret-store reads the binding, and fails closed on absence/error", async () => {
  const bound = {
    SECRETS_STORE: { get: async (name: string) => (name === "known" ? "store-value" : null) },
  } as never;
  assert.equal(await secretsProvider(bound, "cloudflare-secret-store").get("known"), "store-value");
  assert.isNull(await secretsProvider(bound, "cloudflare-secret-store").get("unknown"));
  // No binding at all -> null (fail closed), not a throw.
  assert.isNull(await secretsProvider({} as never, "cloudflare-secret-store").get("known"));
  // A throwing binding -> null (fail closed).
  const throwing = {
    SECRETS_STORE: {
      get: async () => {
        throw new Error("store down");
      },
    },
  } as never;
  assert.isNull(await secretsProvider(throwing, "cloudflare-secret-store").get("known"));
});

test("hashicorp-vault reads a KV v2 field, and fails closed when unconfigured or non-2xx", async () => {
  // Unconfigured backend -> null before any egress.
  assert.isNull(await secretsProvider({} as never, "hashicorp-vault").get("secret/ragbot#KEY"));

  const env = { VAULT_ADDR: "https://vault.example.com", VAULT_TOKEN: "s.token" } as never;
  const ok = captureFetch((url) => {
    // KV v2 inserts the /data/ segment on the wire.
    assert.include(url, "/v1/secret/data/ragbot");
    return new Response(JSON.stringify({ data: { data: { KEY: "vault-value" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    assert.equal(await secretsProvider(env, "hashicorp-vault").get("secret/ragbot#KEY"), "vault-value");
    // The token authenticated the read as an X-Vault-Token header.
    const headers = new Headers(ok.calls[0]?.init?.headers);
    assert.equal(headers.get("x-vault-token"), "s.token");
  } finally {
    ok.restore();
  }

  // A malformed reference (no #field) -> null.
  assert.isNull(await secretsProvider(env, "hashicorp-vault").get("secret/ragbot"));

  const notFound = captureFetch(() => new Response("no", { status: 404 }));
  try {
    assert.isNull(await secretsProvider(env, "hashicorp-vault").get("secret/ragbot#KEY"));
  } finally {
    notFound.restore();
  }
});

test("onepassword resolves an op:// reference via Connect, and fails closed", async () => {
  // Unconfigured backend -> null.
  assert.isNull(
    await secretsProvider({} as never, "onepassword").get("op://Services/ragbot/KEY"),
  );

  const env = {
    OP_CONNECT_HOST: "https://connect.example.com",
    OP_CONNECT_TOKEN: "op-token",
  } as never;
  const ok = captureFetch((url) => {
    if (url.includes("/v1/vaults?")) {
      return new Response(JSON.stringify([{ id: "vault-id", name: "Services" }]), { status: 200 });
    }
    if (url.endsWith("/items") || url.includes("/items?")) {
      return new Response(JSON.stringify([{ id: "item-id", title: "ragbot" }]), { status: 200 });
    }
    // The item fetch.
    return new Response(
      JSON.stringify({ id: "item-id", fields: [{ id: "f1", label: "KEY", value: "op-value" }] }),
      { status: 200 },
    );
  });
  try {
    assert.equal(await secretsProvider(env, "onepassword").get("op://Services/ragbot/KEY"), "op-value");
  } finally {
    ok.restore();
  }

  // A non-op:// reference -> null.
  assert.isNull(await secretsProvider(env, "onepassword").get("Services/ragbot/KEY"));

  // A missing field on the resolved item -> null (fail closed).
  const missingField = captureFetch((url) => {
    if (url.includes("/v1/vaults?")) {
      return new Response(JSON.stringify([{ id: "vault-id" }]), { status: 200 });
    }
    if (url.includes("/items?")) {
      return new Response(JSON.stringify([{ id: "item-id" }]), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "item-id", fields: [] }), { status: 200 });
  });
  try {
    assert.isNull(await secretsProvider(env, "onepassword").get("op://Services/ragbot/KEY"));
  } finally {
    missingField.restore();
  }
});
