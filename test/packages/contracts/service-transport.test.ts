import { assert, test } from "vitest";

import {
  decodeManifestSnapshot,
  decodeServiceMessage,
  encodeManifestSnapshot,
  encodeReplyJobEnvelope,
  encodeServiceManifest,
  decodeServiceManifest,
  encodeServiceMessage,
} from "../../../packages/contracts/index.ts";

const envelope = () =>
  encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId: "200000000000000001", content: "hello" },
    { source: "worker" },
  );

test("a service message round-trips envelope bytes and token", () => {
  const inner = envelope();
  const bytes = encodeServiceMessage(inner, "a.b.c");
  const wire = decodeServiceMessage(bytes);
  assert.ok(wire);
  assert.deepEqual(wire.envelope, inner);
  assert.equal(wire.idToken, "a.b.c");
});

test("raw event-envelope bytes do not decode as a service message", () => {
  // The receive path falls back to treating unrecognized bytes as a bare
  // envelope (DLQ tolerance), so the wrapper decode must not claim them.
  assert.isNull(decodeServiceMessage(envelope()));
  assert.isNull(decodeServiceMessage(new Uint8Array([1, 2, 3, 4, 5])));
});

test("a manifest and a snapshot round-trip over the wire", () => {
  const manifest = {
    service: "workflows",
    zone: "application",
    targets: ["responder", "spend"],
    operations: ["ask"],
    scopes: [],
  };
  assert.deepEqual(decodeServiceManifest(encodeServiceManifest(manifest)), manifest);

  const snapshot = encodeManifestSnapshot([
    manifest,
    { service: "gateway", zone: "edge", targets: ["workflows"], operations: [], scopes: [] },
  ]);
  const decoded = decodeManifestSnapshot(snapshot);
  assert.ok(decoded);
  assert.equal(decoded.length, 2);
  assert.deepEqual(decoded[0], manifest);
  assert.equal(decoded[1].service, "gateway");
});
