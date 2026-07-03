import { assert, test } from "vitest";

import {
  describeSecretsProviders,
  resolveSecretRef,
  secretsProvider,
} from "../../../packages/secrets/index.ts";

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

test("onepassword set writes the value back through Connect (replace vs add)", async () => {
  const env = {
    OP_CONNECT_HOST: "https://connect.example.com",
    OP_CONNECT_TOKEN: "op-token",
  } as never;

  // An existing field is patched by id with a `replace` op; the value is never
  // echoed back to the caller (set resolves void).
  const replace = captureFetch((url, init) => {
    if (url.includes("/v1/vaults?")) {
      return new Response(JSON.stringify([{ id: "vault-id", name: "Services" }]), { status: 200 });
    }
    if (url.includes("/items?")) {
      return new Response(JSON.stringify([{ id: "item-id", title: "ragbot" }]), { status: 200 });
    }
    if (init?.method === "PATCH") {
      return new Response(JSON.stringify({ id: "item-id" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ id: "item-id", fields: [{ id: "f1", label: "KEY", value: "old" }] }),
      { status: 200 },
    );
  });
  try {
    await secretsProvider(env, "onepassword").set?.("op://Services/ragbot/KEY", "new-secret");
    const patch = replace.calls.find((call) => call.init?.method === "PATCH");
    assert.ok(patch);
    const body = JSON.parse(String(patch.init?.body)) as Array<{ op: string; path: string }>;
    assert.equal(body[0].op, "replace");
    assert.equal(body[0].path, "/fields/f1/value");
  } finally {
    replace.restore();
  }

  // An absent field is appended with an `add` op carrying the ref's label.
  const add = captureFetch((url, init) => {
    if (url.includes("/v1/vaults?")) {
      return new Response(JSON.stringify([{ id: "vault-id" }]), { status: 200 });
    }
    if (url.includes("/items?")) {
      return new Response(JSON.stringify([{ id: "item-id" }]), { status: 200 });
    }
    if (init?.method === "PATCH") {
      return new Response(JSON.stringify({ id: "item-id" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "item-id", fields: [] }), { status: 200 });
  });
  try {
    await secretsProvider(env, "onepassword").set?.("op://Services/ragbot/NEW", "v");
    const patch = add.calls.find((call) => call.init?.method === "PATCH");
    const body = JSON.parse(String(patch?.init?.body)) as Array<{ op: string; value: { label: string } }>;
    assert.equal(body[0].op, "add");
    assert.equal(body[0].value.label, "NEW");
  } finally {
    add.restore();
  }

  // A vault/item that cannot be resolved throws — a runtime write does not
  // create the item, and it must not silently no-op.
  const unresolved = captureFetch(() => new Response(JSON.stringify([]), { status: 200 }));
  try {
    await secretsProvider(env, "onepassword")
      .set?.("op://Nope/Nope/KEY", "v")
      .then(
        () => assert.fail("expected a throw for an unresolved item"),
        () => undefined,
      );
  } finally {
    unresolved.restore();
  }
});

test("describeSecretsProviders reports per-backend runtime write capability", async () => {
  // Nothing configured: wrangler-env is always available (the default); the
  // remote/binding backends report unconfigured. Writability is a static
  // property of the backend, independent of whether it is configured.
  const bare = describeSecretsProviders({} as never);
  const byName = Object.fromEntries(bare.map((info) => [info.name, info]));
  assert.deepEqual(byName["wrangler-env"], {
    name: "wrangler-env",
    writable: false,
    configured: true,
  });
  assert.equal(byName["cloudflare-secret-store"].writable, false);
  assert.equal(byName["cloudflare-secret-store"].configured, false);
  assert.equal(byName["hashicorp-vault"].writable, true);
  assert.equal(byName["hashicorp-vault"].configured, false);
  assert.equal(byName["onepassword"].writable, true);
  assert.equal(byName["onepassword"].configured, false);

  // Configured Vault + 1Password report configured:true and writable:true.
  const configured = describeSecretsProviders({
    VAULT_ADDR: "https://vault.example.com",
    VAULT_TOKEN: "s.token",
    OP_CONNECT_HOST: "https://connect.example.com",
    OP_CONNECT_TOKEN: "op-token",
    SECRETS_STORE: { get: async () => null },
  } as never);
  const cfg = Object.fromEntries(configured.map((info) => [info.name, info]));
  assert.equal(cfg["hashicorp-vault"].configured, true);
  assert.equal(cfg["onepassword"].configured, true);
  // The Secrets Store binding is present but remains non-writable at runtime.
  assert.deepEqual(cfg["cloudflare-secret-store"], {
    name: "cloudflare-secret-store",
    writable: false,
    configured: true,
  });
});
