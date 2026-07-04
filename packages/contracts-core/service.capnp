@0xa46a64eca8a0fa92;

# Transport-layer types for the service boundary. Everything that crosses a
# worker-to-worker hop (queue body, registry RPC) is defined here and code-
# generated, like the event envelopes in envelope.capnp. The identity token
# stays a compact JWS string (RFC 7515) — its JSON payload format is fixed by
# the standard — carried as Text beside the envelope bytes.
# Regenerate with `npm run contracts:build` (requires the native `capnp`
# compiler, e.g. `brew install capnp`).

struct ServiceMessage {
  # The body of every service queue hop: framed EventEnvelope bytes plus the
  # signed identity-context token bound to their hash.
  envelope @0 :Data;
  idToken @1 :Text;
}

struct ServiceManifest {
  # A service's self-declared position, registered with the ServiceRegistry.
  service @0 :Text;
  zone @1 :Text;
  targets @2 :List(Text);
  operations @3 :List(Text);
  scopes @4 :List(Text);
}

struct ManifestSnapshot {
  # The registry's full state, returned over the SERVICE_REGISTRY binding.
  manifests @0 :List(ServiceManifest);
}
