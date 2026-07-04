import { assert, test } from "vitest";

import { OPENAPI as ATTEST_OPENAPI } from "../../workers/applications/attest/api/middleware_client/src/openapi";
import { OPENAPI as DEV_PROXY_OPENAPI } from "../../workers/applications/dev-proxy/api/middleware_client/src/openapi";
import { OPENAPI as GATEWAY_OPENAPI } from "../../workers/applications/gateway/api/middleware_client/src/openapi";
import { OPENAPI as METADATA_OPENAPI } from "../../workers/applications/metadata/api/middleware_client/src/openapi";
import { OPENAPI as REGISTRY_OPENAPI } from "../../workers/applications/registry/api/middleware_client/src/openapi";
import { OPENAPI as WEBHOOKS_OPENAPI } from "../../workers/applications/webhooks/api/middleware_client/src/openapi";

test("generated application OpenAPI documents expose their route surfaces", () => {
  assert.equal(GATEWAY_OPENAPI.openapi, "3.1.0");
  assert.containsAllKeys(GATEWAY_OPENAPI.paths, ["/openapi.json", "/discord", "/gateway/health"]);

  assert.equal(METADATA_OPENAPI.openapi, "3.1.0");
  assert.containsAllKeys(METADATA_OPENAPI.paths, ["/openapi.json", "/graphql"]);

  assert.equal(ATTEST_OPENAPI.openapi, "3.1.0");
  assert.containsAllKeys(ATTEST_OPENAPI.paths, ["/openapi.json", "/github"]);

  assert.equal(REGISTRY_OPENAPI.openapi, "3.1.0");
  assert.containsAllKeys(REGISTRY_OPENAPI.paths, [
    "/openapi.json",
    "/api/auth/{path}",
    "/api/applications",
    "/api/applications/{id}",
  ]);

  assert.equal(WEBHOOKS_OPENAPI.openapi, "3.1.0");
  assert.containsAllKeys(WEBHOOKS_OPENAPI.paths, ["/openapi.json", "/{provider}/{id}"]);

  assert.equal(DEV_PROXY_OPENAPI.openapi, "3.1.0");
  assert.containsAllKeys(DEV_PROXY_OPENAPI.paths, ["/openapi.json", "/api/auth/{path}", "/api/command"]);
});
