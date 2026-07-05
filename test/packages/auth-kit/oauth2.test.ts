import { assert, test } from "vitest";

import { oauth2ClientGuard } from "@rag/auth-kit/oauth2";

const basic = (id: string, secret: string) =>
  new Request("https://x.test", { headers: { authorization: `Basic ${btoa(`${id}:${secret}`)}` } });

const env = { OAUTH2_CLIENTS: JSON.stringify({ "svc-a": "s3cret-a" }) } as never;

test("oauth2 client-credentials: valid client passes", async () => {
  const r = await oauth2ClientGuard.verify(basic("svc-a", "s3cret-a"), env);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.grant.clientId, "svc-a");
});

test("oauth2 client-credentials: wrong secret / unknown client / no header deny", async () => {
  assert.equal((await oauth2ClientGuard.verify(basic("svc-a", "wrong"), env)).ok, false);
  assert.equal((await oauth2ClientGuard.verify(basic("svc-b", "x"), env)).ok, false);
  assert.equal((await oauth2ClientGuard.verify(new Request("https://x.test"), env)).ok, false);
});

test("oauth2 client-credentials: empty registry denies all (fail closed)", async () => {
  assert.equal((await oauth2ClientGuard.verify(basic("svc-a", "s3cret-a"), {} as never)).ok, false);
});
